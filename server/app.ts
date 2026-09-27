// HTTP API for the dashboard and the WhatsApp webhook. Runs as one Netlify Function (see netlify/functions/api.mts)
// and as a plain Node server in development (scripts/dev-server.ts).

import { Hono, type Context } from "hono";
import { one, query } from "./db.js";
import { platform } from "./env.js";
import { randomToken, sha256, safeEqual } from "./crypto.js";
import {
  requireUser, requireRole, currentUser, startSession, endSession, hashPassword, checkPassword,
  validatePassword, normalizeEmail, loginLocked, recordLogin, type SessionUser, type Role,
} from "./auth.js";
import { createOrg, insertDocType, loadOrg, saveSecrets, saveSettings, secretSummary, setFeature, type Org } from "./orgs.js";
import { PRESETS, presetByKey } from "./presets.js";
import { FEATURES, featureByKey } from "./features.js";
import { handleIncoming, approveRequest, onDocumentIndexed } from "./docbot/bot.js";
import { makeRuntime, driveFor } from "./docbot/runtime.js";
import { RecordingMessenger, WhatsAppMessenger, parseWebhook, verifySignature } from "./docbot/messenger.js";
import { ingestUpload, reclassifyReview, syncDrive } from "./docbot/indexer.js";
import { importCustomersCsv, saveCustomer, normalizePhone } from "./docbot/customers.js";
import { uploads } from "./docbot/storage.js";
import { describePeriod } from "./docbot/periods.js";
import { yearStyle } from "./docbot/types.js";

type Env = { Variables: { user: SessionUser; role: Role; org: Org }; Bindings: { context?: { waitUntil?: (p: Promise<unknown>) => void } } };

export const app = new Hono<Env>().basePath("/api");

// ------------------------------------------------------------------ plumbing

class HttpError extends Error { constructor(public status: 400 | 403 | 404 | 409 | 413 | 429, message: string) { super(message); } }

app.onError((e: any, c) => {
  if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
  const isDb = typeof e?.code === "string" && /^[0-9A-Z]{5}$/.test(e.code);
  if (isDb || e instanceof TypeError) {
    console.error("[api]", e);
    return c.json({ error: "Something went wrong. Please try again." }, 500);
  }
  return c.json({ error: e?.message ?? "Request failed" }, 400);
});

// CSRF: browsers can't add a custom header cross-site without a CORS preflight we never allow.
app.use("*", async (c, next) => {
  const safe = ["GET", "HEAD", "OPTIONS"].includes(c.req.method) || c.req.path.startsWith("/api/webhooks/");
  if (!safe && c.req.header("x-requested-with") !== "eedbe") return c.json({ error: "Missing request header" }, 403);
  await next();
});

function background(c: Context<Env>, p: Promise<unknown>) {
  const guarded = p.catch((e) => console.error("[background]", e));
  const ctx = c.env?.context;
  if (ctx?.waitUntil) ctx.waitUntil(guarded);
}

const body = async (c: Context) => { try { return (await c.req.json()) ?? {}; } catch { return {}; } };
const int = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n)) throw new HttpError(400, "Bad id"); return n; };

// ------------------------------------------------------------------ public

app.get("/health", (c) => c.json({ ok: true }));

app.get("/config", (c) => c.json({
  signupNeedsCode: Boolean(platform.signupCode),
  signupsClosed: platform.signupsClosed,
  presets: PRESETS.map(({ key, label, description }) => ({ key, label, description })),
  features: FEATURES,
}));

app.post("/auth/signup", async (c) => {
  if (platform.signupsClosed) throw new HttpError(403, "Sign-ups are closed. Ask for an invite.");
  const b = await body(c);
  if (platform.signupCode && !safeEqual(String(b.code ?? ""), platform.signupCode)) throw new HttpError(403, "That sign-up code isn't right");
  const email = normalizeEmail(b.email);
  const name = String(b.name ?? "").trim();
  if (!name) throw new HttpError(400, "Enter your name");
  validatePassword(b.password);
  if (await one(`SELECT 1 FROM users WHERE email=$1`, [email])) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
  const u = await one<{ id: string }>(`INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id`,
    [email, name, await hashPassword(b.password)]);
  await startSession(c, u!.id);
  return c.json({ ok: true });
});

app.post("/auth/login", async (c) => {
  const b = await body(c);
  const email = normalizeEmail(b.email);
  if (await loginLocked(email)) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
  const u = await one<{ id: string; password_hash: string }>(`SELECT id, password_hash FROM users WHERE email=$1`, [email]);
  const ok = !!u && await checkPassword(String(b.password ?? ""), u.password_hash);
  await recordLogin(email, ok);
  if (!ok) throw new HttpError(400, "Email or password is incorrect");
  await startSession(c, u!.id);
  return c.json({ ok: true });
});

app.post("/auth/logout", (c) => { endSession(c); return c.json({ ok: true }); });

app.get("/auth/me", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ user: null, orgs: [] });
  const orgs = await query(
    `SELECT o.id, o.name, o.industry, m.role FROM memberships m JOIN orgs o ON o.id=m.org_id WHERE m.user_id=$1 ORDER BY o.created_at`, [user.id]);
  return c.json({ user, orgs });
});

app.get("/invites/:token", async (c) => {
  const inv = await one(`SELECT i.email, i.role, o.name AS org_name, (i.accepted_at IS NOT NULL) AS used, (i.expires_at < now()) AS expired,
                                (SELECT 1 FROM users u WHERE u.email=i.email) IS NOT NULL AS has_account
                           FROM invites i JOIN orgs o ON o.id=i.org_id WHERE i.token_hash=$1`, [sha256(c.req.param("token"))]);
  if (!inv) throw new HttpError(404, "This invite link isn't valid");
  return c.json(inv);
});

app.post("/invites/:token/accept", async (c) => {
  const inv = await one<{ id: string; org_id: string; email: string; role: Role }>(
    `SELECT id, org_id, email, role FROM invites WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at > now()`, [sha256(c.req.param("token"))]);
  if (!inv) throw new HttpError(404, "This invite has expired or was already used");
  const b = await body(c);
  let user = await currentUser(c);
  if (user && user.email !== inv.email) throw new HttpError(403, `This invite is for ${inv.email}. Sign out first.`);
  if (!user) {
    const existing = await one<{ id: string; password_hash: string }>(`SELECT id, password_hash FROM users WHERE email=$1`, [inv.email]);
    if (existing) {
      if (!(await checkPassword(String(b.password ?? ""), existing.password_hash))) throw new HttpError(400, "Password is incorrect");
      user = { id: existing.id, email: inv.email, name: "" };
    } else {
      const name = String(b.name ?? "").trim();
      if (!name) throw new HttpError(400, "Enter your name");
      validatePassword(b.password);
      const u = await one<{ id: string }>(`INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id`,
        [inv.email, name, await hashPassword(b.password)]);
      user = { id: u!.id, email: inv.email, name };
    }
    await startSession(c, user.id);
  }
  await query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,$3) ON CONFLICT (user_id, org_id) DO NOTHING`, [user.id, inv.org_id, inv.role]);
  await query(`UPDATE invites SET accepted_at=now() WHERE id=$1`, [inv.id]);
  return c.json({ ok: true, orgId: inv.org_id });
});

// ------------------------------------------------------------------ WhatsApp webhook (one URL per workspace)

app.get("/webhooks/whatsapp/:orgId", async (c) => {
  const org = await loadOrg(c.req.param("orgId"));
  const token = org?.secrets.waVerifyToken;
  if (c.req.query("hub.mode") === "subscribe" && token && safeEqual(c.req.query("hub.verify_token") ?? "", token)) {
    return c.text(c.req.query("hub.challenge") ?? "");
  }
  return c.text("Forbidden", 403);
});

app.post("/webhooks/whatsapp/:orgId", async (c) => {
  const org = await loadOrg(c.req.param("orgId"));
  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (!org || !verifySignature(org.secrets.waAppSecret, raw, c.req.header("x-hub-signature-256"))) return c.text("Unauthorized", 401);
  if (!org.features.whatsapp_docbot) return c.text("OK");
  let payload: any;
  try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.text("Bad JSON", 400); }
  const messages = parseWebhook(payload, org.settings.whatsapp.phoneNumberId);
  if (messages.length) {
    // Reply to Meta at once; the conversation continues in the background (up to the function's time limit).
    const work = (async () => {
      const rt = await makeRuntime(org);
      for (const m of messages) await handleIncoming(rt, m);
    })();
    const ctx = c.env?.context;
    if (ctx?.waitUntil) background(c, work);
    else await work.catch((e) => console.error("[webhook]", e)); // no waitUntil (local dev): finish before replying
  }
  return c.text("OK");
});

// ------------------------------------------------------------------ signed-in

app.use("/orgs/*", requireUser);
app.use("/orgs", requireUser);

app.post("/orgs", async (c) => {
  const b = await body(c);
  const name = String(b.name ?? "").trim();
  if (!name) throw new HttpError(400, "Enter your business name");
  const preset = presetByKey(String(b.industry ?? ""));
  if (!preset) throw new HttpError(400, "Choose a business type");
  const id = await createOrg(c.get("user").id, name, preset);
  return c.json({ id });
});

// Every /orgs/:orgId route: membership check, then the org is loaded once.
const org = (min: Role) => [requireRole(min), async (c: Context<Env>, next: () => Promise<void>) => {
  const o = await loadOrg(c.req.param("orgId")!);
  if (!o) throw new HttpError(404, "Workspace not found");
  c.set("org", o);
  await next();
}] as const;

const webhookUrl = (o: Org) => `${platform.publicUrl}/api/webhooks/whatsapp/${o.id}`;

app.get("/orgs/:orgId", ...org("staff"), async (c) => {
  const o = c.get("org");
  return c.json({
    id: o.id, name: o.name, industry: o.industry, role: c.get("role"), settings: o.settings,
    secrets: secretSummary(o.secrets), features: o.features, webhookUrl: webhookUrl(o),
    aiAvailable: Boolean(o.secrets.anthropicApiKey || platform.anthropicApiKey),
    platformAiKey: Boolean(platform.anthropicApiKey),
  });
});

app.patch("/orgs/:orgId/settings", ...org("admin"), async (c) => {
  const settings = await saveSettings(c.get("org"), await body(c));
  return c.json({ settings });
});

app.put("/orgs/:orgId/secrets", ...org("admin"), async (c) => {
  const s = await saveSecrets(c.get("org"), await body(c));
  return c.json({ secrets: secretSummary(s) });
});

app.post("/orgs/:orgId/features/:key", ...org("admin"), async (c) => {
  const f = featureByKey(c.req.param("key"));
  if (!f || f.status !== "available") throw new HttpError(404, "Unknown feature");
  const b = await body(c);
  await setFeature(c.get("org").id, f.key, b.enabled !== false);
  return c.json({ ok: true });
});

// ---- team

app.get("/orgs/:orgId/members", ...org("staff"), async (c) => {
  const members = await query(`SELECT u.id, u.name, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id=m.user_id
                                WHERE m.org_id=$1 ORDER BY m.created_at`, [c.get("org").id]);
  const invites = atLeastAdmin(c) ? await query(
    `SELECT id, email, role, expires_at, created_at FROM invites WHERE org_id=$1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    [c.get("org").id]) : [];
  return c.json({ members, invites });
});
const atLeastAdmin = (c: Context<Env>) => c.get("role") === "owner" || c.get("role") === "admin";

app.post("/orgs/:orgId/invites", ...org("admin"), async (c) => {
  const b = await body(c);
  const email = normalizeEmail(b.email);
  const role = b.role === "admin" ? "admin" : "staff";
  if (await one(`SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND u.email=$2`, [c.get("org").id, email])) {
    throw new HttpError(409, "That person is already in this workspace");
  }
  const token = randomToken();
  await query(`INSERT INTO invites (org_id, email, role, token_hash, expires_at) VALUES ($1,$2,$3,$4, now() + interval '7 days')`,
    [c.get("org").id, email, role, sha256(token)]);
  return c.json({ link: `${platform.publicUrl}/invite/${token}` });
});

app.delete("/orgs/:orgId/invites/:id", ...org("admin"), async (c) => {
  await query(`DELETE FROM invites WHERE id=$1 AND org_id=$2`, [c.req.param("id"), c.get("org").id]);
  return c.json({ ok: true });
});

app.patch("/orgs/:orgId/members/:userId", ...org("owner"), async (c) => {
  const role = (await body(c)).role;
  if (!["admin", "staff"].includes(role)) throw new HttpError(400, "Role must be admin or staff");
  if (c.req.param("userId") === c.get("user").id) throw new HttpError(400, "You can't change your own role");
  await query(`UPDATE memberships SET role=$3 WHERE org_id=$1 AND user_id=$2 AND role<>'owner'`, [c.get("org").id, c.req.param("userId"), role]);
  return c.json({ ok: true });
});

app.delete("/orgs/:orgId/members/:userId", ...org("admin"), async (c) => {
  const target = await one<{ role: Role }>(`SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2`, [c.get("org").id, c.req.param("userId")]);
  if (!target) throw new HttpError(404, "Not a member");
  if (target.role === "owner") throw new HttpError(403, "The owner can't be removed");
  await query(`DELETE FROM memberships WHERE org_id=$1 AND user_id=$2`, [c.get("org").id, c.req.param("userId")]);
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ WhatsApp document assistant

const D = "/orgs/:orgId/docbot";

app.get(`${D}/overview`, ...org("staff"), async (c) => {
  const o = c.get("org");
  const id = o.id;
  const [counts] = await query(`SELECT
      (SELECT count(*) FROM entities WHERE org_id=$1 AND active) AS customers,
      (SELECT count(*) FROM contacts WHERE org_id=$1 AND active) AS numbers,
      (SELECT count(*) FROM documents WHERE org_id=$1 AND status='indexed') AS documents,
      (SELECT count(*) FROM documents WHERE org_id=$1 AND status='review') AS review,
      (SELECT count(*) FROM pending_requests WHERE org_id=$1 AND status='open' AND reason='missing' AND NOT simulated) AS waiting,
      (SELECT count(*) FROM pending_requests WHERE org_id=$1 AND status='open' AND reason='approval' AND NOT simulated) AS approvals,
      (SELECT count(*) FROM doc_types WHERE org_id=$1 AND active AND bundle IS NULL) AS doc_types,
      (SELECT count(*) FROM audit_log WHERE org_id=$1 AND simulated) AS test_events,
      (SELECT count(*) FROM audit_log WHERE org_id=$1 AND NOT simulated AND direction='in') AS live_messages,
      (SELECT count(*) FROM audit_log WHERE org_id=$1 AND NOT simulated AND event='document_sent' AND at > now() - interval '7 days') AS sent_7d,
      (SELECT count(DISTINCT phone) FROM audit_log WHERE org_id=$1 AND NOT simulated AND direction='in' AND at > now() - interval '7 days') AS people_7d`, [id]);
  const daily = await query(
    `SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
            (SELECT count(*) FROM audit_log a WHERE a.org_id=$1 AND NOT a.simulated AND a.event='document_sent'
               AND (a.at AT TIME ZONE $2)::date = d::date) AS sent,
            (SELECT count(*) FROM audit_log a WHERE a.org_id=$1 AND NOT a.simulated AND a.direction='in'
               AND (a.at AT TIME ZONE $2)::date = d::date) AS messages
       FROM generate_series((now() AT TIME ZONE $2)::date - 13, (now() AT TIME ZONE $2)::date, interval '1 day') d
      ORDER BY d`, [id, o.settings.timezone]);
  const s = o.settings, sec = o.secrets;
  const whatsappReady = Boolean(s.whatsapp.phoneNumberId && sec.waAccessToken && sec.waAppSecret && sec.waVerifyToken);
  const storageReady = s.storage.driver === "upload" || Boolean(s.storage.driveId && sec.googleServiceAccount);
  const lastDrive = await one<{ value: string }>(`SELECT value FROM org_kv WHERE org_id=$1 AND key='drive_last_run'`, [id]);
  return c.json({
    counts, daily,
    setup: [
      { key: "enabled", label: "Turn on the WhatsApp Document Assistant", done: Boolean(o.features.whatsapp_docbot), to: "" },
      { key: "types", label: "Check the document types your customers ask for", done: counts.doc_types > 0, to: "whatsapp/setup/doc-types" },
      { key: "customers", label: "Add customers and their WhatsApp numbers", done: counts.customers > 0, to: "whatsapp/customers" },
      { key: "storage", label: s.storage.driver === "upload" ? "Upload documents (or connect Google Drive)" : "Connect Google Drive", done: storageReady && counts.documents > 0, to: counts.documents > 0 ? "whatsapp/setup/storage" : "whatsapp/documents" },
      { key: "test", label: "Try it in the test chat", done: counts.test_events > 0, to: "whatsapp/test-chat" },
      { key: "whatsapp", label: "Connect your WhatsApp number", done: whatsappReady, to: "whatsapp/setup/whatsapp" },
      { key: "live", label: "Receive the first real WhatsApp message", done: counts.live_messages > 0, to: "whatsapp/setup/whatsapp" },
    ],
    drive: lastDrive ? JSON.parse(lastDrive.value) : null,
  });
});

// ---- customers

app.get(`${D}/customers`, ...org("staff"), async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const rows = await query(
    `SELECT e.id, e.name, e.entity_type, e.key_date, e.requires_approval,
            COALESCE((SELECT json_agg(json_build_object('id', i.id, 'kind', i.kind, 'value', i.value, 'label', i.label) ORDER BY i.kind, i.value)
                        FROM identifiers i WHERE i.entity_id=e.id AND i.active), '[]') AS identifiers,
            COALESCE((SELECT json_agg(json_build_object('phone', ct.phone, 'name', ct.name) ORDER BY ct.phone)
                        FROM contact_entities ce JOIN contacts ct ON ct.id=ce.contact_id AND ct.active WHERE ce.entity_id=e.id), '[]') AS contacts,
            (SELECT count(*) FROM documents d WHERE d.entity_id=e.id AND d.status='indexed') AS documents
       FROM entities e
      WHERE e.org_id=$1 AND e.active
        AND ($2 = '' OR e.name ILIKE '%' || $2 || '%'
             OR EXISTS (SELECT 1 FROM identifiers i WHERE i.entity_id=e.id AND i.value ILIKE '%' || $2 || '%')
             OR EXISTS (SELECT 1 FROM contact_entities ce JOIN contacts ct ON ct.id=ce.contact_id WHERE ce.entity_id=e.id AND ct.phone LIKE '%' || $2 || '%'))
      ORDER BY e.name LIMIT 500`, [c.get("org").id, q]);
  return c.json({ customers: rows });
});

app.post(`${D}/customers`, ...org("staff"), async (c) => {
  const o = c.get("org");
  const id = await saveCustomer(o.id, o.settings, await body(c));
  background(c, reclassifyReview(o, 50));
  return c.json({ id });
});

app.put(`${D}/customers/:id`, ...org("staff"), async (c) => {
  const o = c.get("org");
  await saveCustomer(o.id, o.settings, await body(c), int(c.req.param("id")));
  return c.json({ ok: true });
});

app.delete(`${D}/customers/:id`, ...org("staff"), async (c) => {
  const id = int(c.req.param("id"));
  await query(`UPDATE entities SET active=FALSE WHERE id=$1 AND org_id=$2`, [id, c.get("org").id]);
  await query(`DELETE FROM contact_entities WHERE entity_id=$1`, [id]);
  return c.json({ ok: true });
});

app.post(`${D}/customers/import`, ...org("staff"), async (c) => {
  const o = c.get("org");
  const b = await body(c);
  if (typeof b.csv !== "string" || !b.csv.trim()) throw new HttpError(400, "Choose a CSV file");
  const r = await importCustomersCsv(o.id, o.settings, b.csv);
  background(c, reclassifyReview(o, 100));
  return c.json(r);
});

// ---- documents

app.get(`${D}/documents`, ...org("staff"), async (c) => {
  const o = c.get("org");
  const status = c.req.query("status") || "indexed";
  const q = (c.req.query("q") ?? "").trim();
  const page = Math.max(0, Number(c.req.query("page") ?? 0) || 0);
  const rows = await query(
    `SELECT d.id, d.storage, d.file_path, d.file_name, d.size_bytes, d.doc_type, d.period_start, d.period_end, d.status, d.review_reason,
            d.classified_by, d.password_rule, d.updated_at, d.entity_id, d.identifier_id, e.name AS customer, i.value AS identifier, i.label AS identifier_label,
            t.label AS type_label
       FROM documents d
       LEFT JOIN entities e ON e.id=d.entity_id
       LEFT JOIN identifiers i ON i.id=d.identifier_id
       LEFT JOIN doc_types t ON t.org_id=d.org_id AND t.key=d.doc_type
      WHERE d.org_id=$1 AND d.status=$2
        AND ($3 = '' OR d.file_path ILIKE '%' || $3 || '%' OR e.name ILIKE '%' || $3 || '%' OR d.doc_type ILIKE '%' || $3 || '%')
      ORDER BY ${status === "indexed" ? "e.name, d.doc_type, d.period_end DESC NULLS LAST" : "d.updated_at DESC"}
      LIMIT 100 OFFSET $4`, [o.id, status, q, page * 100]);
  const style = yearStyle(o.settings);
  return c.json({ documents: rows.map((r) => ({ ...r, period: describePeriod({ start: r.period_start, end: r.period_end }, style) })) });
});

app.post(`${D}/documents/upload`, ...org("staff"), async (c) => {
  const o = c.get("org");
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) throw new HttpError(400, "No file received");
  if (file.size > 4_400_000) throw new HttpError(413, "Files over 4 MB can't be uploaded here. Use Google Drive for large files.");
  const buf = new Uint8Array(await file.arrayBuffer());
  const r = await ingestUpload(o, buf, String(form.path || file.name));
  return c.json(r);
});

app.patch(`${D}/documents/:id`, ...org("staff"), async (c) => {
  const o = c.get("org");
  const id = int(c.req.param("id"));
  const b = await body(c);
  const type = await one(`SELECT key, period_kind, identifier_kind FROM doc_types WHERE org_id=$1 AND key=$2 AND bundle IS NULL`, [o.id, b.docType]);
  if (!type) throw new HttpError(400, "Choose a document type");
  const entity = await one(`SELECT id FROM entities WHERE id=$1 AND org_id=$2 AND active`, [b.entityId, o.id]);
  if (!entity) throw new HttpError(400, "Choose a customer");
  let identifierId: number | null = null;
  if (type.identifier_kind) {
    const ids = await query(`SELECT id FROM identifiers WHERE entity_id=$1 AND kind=$2 AND active`, [entity.id, type.identifier_kind]);
    identifierId = b.identifierId ? (ids.find((x) => x.id === Number(b.identifierId))?.id ?? null) : ids.length === 1 ? ids[0].id : null;
    if (!identifierId) throw new HttpError(400, `Choose which ${type.identifier_kind} this belongs to`);
  }
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const ps = type.period_kind === "none" ? null : b.periodStart, pe = type.period_kind === "none" ? null : b.periodEnd;
  if (type.period_kind !== "none" && (!date.test(ps ?? "") || !date.test(pe ?? "") || ps > pe)) throw new HttpError(400, "Choose the period");
  const r = await one(
    `UPDATE documents SET entity_id=$3, identifier_id=$4, doc_type=$5, period_start=$6, period_end=$7, status='indexed',
            review_reason=NULL, classified_by='staff', updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING id`,
    [id, o.id, entity.id, identifierId, type.key, ps, pe]);
  if (!r) throw new HttpError(404, "Document not found");
  if (o.features.whatsapp_docbot) await onDocumentIndexed(o, id);
  return c.json({ ok: true });
});

app.delete(`${D}/documents/:id`, ...org("staff"), async (c) => {
  const o = c.get("org");
  const d = await one(`DELETE FROM documents WHERE id=$1 AND org_id=$2 RETURNING storage, file_id`, [int(c.req.param("id")), o.id]);
  if (!d) throw new HttpError(404, "Document not found");
  if (d.storage === "upload") await uploads.delete(d.file_id).catch(() => {});
  return c.json({ ok: true });
});

app.get(`${D}/documents/:id/file`, ...org("staff"), async (c) => {
  const o = c.get("org");
  const d = await one(`SELECT storage, file_id, file_name FROM documents WHERE id=$1 AND org_id=$2`, [int(c.req.param("id")), o.id]);
  if (!d) throw new HttpError(404, "Document not found");
  const rt = await makeRuntime(o, new RecordingMessenger());
  const buf = await rt.readFile(d);
  return new Response(new Uint8Array(buf), { headers: {
    "content-type": "application/pdf",
    "content-disposition": `inline; filename="${String(d.file_name).replace(/[^\w.\- ]/g, "_")}"`,
    "cache-control": "private, no-store",
  } });
});

app.post(`${D}/documents/recheck`, ...org("staff"), async (c) => c.json(await reclassifyReview(c.get("org"), 100)));

app.post(`${D}/drive/sync`, ...org("admin"), async (c) => {
  const o = c.get("org");
  if (o.settings.storage.driver !== "google_drive") throw new HttpError(400, "Google Drive isn't the document storage");
  return c.json(await syncDrive(o, { full: Boolean((await body(c)).full), budgetMs: 40_000 }));
});

// ---- requests

app.get(`${D}/requests`, ...org("staff"), async (c) => {
  const o = c.get("org");
  const status = c.req.query("status") || "open";
  const rows = await query(
    `SELECT pr.id, pr.reason, pr.status, pr.doc_type, pr.period_start, pr.period_end, pr.raw_message, pr.created_at, pr.resolved_at,
            pr.simulated, pr.document_id, ct.phone, ct.name AS contact, e.name AS customer, e.id AS entity_id, i.value AS identifier,
            t.label AS type_label, (ct.last_inbound_at > now() - interval '23 hours') AS window_open
       FROM pending_requests pr JOIN contacts ct ON ct.id=pr.contact_id JOIN entities e ON e.id=pr.entity_id
       LEFT JOIN identifiers i ON i.id=pr.identifier_id
       LEFT JOIN doc_types t ON t.org_id=pr.org_id AND t.key=pr.doc_type
      WHERE pr.org_id=$1 AND pr.status=$2 ORDER BY pr.created_at DESC LIMIT 300`, [o.id, status]);
  const style = yearStyle(o.settings);
  return c.json({ requests: rows.map((r) => ({ ...r, period: describePeriod({ start: r.period_start, end: r.period_end }, style) || "latest" })) });
});

app.post(`${D}/requests/:id/approve`, ...org("staff"), async (c) => {
  const r = await approveRequest(c.get("org"), int(c.req.param("id")));
  if (!r.ok) throw new HttpError(409, (r as any).reason ?? "Couldn't send");
  return c.json(r);
});

app.post(`${D}/requests/:id/reject`, ...org("staff"), async (c) => {
  const o = c.get("org");
  const b = await body(c);
  const r = await one<{ phone: string; recent: boolean; simulated: boolean }>(
    `UPDATE pending_requests pr SET status='rejected', resolved_at=now() FROM contacts ct
      WHERE pr.id=$1 AND pr.org_id=$2 AND pr.status='open' AND ct.id=pr.contact_id
      RETURNING ct.phone, pr.simulated, (ct.last_inbound_at > now() - interval '23 hours') AS recent`, [int(c.req.param("id")), o.id]);
  if (!r) throw new HttpError(404, "Request not found");
  if (b.notify !== false && r.recent && !r.simulated) {
    const rt = await makeRuntime(o);
    await rt.messenger.sendText(r.phone, String(b.message || "The office will contact you about your request.")).catch(() => {});
  }
  return c.json({ ok: true });
});

// ---- activity

app.get(`${D}/activity`, ...org("staff"), async (c) => {
  const phone = c.req.query("phone") || null;
  const rows = await query(
    `SELECT a.id, a.at, a.phone, a.direction, a.event, a.document_id, a.simulated, a.detail, ct.name AS contact
       FROM audit_log a LEFT JOIN contacts ct ON ct.id=a.contact_id
      WHERE a.org_id=$1 AND ($2::text IS NULL OR a.phone=$2) AND ($3::boolean IS NULL OR a.simulated=$3)
      ORDER BY a.at DESC, a.id DESC LIMIT 200`,
    [c.get("org").id, phone, c.req.query("test") === "only" ? true : c.req.query("test") === "hide" ? false : null]);
  return c.json({ activity: rows });
});

// ---- document types

const PERIODS = ["none", "month", "fy"];
async function docTypeInput(o: Org, b: any, existingKey?: string) {
  const key = String(existingKey ?? b.key ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,40}$/.test(key)) throw new HttpError(400, "Key must be CAPITALS_AND_UNDERSCORES, e.g. INVOICE");
  const label = String(b.label ?? "").trim();
  if (!label) throw new HttpError(400, "Enter a name");
  if (!PERIODS.includes(b.periodKind)) throw new HttpError(400, "Choose how the period works");
  const idKind = b.identifierKind || null;
  if (idKind && !o.settings.identifierKinds.some((k) => k.key === idKind)) throw new HttpError(400, "Unknown ID type");
  const list = (v: unknown) => (Array.isArray(v) ? v : String(v ?? "").split(/\n|,/)).map((x) => String(x).trim()).filter(Boolean);
  const textPatterns = list(b.textPatterns), pathPatterns = list(b.pathPatterns);
  for (const p of [...textPatterns, ...pathPatterns]) {
    try { new RegExp(p); } catch { throw new HttpError(400, `Not a valid pattern: ${p}`); }
  }
  const bundle = b.bundle ? list(b.bundle).map((x) => x.toUpperCase()) : null;
  if (bundle) {
    const known = new Set((await query(`SELECT key FROM doc_types WHERE org_id=$1 AND bundle IS NULL`, [o.id])).map((r) => r.key));
    for (const m of bundle) if (!known.has(m)) throw new HttpError(400, `Unknown document type in group: ${m}`);
  }
  return { key, label, periodKind: b.periodKind, identifierKind: idKind, aliases: list(b.aliases).map((a) => a.toLowerCase()),
    textPatterns, pathPatterns, bundle: bundle?.length ? bundle : null, bundleOptional: bundle ? list(b.bundleOptional).map((x) => x.toUpperCase()) : [],
    priority: Number.isInteger(Number(b.priority)) ? Number(b.priority) : 100, active: b.active !== false };
}

app.get(`${D}/doc-types`, ...org("staff"), async (c) => {
  const rows = await query(
    `SELECT t.*, (SELECT count(*) FROM documents d WHERE d.org_id=t.org_id AND d.doc_type=t.key AND d.status='indexed') AS documents
       FROM doc_types t WHERE t.org_id=$1 ORDER BY t.bundle IS NOT NULL, t.priority, t.key`, [c.get("org").id]);
  return c.json({ docTypes: rows });
});

app.post(`${D}/doc-types`, ...org("admin"), async (c) => {
  const o = c.get("org");
  const d = await docTypeInput(o, await body(c));
  if (await one(`SELECT 1 FROM doc_types WHERE org_id=$1 AND key=$2`, [o.id, d.key])) throw new HttpError(409, `${d.key} already exists`);
  await insertDocType(query, o.id, d);
  return c.json({ ok: true });
});

app.put(`${D}/doc-types/:key`, ...org("admin"), async (c) => {
  const o = c.get("org");
  const d = await docTypeInput(o, await body(c), c.req.param("key"));
  const r = await one(
    `UPDATE doc_types SET label=$3, period_kind=$4, identifier_kind=$5, aliases=$6, text_patterns=$7, path_patterns=$8,
            bundle=$9, bundle_optional=$10, priority=$11, active=$12 WHERE org_id=$1 AND key=$2 RETURNING id`,
    [o.id, d.key, d.label, d.periodKind, d.identifierKind, d.aliases, d.textPatterns, d.pathPatterns, d.bundle, d.bundleOptional, d.priority, d.active]);
  if (!r) throw new HttpError(404, "Not found");
  return c.json({ ok: true });
});

app.delete(`${D}/doc-types/:key`, ...org("admin"), async (c) => {
  const o = c.get("org");
  const used = await one<{ n: number }>(`SELECT count(*) AS n FROM documents WHERE org_id=$1 AND doc_type=$2`, [o.id, c.req.param("key")]);
  if (used && used.n > 0) throw new HttpError(409, `${used.n} documents use this type. Turn it off instead of deleting.`);
  await query(`DELETE FROM doc_types WHERE org_id=$1 AND key=$2`, [o.id, c.req.param("key")]);
  return c.json({ ok: true });
});

// ---- test chat (no WhatsApp needed)

app.post(`${D}/simulator`, ...org("staff"), async (c) => {
  const o = c.get("org");
  const b = await body(c);
  const phone = normalizePhone(String(b.phone ?? ""));
  if (!phone) throw new HttpError(400, "Enter the customer's WhatsApp number to chat as");
  const text = String(b.text ?? "").slice(0, 1000);
  if (!text.trim() && !b.replyId) throw new HttpError(400, "Type a message");
  const m = new RecordingMessenger(true);
  const rt = await makeRuntime(o, m);
  await handleIncoming(rt, { id: `sim-${crypto.randomUUID()}`, from: phone, text, replyId: b.replyId || undefined, type: "text" });
  let budget = 4_000_000;
  const replies = m.sent.map((x) => {
    if (x.kind !== "document") return x;
    const include = x.file.length <= budget;
    if (include) budget -= x.file.length;
    return { to: x.to, kind: x.kind, filename: x.filename, caption: x.caption, size: x.file.length,
      data: include ? Buffer.from(x.file).toString("base64") : null };
  });
  return c.json({ phone, replies });
});

// ---- connection checks

app.get(`${D}/whatsapp/status`, ...org("admin"), async (c) => {
  const o = c.get("org");
  if (!o.settings.whatsapp.phoneNumberId || !o.secrets.waAccessToken) throw new HttpError(400, "Enter the phone number ID and access token first");
  const info = await new WhatsAppMessenger(o.settings, o.secrets).status();
  if (info.display_phone_number && info.display_phone_number !== o.settings.whatsapp.displayNumber) {
    await saveSettings(o, { whatsapp: { displayNumber: info.display_phone_number } });
  }
  return c.json(info);
});

app.post(`${D}/whatsapp/test`, ...org("admin"), async (c) => {
  const o = c.get("org");
  const to = normalizePhone(String((await body(c)).to ?? ""));
  if (!to) throw new HttpError(400, "Enter a WhatsApp number with country code");
  const r = await new WhatsAppMessenger(o.settings, o.secrets).sendHelloWorld(to);
  return c.json({ ok: true, id: r?.messages?.[0]?.id });
});

app.post(`${D}/storage/test`, ...org("admin"), async (c) => {
  const o = c.get("org");
  if (o.settings.storage.driver !== "google_drive") return c.json({ ok: true, note: "Uploads need no connection" });
  return c.json({ ok: true, ...(await driveFor(o).test()) });
});

