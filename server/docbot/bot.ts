// The conversation: who is writing, what they want, which business, then find, lock and send.

import { one, query } from "../db.js";
import type { Org } from "../orgs.js";
import type { Runtime } from "./runtime.js";
import { makeRuntime } from "./runtime.js";
import { expand, normalizeName, type DocType } from "./types.js";
import { parseWithRules, type Intent, type PeriodSpec } from "./intent.js";
import { aiKey, parseIntentWithAi } from "./llm.js";
import { describePeriod, fyRange, isoDate, monthRange, periodSlug, todayIn, type Range } from "./periods.js";
import { protectPdf } from "./pdf.js";
import type { Incoming, ListRow } from "./messenger.js";

// ------------------------------------------------------------------ types

interface Contact { id: number; phone: string; name: string | null }
interface Ident { id: number; kind: string; value: string; label: string | null }
interface Entity { id: number; name: string; entity_type: string; key_date: string | null; requires_approval: boolean; ids: Ident[] }
interface Target { entityId: number; identifierId: number | null; label: string; sub?: string }
interface DocRow {
  id: number; storage: string; file_id: string; doc_type: string;
  period_start: string | null; period_end: string | null; password_rule: string | null; identifier_id: number | null;
}
interface Ctx { rt: Runtime; phone: string; contact: Contact; entities: Entity[] }
interface Missing { type: DocType; range: Range | null }

const SESSION_MINUTES = 10;
const sessionKey = (rt: Runtime, phone: string) => (rt.simulated ? `sim:${phone}` : phone);

// ------------------------------------------------------------------ entry point

export async function handleIncoming(rt: Runtime, msg: Incoming) {
  const orgId = rt.org.id;
  const fresh = await one(
    `INSERT INTO processed_messages (org_id, wa_message_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING wa_message_id`,
    [orgId, msg.id]);
  if (!fresh) return; // WhatsApp retried a webhook we already handled

  const contact = await one<Contact>(`SELECT id, phone, name FROM contacts WHERE org_id=$1 AND phone=$2 AND active`, [orgId, msg.from]);
  if (!contact) return unknownNumber(rt, msg);

  if (!rt.simulated) await query(`UPDATE contacts SET last_inbound_at=now() WHERE id=$1`, [contact.id]);
  await rt.audit({ phone: msg.from, contactId: contact.id, direction: "in", event: "message",
    detail: { type: msg.type, text: msg.text?.slice(0, 500), replyId: msg.replyId } });

  const ctx: Ctx = { rt, phone: msg.from, contact, entities: await accessibleEntities(orgId, contact.id) };
  const s = rt.org.settings;
  if (!msg.text && !msg.replyId) return say(ctx, `I can only read typed messages 🙂 Please type what you need${s.examples[0] ? `, for example *${s.examples[0]}*` : ""}.`);
  if (!ctx.entities.length) return say(ctx, `Your number isn't linked to any customer file yet. Please contact ${s.businessName}${s.officeContact ? ` at ${s.officeContact}` : ""}.`);

  // Answer to "which one?" from the previous message
  const session = await getSession(rt, ctx.phone);
  if (session) {
    const idx = pickFromOptions(rt, msg, session.targets);
    await clearSession(rt, ctx.phone);
    if (idx !== undefined) return fulfil(ctx, session.intent, session.targets[idx], session.raw);
  }

  const text = msg.text ?? "";
  const intent = await parseIntent(ctx, text);
  switch (intent.action) {
    case "greeting": case "help": return say(ctx, helpText(ctx));
    case "list_documents": return say(ctx, await availableDocsText(ctx));
    case "other": return say(ctx, `Sorry, I didn't understand that. ${examples(rt)}`);
  }
  const { types } = expand(intent.docTypes, rt.types);
  if (!types.length) return say(ctx, `Which document do you need? ${examples(rt)}`);

  let targets = buildTargets(rt, types, ctx.entities);
  if (!targets.length) {
    const kind = rt.org.settings.identifierKinds.find((k) => k.key === types[0].identifierKind)?.label ?? "registration";
    return say(ctx, `I don't have a ${kind} linked to your number. Please contact ${s.businessName}.`);
  }
  const hinted = matchTargets(intent.entityHint || text, targets);
  if (hinted.length) targets = hinted;
  if (targets.length === 1) return fulfil(ctx, intent, targets[0], text);

  await saveSession(rt, ctx.phone, { intent, targets, raw: text });
  const kindLabel = targets[0].identifierId
    ? rt.org.settings.identifierKinds.find((k) => k.key === types[0].identifierKind)?.label ?? "registration" : "file";
  await rt.messenger.sendList(ctx.phone,
    `You have ${targets.length} ${kindLabel}s with us. Which one do you need?\n\n` +
      targets.map((t, i) => `${i + 1}. ${t.label}`).join("\n") + "\n\n(Tap below or reply with the number)",
    "Choose",
    targets.slice(0, 10).map((t, i): ListRow => ({ id: `pick:${i}`, title: t.label, description: t.sub })));
  await rt.audit({ phone: ctx.phone, contactId: ctx.contact.id, direction: "out", event: "asked_which" });
}

// ------------------------------------------------------------------ identify & understand

async function unknownNumber(rt: Runtime, msg: Incoming) {
  const s = rt.org.settings;
  const recent = await one(
    `SELECT 1 FROM audit_log WHERE org_id=$1 AND phone=$2 AND event='unknown_number' AND simulated=$3 AND at > now() - interval '24 hours'`,
    [rt.org.id, msg.from, rt.simulated]);
  await rt.audit({ phone: msg.from, direction: "in", event: "unknown_number", detail: { text: msg.text?.slice(0, 200), name: msg.name } });
  if (recent) return; // at most one reply a day, so the number can't be used to probe
  await rt.messenger.sendText(msg.from,
    `Namaste 🙏 This number isn't registered with ${s.businessName}. Please contact the office${s.officeContact ? ` at ${s.officeContact}` : ""} to get access.`);
}

async function accessibleEntities(orgId: string, contactId: number): Promise<Entity[]> {
  const rows = await query<Omit<Entity, "ids"> & { ids: Ident[] | null }>(
    `SELECT e.id, e.name, e.entity_type, e.key_date, e.requires_approval,
            COALESCE(json_agg(json_build_object('id', i.id, 'kind', i.kind, 'value', i.value, 'label', i.label)
                     ORDER BY i.kind, i.value) FILTER (WHERE i.id IS NOT NULL), '[]') AS ids
       FROM contact_entities ce
       JOIN entities e ON e.id=ce.entity_id AND e.active AND e.org_id=$1
       LEFT JOIN identifiers i ON i.entity_id=e.id AND i.active
      WHERE ce.contact_id=$2
      GROUP BY e.id ORDER BY e.name`, [orgId, contactId]);
  return rows.map((r) => ({ ...r, ids: r.ids ?? [] }));
}

async function parseIntent(ctx: Ctx, text: string): Promise<Intent> {
  const { rt } = ctx;
  const s = rt.org.settings;
  const today = todayIn(s.timezone, rt.now);
  const key = aiKey(s, rt.org.secrets);
  if (key) {
    try {
      const names = ctx.entities.flatMap((e) => [e.name, ...e.ids.map((i) => i.label).filter(Boolean) as string[]]);
      return await parseIntentWithAi(key, text, [...new Set(names)], today, rt.types, s);
    } catch (e) {
      console.error("[bot] AI parse failed, using rules:", (e as Error).message);
    }
  }
  return parseWithRules(text, today, rt.types, rt.style);
}

function buildTargets(rt: Runtime, types: DocType[], entities: Entity[]): Target[] {
  const kinds = new Set(types.map((t) => t.identifierKind));
  const kind = kinds.size === 1 ? [...kinds][0] : null;
  const spec = kind ? rt.org.settings.identifierKinds.find((k) => k.key === kind) : undefined;
  if (kind && spec?.selectable) {
    return entities.flatMap((e) => e.ids.filter((i) => i.kind === kind)
      .map((i) => ({ entityId: e.id, identifierId: i.id, label: i.label || e.name, sub: i.value })));
  }
  const primary = rt.org.settings.identifierKinds.find((k) => k.primary);
  return entities.map((e) => {
    const p = primary && e.ids.find((i) => i.kind === primary.key);
    return { entityId: e.id, identifierId: null, label: e.name, sub: p ? `${primary!.label} ending ${p.value.slice(-4)}` : undefined };
  });
}

const STOP = new Set(["pvt", "private", "ltd", "limited", "llp", "the", "and", "for", "send", "please", "my", "mera", "meri"]);
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));

/** Targets named in the message: by ID number, exact name, full name, or the word that tells them apart. */
function matchTargets(hint: string, targets: Target[]): Target[] {
  const upper = hint.toUpperCase();
  const byCode = targets.filter((t) => t.identifierId && t.sub && upper.includes(t.sub.toUpperCase()));
  if (byCode.length) return byCode;
  const h = normalizeName(hint);
  if (!h) return [];
  const exact = targets.filter((t) => normalizeName(t.label) === h);
  if (exact.length) return exact;
  const said = words(hint);
  const labelWords = targets.map((t) => words(t.label));
  const full = labelWords.map((l) => (l.size && [...l].every((w) => said.has(w)) ? l.size : 0));
  const longest = Math.max(0, ...full);
  if (longest) return targets.filter((_, i) => full[i] === longest);
  const everywhere = [...(labelWords[0] ?? [])].filter((w) => labelWords.every((l) => l.has(w)));
  const scores = labelWords.map((l) => [...l].filter((w) => !everywhere.includes(w) && said.has(w)).length);
  const best = Math.max(0, ...scores);
  return best ? targets.filter((_, i) => scores[i] === best) : [];
}

function pickFromOptions(rt: Runtime, msg: Incoming, targets: Target[]) {
  const fromList = /^pick:(\d+)$/.exec(msg.replyId ?? "");
  if (fromList) return Number(fromList[1]) < targets.length ? Number(fromList[1]) : undefined;
  const num = /^\s*(\d{1,2})\s*\.?\s*$/.exec(msg.text ?? "");
  if (num) {
    const i = Number(num[1]) - 1;
    return i >= 0 && i < targets.length ? i : undefined;
  }
  // A fresh request ("GSTR-3B for March") starts over instead of answering the question.
  if (parseWithRules(msg.text ?? "", new Date(), rt.types, rt.style).docTypes.length) return undefined;
  const byName = matchTargets(msg.text ?? "", targets);
  return byName.length === 1 ? targets.indexOf(byName[0]) : undefined;
}

// ------------------------------------------------------------------ find & send

function resolveRanges(rt: Runtime, periods: PeriodSpec[], today: Date): Range[] {
  const s = rt.org.settings;
  return periods.map((p) => {
    if (p.kind === "month") {
      const year = p.year ?? (p.month <= today.getMonth() + 1 ? today.getFullYear() : today.getFullYear() - 1);
      return monthRange(year, p.month);
    }
    if (p.kind === "ay") return fyRange(p.startYear - 1, rt.style);
    if (p.kind === "fy") return fyRange(p.startYear, rt.style);
    return s.showAssessmentYear && s.bareYearMeans === "ay" ? fyRange(p.startYear - 1, rt.style) : fyRange(p.startYear, rt.style);
  });
}

async function findDocs(rt: Runtime, t: Target, type: string, range: Range | null, limit: number): Promise<DocRow[]> {
  return query<DocRow>(
    `SELECT * FROM (
        SELECT DISTINCT ON (period_start, period_end)
               id, storage, file_id, doc_type, period_start, period_end, password_rule, identifier_id
          FROM documents
         WHERE org_id=$1 AND status='indexed' AND entity_id=$2 AND doc_type=$3
           AND ($4::int IS NULL OR identifier_id=$4)
           AND ($5::date IS NULL OR (period_start <= $6::date AND period_end >= $5::date))
         ORDER BY period_start, period_end, modified_at DESC
     ) t ORDER BY period_end DESC NULLS LAST LIMIT $7`,
    [rt.org.id, t.entityId, type, t.identifierId, range?.start ?? null, range?.end ?? null, limit]);
}

/** Months of a range that have already ended (later returns aren't due yet). */
function pastMonths(r: Range, today: Date): Range[] {
  const out: Range[] = [];
  let [y, m] = r.start.split("-").map(Number);
  const todayIso = isoDate(today);
  for (let guard = 0; guard < 24; guard++) {
    const mr = monthRange(y, m);
    if (mr.start > r.end || mr.end >= todayIso) break;
    out.push(mr);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}
const overlaps = (a: Range, d: DocRow) => !!d.period_start && d.period_start <= a.end && d.period_end! >= a.start;
const rangeOf = (d: { period_start: string | null; period_end: string | null }) =>
  d.period_start && d.period_end ? { start: d.period_start, end: d.period_end } : null;

async function fulfil(ctx: Ctx, intent: Intent, target: Target, raw: string) {
  const { rt } = ctx;
  const s = rt.org.settings;
  const entity = ctx.entities.find((e) => e.id === target.entityId)!;
  const today = todayIn(s.timezone, rt.now);
  const { types, optional } = expand(intent.docTypes, rt.types);
  const ranges = resolveRanges(rt, intent.periods, today);
  const cap = s.limits.maxDocsPerRequest;
  const found: DocRow[] = [];
  const missing: Missing[] = [];

  for (const type of types) {
    // An entity-level target asking for a registration-level type: use its only registration, if it has one.
    const t = type.identifierKind && !target.identifierId
      ? { ...target, identifierId: (() => { const own = entity.ids.filter((i) => i.kind === type.identifierKind); return own.length === 1 ? own[0].id : null; })() }
      : target;
    if (type.periodKind === "none") {
      const d = await findDocs(rt, t, type.key, null, 1);
      d.length ? found.push(...d) : missing.push({ type, range: null });
    } else if (!ranges.length) {
      const n = Math.min(intent.latestCount || 1, cap);
      const d = await findDocs(rt, t, type.key, null, n);
      found.push(...d.reverse());
      if (!d.length) missing.push({ type, range: null });
      else if (d.length < n && type.periodKind === "fy") {
        const oldest = Number(d[0].period_start!.slice(0, 4));
        for (let k = 1; k <= n - d.length; k++) missing.push({ type, range: fyRange(oldest - k, rt.style) });
      }
    } else {
      for (const r of ranges) {
        const d = (await findDocs(rt, t, type.key, r, cap)).reverse();
        found.push(...d);
        const multiMonth = r.end > monthRange(Number(r.start.slice(0, 4)), Number(r.start.slice(5, 7))).end;
        if (type.periodKind === "month" && multiMonth) {
          for (const mr of pastMonths(r, today)) if (!d.some((x) => overlaps(mr, x))) missing.push({ type, range: mr });
        } else if (!d.length) missing.push({ type, range: r });
      }
    }
  }

  const unique = [...new Map(found.map((d) => [d.id, d])).values()];
  const chase = missing.filter((m) => !optional.has(m.type.key));

  if (entity.requires_approval && unique.length) {
    for (const d of unique) await createPending(ctx, entity, target, d.doc_type, rangeOf(d), "approval", raw, d.id);
    await notifyStaff(rt, `🔐 Approval needed: ${ctx.contact.name ?? ctx.phone} asked for ${unique.length} document(s) of *${entity.name}*. Open the dashboard → Requests.`);
    await say(ctx, "Your request has been sent to the office for approval. You'll receive the documents here once approved.");
  } else if (unique.length) {
    await sendDocs(ctx, entity, target, unique, chase);
  }

  if (chase.length) {
    for (const m of chase) await createPending(ctx, entity, target, m.type.key, m.range, "missing", raw);
    const lines = chase.map((m) => `• ${docLine(rt, m)}`).join("\n");
    const many = chase.length > 1;
    await say(ctx, `${unique.length ? "I couldn't find these yet" : `I couldn't find this for *${target.label}* yet`}:\n${lines}\n\nI've asked the team — you'll receive ${many ? "them" : "it"} here as soon as ${many ? "they're" : "it's"} ready.`);
    await notifyStaff(rt, `📥 ${ctx.contact.name ?? ctx.phone} (${ctx.phone}) asked for:\n${lines}\nCustomer: *${target.label}*${target.sub ? ` (${target.sub})` : ""}`);
  }
}

async function sendDocs(ctx: Ctx, entity: Entity, target: Target, docs: DocRow[], missing: Missing[]) {
  const { rt } = ctx;
  const s = rt.org.settings;
  const sent1h = (await one<{ n: number }>(
    `SELECT count(*) AS n FROM audit_log WHERE org_id=$1 AND contact_id=$2 AND event='document_sent' AND simulated=$3 AND at > now() - interval '1 hour'`,
    [rt.org.id, ctx.contact.id, rt.simulated]))!.n;
  const allowed = Math.max(0, s.limits.maxDocsPerHour - sent1h);
  const toSend = docs.slice(0, Math.min(allowed, s.limits.maxDocsPerRequest));
  if (!toSend.length) return say(ctx, "You've reached the limit of documents per hour. Please try again a little later.");

  const rules = new Set<string>();
  let sent = 0;
  for (const d of toSend) {
    const rule = await deliver(rt, ctx.phone, ctx.contact.id, entity, target.label, d, false);
    if (rule) { sent++; rules.add(rule); }
    else {
      const type = rt.types.find((t) => t.key === d.doc_type);
      if (type) missing.push({ type, range: rangeOf(d) });
    }
  }
  if (sent) {
    const notes: string[] = [];
    if (docs.length > toSend.length) notes.push(`I've sent ${toSend.length} of ${docs.length}. Ask again in a while for the rest.`);
    const pw = passwordNote(rt, entity, rules);
    if (pw) notes.push(pw);
    if (notes.length) await say(ctx, notes.join("\n\n"));
  }
}

function primaryId(rt: Runtime, e: Entity) {
  const k = rt.org.settings.identifierKinds.find((x) => x.primary)?.key;
  return k ? e.ids.find((i) => i.kind === k)?.value : undefined;
}

export function pdfPassword(mode: string, id: string | undefined, keyDate: string | null) {
  if (mode === "none" || !id) return undefined;
  const base = id.toLowerCase().replace(/\s+/g, "");
  if (mode === "id_date" && keyDate) return base + keyDate.slice(8, 10) + keyDate.slice(5, 7) + keyDate.slice(0, 4);
  return base;
}

/** Reads, locks and sends one document. Returns the password rule used, or null if it couldn't be sent. */
async function deliver(rt: Runtime, phone: string, contactId: number, entity: Entity, label: string, d: DocRow, viaTemplate: boolean) {
  let file: Uint8Array;
  try {
    file = await rt.readFile(d);
  } catch (e) {
    console.error(`[bot] read failed for document ${d.id}:`, (e as Error).message);
    await query(`UPDATE documents SET status='missing', updated_at=now() WHERE id=$1`, [d.id]);
    return null;
  }
  let rule = d.password_rule ?? "none";
  if (!d.password_rule) {
    const pw = pdfPassword(rt.org.settings.pdfPassword.mode, primaryId(rt, entity), entity.key_date);
    if (pw) {
      try {
        file = await protectPdf(file, pw);
        rule = rt.org.settings.pdfPassword.mode === "id_date" && entity.key_date ? "ours_id_date" : "ours_id";
      } catch (e) {
        console.error(`[bot] could not lock document ${d.id}:`, (e as Error).message);
        await rt.audit({ phone, contactId, direction: "system", event: "lock_failed", documentId: d.id });
        return null; // never send unlocked when locking is on
      }
    }
  }
  const type = rt.types.find((t) => t.key === d.doc_type);
  const period = describePeriod({ start: d.period_start, end: d.period_end }, rt.style);
  const filename = fileName(rt, label, d);
  const caption = `*${label}*\n${type?.label ?? d.doc_type}${period ? ` — ${period}` : ""}`;
  if (viaTemplate) await rt.messenger.sendDocumentTemplate(phone, file, filename, `${type?.label ?? d.doc_type}${period ? ` ${period}` : ""}`);
  else await rt.messenger.sendDocument(phone, file, filename, caption);
  await rt.audit({ phone, contactId, direction: "out", event: "document_sent", documentId: d.id, detail: { filename, template: viaTemplate } });
  return rule;
}

function passwordNote(rt: Runtime, entity: Entity, rules: Set<string>) {
  const s = rt.org.settings;
  const idLabel = s.identifierKinds.find((k) => k.primary)?.label ?? "ID";
  const dateLabel = s.keyDateLabel.toLowerCase();
  const lines: string[] = [];
  if (rules.has("ours_id_date") || rules.has("id_date")) lines.push(`🔒 Password: your ${idLabel} in small letters + ${dateLabel} as DDMMYYYY.`);
  if (rules.has("ours_id") || rules.has("id")) lines.push(`🔒 Password: your ${idLabel} in small letters.`);
  if (rules.has("date")) lines.push(`🔒 One file opens with your ${dateLabel} as DDMMYYYY.`);
  if (rules.has("unknown")) lines.push("🔒 One file is locked by the issuing portal; please ask the office for its password.");
  return lines.join("\n");
}

function fileName(rt: Runtime, label: string, d: DocRow) {
  const who = label.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30);
  const when = periodSlug({ start: d.period_start, end: d.period_end }, rt.style);
  return `${who}_${d.doc_type}${when ? "_" + when : ""}.pdf`;
}

function docLine(rt: Runtime, m: Missing) {
  if (!m.range) return `${m.type.label}${m.type.periodKind === "none" ? "" : " (latest)"}`;
  return `${m.type.label} — ${describePeriod(m.range, rt.style)}`;
}

// ------------------------------------------------------------------ pending requests

async function createPending(ctx: Ctx, entity: Entity, t: Target, type: string, r: Range | null,
                             reason: "missing" | "approval", raw: string, documentId?: number) {
  const { rt } = ctx;
  const dup = await one(
    `SELECT id FROM pending_requests WHERE org_id=$1 AND status='open' AND contact_id=$2 AND entity_id=$3 AND doc_type=$4
       AND reason=$5 AND simulated=$6 AND period_start IS NOT DISTINCT FROM $7::date AND identifier_id IS NOT DISTINCT FROM $8::int
       AND document_id IS NOT DISTINCT FROM $9::int`,
    [rt.org.id, ctx.contact.id, entity.id, type, reason, rt.simulated, r?.start ?? null, t.identifierId, documentId ?? null]);
  if (dup) return;
  await query(
    `INSERT INTO pending_requests (org_id, contact_id, entity_id, identifier_id, doc_type, period_start, period_end, reason, document_id, raw_message, simulated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [rt.org.id, ctx.contact.id, entity.id, t.identifierId, type, r?.start ?? null, r?.end ?? null, reason, documentId ?? null, raw.slice(0, 500), rt.simulated]);
}

/**
 * A document was just indexed: send it to anyone who asked for it earlier. Outside WhatsApp's
 * 24-hour window this needs the approved template; without one the request stays open.
 */
export async function onDocumentIndexed(org: Org, documentId: number) {
  const reqs = await query<{ id: number; recent: boolean }>(
    `SELECT pr.id, (c.last_inbound_at > now() - interval '23 hours') AS recent
       FROM documents d
       JOIN pending_requests pr ON pr.org_id=d.org_id AND pr.status='open' AND pr.reason='missing' AND NOT pr.simulated
            AND pr.entity_id=d.entity_id AND pr.doc_type=d.doc_type
            AND (pr.identifier_id IS NULL OR pr.identifier_id=d.identifier_id)
            AND (pr.period_start IS NULL OR (d.period_start <= pr.period_end AND d.period_end >= pr.period_start))
       JOIN contacts c ON c.id=pr.contact_id AND c.active
       JOIN contact_entities ce ON ce.contact_id=c.id AND ce.entity_id=d.entity_id
      WHERE d.id=$1 AND d.org_id=$2 AND d.status='indexed'`, [documentId, org.id]);
  if (!reqs.length) return;
  const rt = await makeRuntime(org);
  for (const r of reqs) {
    try { await sendForRequest(rt, r.id, documentId, r.recent); }
    catch (e) { console.error(`[bot] delivering request ${r.id}:`, (e as Error).message); }
  }
}

async function sendForRequest(rt: Runtime, requestId: number, documentId: number, withinWindow: boolean) {
  const r = await one<{ contact_id: number; phone: string; entity_id: number; identifier_id: number | null }>(
    `SELECT pr.contact_id, c.phone, pr.entity_id, pr.identifier_id FROM pending_requests pr
       JOIN contacts c ON c.id=pr.contact_id WHERE pr.id=$1 AND pr.org_id=$2 AND pr.status='open'`, [requestId, rt.org.id]);
  if (!r) return { ok: false, reason: "Request is no longer open" };
  if (!withinWindow && !rt.org.settings.whatsapp.templateName) {
    await rt.audit({ phone: r.phone, contactId: r.contact_id, direction: "system", event: "delivery_blocked_24h", documentId, detail: { requestId } });
    return { ok: false, reason: "The customer's 24-hour WhatsApp window has closed and no template is set" };
  }
  const entity = (await accessibleEntities(rt.org.id, r.contact_id)).find((e) => e.id === r.entity_id);
  const doc = await one<DocRow>(`SELECT id, storage, file_id, doc_type, period_start, period_end, password_rule, identifier_id FROM documents WHERE id=$1 AND org_id=$2`, [documentId, rt.org.id]);
  if (!entity || !doc) return { ok: false, reason: "Customer no longer has access" };
  const ident = entity.ids.find((i) => i.id === (doc.identifier_id ?? r.identifier_id));
  const label = ident?.label || entity.name;
  const rule = await deliver(rt, r.phone, r.contact_id, entity, label, doc, !withinWindow);
  if (!rule) return { ok: false, reason: "The file couldn't be read or locked" };
  await query(`UPDATE pending_requests SET status='fulfilled', resolved_at=now(), document_id=$2 WHERE id=$1`, [requestId, documentId]);
  if (withinWindow) {
    const pw = passwordNote(rt, entity, new Set([rule]));
    await rt.messenger.sendText(r.phone, `Here's the document you asked for earlier ✅${pw ? `\n\n${pw}` : ""}`);
  }
  return { ok: true };
}

export async function approveRequest(org: Org, requestId: number) {
  const r = await one<{ document_id: number; recent: boolean; simulated: boolean }>(
    `SELECT pr.document_id, pr.simulated, (c.last_inbound_at > now() - interval '23 hours') AS recent
       FROM pending_requests pr JOIN contacts c ON c.id=pr.contact_id
      WHERE pr.id=$1 AND pr.org_id=$2 AND pr.status='open' AND pr.reason='approval'`, [requestId, org.id]);
  if (!r) return { ok: false, reason: "Request is no longer open" };
  if (r.simulated) {
    await query(`UPDATE pending_requests SET status='fulfilled', resolved_at=now() WHERE id=$1`, [requestId]);
    return { ok: true, note: "Test-chat request marked done (nothing sent on WhatsApp)" };
  }
  return sendForRequest(await makeRuntime(org), requestId, r.document_id, r.recent);
}

/** Sends a document that staff have just placed to a waiting request (dashboard action). */
export async function fulfilWith(org: Org, requestId: number, documentId: number) {
  const r = await one<{ recent: boolean }>(
    `SELECT (c.last_inbound_at > now() - interval '23 hours') AS recent FROM pending_requests pr JOIN contacts c ON c.id=pr.contact_id
      WHERE pr.id=$1 AND pr.org_id=$2 AND NOT pr.simulated`, [requestId, org.id]);
  if (!r) return { ok: false, reason: "Request not found" };
  return sendForRequest(await makeRuntime(org), requestId, documentId, r.recent);
}

// ------------------------------------------------------------------ messages

async function say(ctx: Ctx, text: string) {
  await ctx.rt.messenger.sendText(ctx.phone, text);
  await ctx.rt.audit({ phone: ctx.phone, contactId: ctx.contact.id, direction: "out", event: "message", detail: { text: text.slice(0, 500) } });
}

async function notifyStaff(rt: Runtime, text: string) {
  for (const p of rt.org.settings.staffPhones) {
    try { await rt.messenger.sendText(p, text); }
    catch (e) { console.error(`[bot] staff alert to ${p} failed:`, (e as Error).message); }
  }
}

function examples(rt: Runtime) {
  const ex = rt.org.settings.examples;
  return ex.length ? `You can ask things like:\n${ex.map((e) => `• *${e}*`).join("\n")}` : "Just tell me which document you need.";
}

function helpText(ctx: Ctx) {
  const s = ctx.rt.org.settings;
  const first = ctx.contact.name ? ` ${ctx.contact.name.split(" ")[0]}` : "";
  const intro = s.welcomeMessage.trim() ||
    `Namaste${first} 🙏 I'm the document assistant for *${s.businessName}*. I can send you your documents instantly, any time.`;
  return `${intro}\n\n${examples(ctx.rt)}\n\nFor anything else, please contact the office${s.officeContact ? ` at ${s.officeContact}` : ""}.`;
}

async function availableDocsText(ctx: Ctx) {
  const { rt } = ctx;
  const rows = await query<{ entity_id: number; doc_type: string; n: number; ps: string | null; pe: string | null }>(
    `SELECT DISTINCT ON (entity_id, doc_type) entity_id, doc_type, count(*) OVER (PARTITION BY entity_id, doc_type) AS n,
            period_start AS ps, period_end AS pe
       FROM documents WHERE org_id=$1 AND status='indexed' AND entity_id = ANY($2)
      ORDER BY entity_id, doc_type, period_end DESC NULLS LAST`, [rt.org.id, ctx.entities.map((e) => e.id)]);
  if (!rows.length) return "I don't have any of your documents on file yet. The office will add them soon.";
  const parts = ctx.entities.map((e) => {
    const mine = rows.filter((r) => r.entity_id === e.id);
    if (!mine.length) return "";
    return `*${e.name}*\n` + mine.map((r) => {
      const label = rt.types.find((t) => t.key === r.doc_type)?.label ?? r.doc_type;
      const latest = describePeriod({ start: r.ps, end: r.pe }, rt.style);
      return `• ${label}${latest ? ` — latest ${latest}` : ""}${r.n > 1 ? ` (${r.n} on file)` : ""}`;
    }).join("\n");
  }).filter(Boolean);
  return `Here's what I have:\n\n${parts.join("\n\n")}\n\nJust ask for what you need.`;
}

// ------------------------------------------------------------------ sessions

async function getSession(rt: Runtime, phone: string) {
  const r = await one<{ state: { intent: Intent; targets: Target[]; raw: string } }>(
    `SELECT state FROM chat_sessions WHERE org_id=$1 AND phone=$2 AND expires_at > now()`, [rt.org.id, sessionKey(rt, phone)]);
  return r?.state;
}
async function saveSession(rt: Runtime, phone: string, state: unknown) {
  await query(
    `INSERT INTO chat_sessions (org_id, phone, state, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)
     ON CONFLICT (org_id, phone) DO UPDATE SET state=EXCLUDED.state, expires_at=EXCLUDED.expires_at`,
    [rt.org.id, sessionKey(rt, phone), JSON.stringify(state), String(SESSION_MINUTES)]);
}
async function clearSession(rt: Runtime, phone: string) {
  await query(`DELETE FROM chat_sessions WHERE org_id=$1 AND phone=$2`, [rt.org.id, sessionKey(rt, phone)]);
}
