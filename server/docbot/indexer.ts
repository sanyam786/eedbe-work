// Recognises document files and keeps the documents table current.

import { one, query } from "../db.js";
import type { Org } from "../orgs.js";
import { classify, type Classification } from "./classifier.js";
import { classifyWithAi, aiKey } from "./llm.js";
import { extractText, looksLikePdf } from "./pdf.js";
import { uploads } from "./storage.js";
import { fileTypes, loadDirectory, normalizeName, type Directory } from "./types.js";
import { driveFor, makeRuntime, type Runtime } from "./runtime.js";
import { onDocumentIndexed } from "./bot.js";
import { RecordingMessenger } from "./messenger.js";

const ddmmyyyy = (iso: string) => iso.slice(8, 10) + iso.slice(5, 7) + iso.slice(0, 4);

/** Portal PDFs are locked with ID + date (ITR-V, AIS) or the date alone (26AS). Customers named in the path go first. */
function* passwordCandidates(filePath: string, dir: Directory) {
  const hinted = new Set<number>();
  const upper = filePath.toUpperCase();
  for (const s of dir.passwordSources) if (upper.includes(s.primaryId.toUpperCase())) hinted.add(s.entityId);
  for (const seg of filePath.split("/")) {
    const id = dir.entityByName.get(normalizeName(seg));
    if (id !== undefined) hinted.add(id);
  }
  const ordered = [...dir.passwordSources.filter((p) => hinted.has(p.entityId)), ...dir.passwordSources.filter((p) => !hinted.has(p.entityId))];
  for (const p of ordered) {
    if (p.keyDate) {
      yield p.primaryId.toLowerCase() + ddmmyyyy(p.keyDate);
      yield ddmmyyyy(p.keyDate);
    }
    yield p.primaryId.toLowerCase();
  }
}

export interface FileRef { storage: "upload" | "google_drive"; fileId: string; path: string; name: string; modifiedAt: Date; size?: number }

export async function indexBuffer(rt: Runtime, dir: Directory, file: FileRef, buf: Uint8Array, notify = true) {
  const org = rt.org;
  let c: Classification;
  let passwordRule: string | null = null;
  if (!looksLikePdf(buf)) {
    c = { classifiedBy: "rules", reviewReason: "Not a PDF file" };
  } else {
    const ex = await extractText(buf, () => passwordCandidates(file.path, dir));
    if (ex.locked) passwordRule = !ex.passwordUsed ? "unknown" : /^\d{8}$/.test(ex.passwordUsed) ? "date" : /\d{8}$/.test(ex.passwordUsed) ? "id_date" : "id";
    c = classify(ex.text, file.path, fileTypes(rt.types), dir, rt.style);
    if (!ex.opened && !c.docType) c = { ...c, reviewReason: "PDF is password-locked and no customer's ID/date opened it" };
    else if (c.reviewReason && ex.text.trim() && org.settings.ai.classifyDocuments) {
      const key = aiKey(org.settings, org.secrets);
      if (key) c = (await classifyWithAi(key, ex.text, file.path, fileTypes(rt.types), dir, rt.style, c)) ?? c;
    } else if (c.reviewReason && ex.opened && !ex.text.trim()) c = { ...c, reviewReason: `${c.reviewReason} (scanned PDF with no text)` };
  }
  const status = c.reviewReason ? "review" : "indexed";
  const row = await one<{ id: number }>(
    `INSERT INTO documents (org_id, storage, file_id, file_path, file_name, size_bytes, modified_at, entity_id, identifier_id,
        doc_type, period_start, period_end, password_rule, status, review_reason, classified_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (org_id, storage, file_id) DO UPDATE SET
        file_path=EXCLUDED.file_path, file_name=EXCLUDED.file_name, size_bytes=EXCLUDED.size_bytes, modified_at=EXCLUDED.modified_at,
        entity_id=EXCLUDED.entity_id, identifier_id=EXCLUDED.identifier_id, doc_type=EXCLUDED.doc_type,
        period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, password_rule=EXCLUDED.password_rule,
        status=EXCLUDED.status, review_reason=EXCLUDED.review_reason, classified_by=EXCLUDED.classified_by, updated_at=now()
     RETURNING id`,
    [org.id, file.storage, file.fileId, file.path, file.name, file.size ?? buf.length, file.modifiedAt, c.entityId ?? null,
     c.identifierId ?? null, c.docType ?? null, c.period?.start ?? null, c.period?.end ?? null, passwordRule, status,
     c.reviewReason ?? null, c.classifiedBy]);
  if (status === "indexed" && notify && org.features.whatsapp_docbot) await onDocumentIndexed(org, row!.id);
  return { id: row!.id, status, reviewReason: c.reviewReason };
}

/** A file uploaded in the dashboard: stored, recognised, and sent to anyone waiting for it. */
export async function ingestUpload(org: Org, buf: Uint8Array, relPath: string) {
  const cleanPath = relPath.split(/[\\/]+/).filter((s) => s && s !== "." && s !== "..").join("/") || "upload.pdf";
  const key = await uploads.put(org.id, buf);
  const rt = await makeRuntime(org, new RecordingMessenger());
  const dir = await loadDirectory(org.id, org.settings);
  return indexBuffer(rt, dir, {
    storage: "upload", fileId: key, path: cleanPath, name: cleanPath.split("/").pop()!, modifiedAt: new Date(), size: buf.length,
  }, buf);
}

/** Re-checks files in the review queue (e.g. after adding customers). */
export async function reclassifyReview(org: Org, limit = 200) {
  const rt = await makeRuntime(org, new RecordingMessenger());
  const dir = await loadDirectory(org.id, org.settings);
  const docs = await query(`SELECT id, storage, file_id, file_path, file_name, size_bytes, modified_at FROM documents
                             WHERE org_id=$1 AND status='review' ORDER BY updated_at LIMIT $2`, [org.id, limit]);
  let fixed = 0;
  for (const d of docs) {
    try {
      const buf = await rt.readFile(d);
      const r = await indexBuffer(rt, dir, { storage: d.storage, fileId: d.file_id, path: d.file_path, name: d.file_name,
        modifiedAt: d.modified_at, size: d.size_bytes }, buf);
      if (r.status === "indexed") fixed++;
    } catch (e) {
      console.error(`[indexer] recheck ${d.id}:`, (e as Error).message);
    }
  }
  return { checked: docs.length, fixed };
}

async function kv(orgId: string, key: string) {
  return (await one<{ value: string }>(`SELECT value FROM org_kv WHERE org_id=$1 AND key=$2`, [orgId, key]))?.value;
}
async function setKv(orgId: string, key: string, value: string) {
  await query(`INSERT INTO org_kv (org_id, key, value) VALUES ($1,$2,$3) ON CONFLICT (org_id, key) DO UPDATE SET value=EXCLUDED.value`, [orgId, key, value]);
}

/**
 * Indexes Drive files changed since the last sync, within a time budget (scheduled
 * functions get 30 seconds). Files are taken oldest-first, so the next run resumes.
 */
export async function syncDrive(org: Org, opts: { full?: boolean; budgetMs?: number } = {}) {
  const budget = opts.budgetMs ?? 20_000;
  const started = Date.now();
  const drive = driveFor(org);
  const last = opts.full ? undefined : await kv(org.id, "drive_synced_until");
  const files = await drive.listPdfs(last ? new Date(last) : null);
  const rt = await makeRuntime(org);
  const dir = await loadDirectory(org.id, org.settings);
  let indexed = 0, review = 0, skipped = 0, failed = 0, done = 0;

  for (const f of files) {
    if (Date.now() - started > budget) break;
    const existing = await one<{ modified_at: Date; status: string }>(
      `SELECT modified_at, status FROM documents WHERE org_id=$1 AND storage='google_drive' AND file_id=$2`, [org.id, f.id]);
    if (existing && existing.modified_at >= f.modifiedAt && existing.status !== "missing") {
      skipped++; done++;
      await setKv(org.id, "drive_synced_until", f.modifiedAt.toISOString());
      continue;
    }
    try {
      const buf = await drive.download(f.id);
      const r = await indexBuffer(rt, dir, { storage: "google_drive", fileId: f.id, path: f.path, name: f.name, modifiedAt: f.modifiedAt, size: f.size }, buf);
      r.status === "indexed" ? indexed++ : review++;
    } catch (e) {
      failed++;
      console.error(`[drive] ${f.path}:`, (e as Error).message);
    }
    done++;
    await setKv(org.id, "drive_synced_until", f.modifiedAt.toISOString());
  }

  const complete = done === files.length;
  if (complete && !last) {
    // Full listing finished: files no longer in Drive are marked missing.
    await query(`UPDATE documents SET status='missing', updated_at=now()
                  WHERE org_id=$1 AND storage='google_drive' AND status<>'missing' AND NOT (file_id = ANY($2))`,
      [org.id, files.map((f) => f.id)]);
  }
  await setKv(org.id, "drive_last_run", JSON.stringify({ at: new Date().toISOString(), indexed, review, skipped, failed, remaining: files.length - done }));
  return { indexed, review, skipped, failed, remaining: files.length - done };
}
