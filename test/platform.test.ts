import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { client, lockedWith, makeDocs, pdfFrom, resetDb, root } from "./helpers.js";

let db: Awaited<ReturnType<typeof resetDb>>;
let owner: Awaited<ReturnType<typeof client>>;
let orgId = "";
let D = "";
let sent: any[] = []; // what the "real" WhatsApp would have sent
const RAMESH = "919812345678", ACCOUNTANT = "919811100022", PRIYA = "919900011122";

before(async () => {
  db = await resetDb();
  owner = await client();
  const { setMessengerFactory } = await import("../server/docbot/runtime.js");
  const { RecordingMessenger } = await import("../server/docbot/messenger.js");
  setMessengerFactory(() => {
    const m = new RecordingMessenger(false);
    m.sent = new Proxy(m.sent, { get: (t, p) => (p === "push" ? (...x: any[]) => { sent.push(...x); return t.push(...x); } : (t as any)[p]) });
    return m;
  });
});
after(async () => { await db.closeDb(); });

const chat = async (phone: string, text: string, replyId?: string) => {
  const r = await owner.post(`${D}/simulator`, { phone, text, replyId });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.replies as any[];
};
const docsOf = (replies: any[]) => replies.filter((r) => r.kind === "document");
const textOf = (replies: any[]) => replies.filter((r) => r.kind !== "document").map((r) => r.text).join("\n");
const file = (r: any) => new Uint8Array(Buffer.from(r.data, "base64"));

test("sign up needs the code, then create a CA workspace", async () => {
  const bad = await owner.post("/api/auth/signup", { name: "Sanyam", email: "s@eedbe.com", password: "long-password-1", code: "nope" });
  assert.equal(bad.status, 403);
  const ok = await owner.post("/api/auth/signup", { name: "Sanyam", email: "S@eedbe.com", password: "long-password-1", code: "letmein" });
  assert.equal(ok.status, 200);
  const me = await owner.get("/api/auth/me");
  assert.equal(me.data.user.email, "s@eedbe.com");
  const org = await owner.post("/api/orgs", { name: "Jain & Associates", industry: "tax_accounting_in" });
  orgId = org.data.id;
  D = `/api/orgs/${orgId}/docbot`;
  const o = await owner.get(`/api/orgs/${orgId}`);
  assert.equal(o.data.role, "owner");
  assert.equal(o.data.settings.bareYearMeans, "fy");
  assert.equal(o.data.webhookUrl, `https://work.eedbe.com/api/webhooks/whatsapp/${orgId}`);
  assert.equal((await owner.post(`/api/orgs/${orgId}/features/whatsapp_docbot`, { enabled: true })).status, 200);
});

test("CSRF header is required for changes", async () => {
  const r = await owner.raw("POST", "/api/orgs", { name: "x", industry: "general" }, { "x-requested-with": "" });
  assert.equal(r.status, 403);
});

test("customers: CSV import (new and old CA format)", async () => {
  const r = await owner.post(`${D}/customers/import`, { csv: fs.readFileSync(path.join(root, "demo/customers.csv"), "utf8") });
  assert.deepEqual(r.data, { rows: 6, numbers: 3, customers: 4, errors: [] });
  const legacy = await owner.post(`${D}/customers/import`, { csv: fs.readFileSync(path.join(root, "test/legacy-clients.csv"), "utf8") });
  assert.deepEqual(legacy.data.errors, []);
  assert.equal(legacy.data.customers, 4, "re-import updates, doesn't duplicate");
  const list = await owner.get(`${D}/customers`);
  assert.equal(list.data.customers.length, 4);
  const st = list.data.customers.find((c: any) => c.name === "Sharma Traders");
  assert.deepEqual(st.identifiers.map((i: any) => i.value).sort(), ["08AAHFS5678L1Z3", "24AAHFS5678L1Z9", "AAHFS5678L"]);
  assert.deepEqual(st.contacts.map((c: any) => c.phone).sort(), [ACCOUNTANT, RAMESH]);
  const bad = await owner.post(`${D}/customers/import`, { csv: "phone,customer_name,pan\n123,X,BADPAN\n9876543210,Y,NOTAPAN1\n" });
  assert.equal(bad.data.errors.length, 2);
});

test("documents: uploading the office folder recognises 18 of 20", async () => {
  const { dir, files } = makeDocs();
  const results = [];
  for (const f of files) {
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(path.join(dir, f))], { type: "application/pdf" }), path.basename(f));
    form.append("path", f);
    const r = await owner.post(`${D}/documents/upload`, form);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    results.push(r.data);
  }
  assert.equal(results.filter((r) => r.status === "indexed").length, 18);
  const review = await owner.get(`${D}/documents?status=review`);
  assert.deepEqual(review.data.documents.map((d: any) => d.file_path).sort(), ["Misc/ITR-V.pdf", "Misc/scan0042.pdf"]);
  const indexed = await owner.get(`${D}/documents?status=indexed`);
  const locked = indexed.data.documents.find((d: any) => d.file_path.endsWith("ITRV_ABCPS1234K.pdf"));
  assert.equal(locked.password_rule, "id_date");
  assert.equal(locked.period, "AY 2024-25 (FY 2023-24)");
  const scanned = indexed.data.documents.find((d: any) => d.file_path === "Mehta Enterprises/GST/2026-27/August/GSTR3B.pdf");
  assert.equal(scanned.classified_by, "path");
  assert.equal(scanned.identifier, "08AABCM4321Q1ZP");
  const gstr1 = indexed.data.documents.find((d: any) => d.doc_type === "GSTR1");
  assert.equal(gstr1.customer, "Sharma Traders", "the customer's GSTIN inside a GSTR-1 must not win");
  const firm = indexed.data.documents.find((d: any) => d.file_path === "Sharma Traders/ITR/AY 2025-26/ITR-V.pdf");
  assert.equal(firm.customer, "Sharma Traders");
  const pdf = await owner.get(`${D}/documents/${firm.id}/file`);
  assert.ok(pdf.data instanceof Uint8Array && pdf.data.length > 500);
});

test("test chat: ITR asks which file, then sends locked ITR-V + computation", async () => {
  const q = await chat(RAMESH, "send my ITR");
  assert.equal(q[0].kind, "list");
  assert.deepEqual(q[0].rows.map((r: any) => r.title), ["Ramesh Sharma", "Sharma Traders"]);
  const out = await chat(RAMESH, "", "pick:0");
  assert.deepEqual(docsOf(out).map((d) => d.filename), ["Ramesh_Sharma_ITR_V_AY2025-26.pdf", "Ramesh_Sharma_COMPUTATION_AY2025-26.pdf"]);
  for (const d of docsOf(out)) assert.ok(lockedWith(file(d), "abcps1234k15081975"));
  assert.match(textOf(out), /PAN in small letters \+ date of birth \/ incorporation as DDMMYYYY/);
  assert.equal(sent.length, 0, "the test chat never sends real WhatsApp messages");
});

test("test chat: names, numbers, years, months, GSTINs", async () => {
  let out = await chat(RAMESH, "ITR of Sharma Traders");
  assert.deepEqual(docsOf(out).map((d) => d.filename), ["Sharma_Traders_ITR_V_AY2025-26.pdf"]);
  assert.doesNotMatch(textOf(out), /couldn't find/);

  await chat(RAMESH, "last 3 years itr");
  out = await chat(RAMESH, "Ramesh Sharma");
  assert.deepEqual(docsOf(out).filter((d) => d.filename.includes("ITR_V")).map((d) => d.filename),
    ["Ramesh_Sharma_ITR_V_AY2023-24.pdf", "Ramesh_Sharma_ITR_V_AY2024-25.pdf", "Ramesh_Sharma_ITR_V_AY2025-26.pdf"]);

  await chat(RAMESH, "ITR-V 2024-25");
  out = await chat(RAMESH, "1");
  assert.deepEqual(docsOf(out).map((d) => d.filename), ["Ramesh_Sharma_ITR_V_AY2025-26.pdf"], "bare year = FY by default");

  await chat(RAMESH, "GSTR-3B for March");
  out = await chat(RAMESH, "1");
  assert.deepEqual(docsOf(out).map((d) => d.filename), ["Sharma_Traders_GSTR3B_Mar2026.pdf"]);

  out = await chat(RAMESH, "3B august gujarat");
  assert.deepEqual(docsOf(out).map((d) => d.caption), ["*Sharma Traders Gujarat*\nGSTR-3B — August 2026"]);

  await chat(RAMESH, "26AS");
  out = await chat(RAMESH, "1");
  assert.ok(lockedWith(file(docsOf(out)[0]), "15081975"));
  assert.match(textOf(out), /opens with your date of birth/);
});

test("settings: switch the year convention to AY", async () => {
  const r = await owner.patch(`/api/orgs/${orgId}/settings`, { bareYearMeans: "ay" });
  assert.equal(r.data.settings.bareYearMeans, "ay");
  await chat(RAMESH, "ITR-V 2024-25");
  const out = await chat(RAMESH, "1");
  assert.deepEqual(docsOf(out).map((d) => d.filename), ["Ramesh_Sharma_ITR_V_AY2024-25.pdf"]);
  await owner.patch(`/api/orgs/${orgId}/settings`, { bareYearMeans: "fy" });
  const bad = await owner.patch(`/api/orgs/${orgId}/settings`, { limits: { maxDocsPerHour: -1 } });
  assert.equal(bad.status, 400);
});

test("test-chat requests are marked as tests and never delivered", async () => {
  await chat(RAMESH, "GST returns 2026-27");
  const out = await chat(RAMESH, "Sharma Traders");
  assert.equal(docsOf(out).length, 4);
  assert.match(textOf(out), /GSTR-3B — July 2026/);
  const reqs = await owner.get(`${D}/requests`);
  assert.ok(reqs.data.requests.every((r: any) => r.simulated));
});

test("WhatsApp webhook: signature, verification, conversation, auto-delivery of a late upload", async () => {
  // Connect WhatsApp (secrets are stored encrypted and only shown masked)
  await owner.patch(`/api/orgs/${orgId}/settings`, { whatsapp: { phoneNumberId: "PNID" }, staffPhones: ["919000000001"] });
  const s = await owner.put(`/api/orgs/${orgId}/secrets`, { waAccessToken: "EAAG-secret-token-123", waAppSecret: "appsecret", waVerifyToken: "verify-me" });
  assert.deepEqual(s.data.secrets.waAccessToken, { set: true, preview: "EAAG••••-123" });
  const o = await owner.get(`/api/orgs/${orgId}`);
  assert.doesNotMatch(JSON.stringify(o.data), /secret-token|appsecret|verify-me/);

  const hook = `/api/webhooks/whatsapp/${orgId}`;
  const verify = await owner.get(`${hook}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=777`);
  assert.equal(verify.data, "777");
  assert.equal((await owner.get(`${hook}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);

  const send = async (from: string, text: string) => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "PNID" }, contacts: [{ wa_id: from, profile: { name: "X" } }],
      messages: [{ id: `wamid.${crypto.randomUUID()}`, from, type: "text", text: { body: text } }] } }] }] });
    const sig = "sha256=" + crypto.createHmac("sha256", "appsecret").update(body).digest("hex");
    const before = sent.length;
    const r = await owner.app.request(`https://work.eedbe.com${hook}`, { method: "POST", body, headers: { "content-type": "application/json", "x-hub-signature-256": sig } });
    assert.equal(r.status, 200);
    return sent.slice(before);
  };
  const badSig = await owner.app.request(`https://work.eedbe.com${hook}`, { method: "POST", body: "{}", headers: { "x-hub-signature-256": "sha256=00" } });
  assert.equal(badSig.status, 401);

  await send(RAMESH, "GST returns 2026-27");
  const out = await send(RAMESH, "Sharma Traders");
  const toRamesh = out.filter((x) => x.to === RAMESH);
  assert.equal(toRamesh.filter((x) => x.kind === "document").length, 4);
  assert.ok(out.some((x) => x.to === "919000000001" && /GSTR-3B — July 2026/.test(x.text)), "staff alerted");

  // Staff upload July's return; it goes straight to Ramesh.
  const form = new FormData();
  form.append("file", new Blob([pdfFrom(["Form GSTR-3B", "Year 2026-27", "Period July", "1. GSTIN 08AAHFS5678L1Z3"])]), "3B.pdf");
  form.append("path", "Sharma Traders/GST/2026-27/July/3B.pdf");
  const before = sent.length;
  const up = await owner.post(`${D}/documents/upload`, form);
  assert.equal(up.data.status, "indexed");
  const delivered = sent.slice(before);
  assert.deepEqual(delivered.filter((x) => x.kind === "document").map((x) => x.filename), ["Sharma_Traders_GSTR3B_Jul2026.pdf"]);
  assert.match(delivered.find((x) => x.kind === "text").text, /asked for earlier/);

  // Unknown number: one reply a day
  assert.equal((await send("919999999999", "hi")).length, 1);
  assert.equal((await send("919999999999", "hi")).length, 0);

  // Accountant can't reach Ramesh's personal documents
  const acc = await send(ACCOUNTANT, "Form 16");
  assert.equal(acc.filter((x) => x.kind === "document").length, 0);
  const accItr = await send(ACCOUNTANT, "Ramesh Sharma ITR");
  assert.ok(accItr.filter((x) => x.kind === "document").every((x: any) => x.filename.startsWith("Sharma_Traders")));

  // Approval flow
  const huf = await send(PRIYA, "HUF ITR");
  assert.equal(huf.filter((x) => x.kind === "document").length, 0);
  const pending = (await owner.get(`${D}/requests`)).data.requests.find((r: any) => r.reason === "approval" && !r.simulated);
  const b2 = sent.length;
  const ap = await owner.post(`${D}/requests/${pending.id}/approve`);
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  const hufDoc = sent.slice(b2).find((x) => x.kind === "document");
  assert.equal(hufDoc.filename, "Mehta_Family_HUF_ITR_V_AY2025-26.pdf");
  assert.ok(lockedWith(hufDoc.file, "aaghm1122h10012001"));

  const act = await owner.get(`${D}/activity?test=hide`);
  assert.ok(act.data.activity.some((a: any) => a.event === "document_sent" && a.phone === RAMESH));
});

test("review queue: staff place a file and waiting requests get it", async () => {
  const review = (await owner.get(`${D}/documents?status=review`)).data.documents;
  const scan = review.find((d: any) => d.file_path === "Misc/scan0042.pdf");
  const mehta = (await owner.get(`${D}/customers?q=Mehta Enterprises`)).data.customers[0];
  const r = await owner.patch(`${D}/documents/${scan.id}`, { entityId: mehta.id, docType: "GST_CERT" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const again = (await owner.get(`${D}/documents?status=review`)).data.documents;
  assert.equal(again.length, 1);
});

test("document types can be added and are understood immediately", async () => {
  const add = await owner.post(`${D}/doc-types`, {
    key: "TDS_CERT", label: "TDS certificate (Form 16A)", periodKind: "fy", aliases: "16a, tds certificate",
    textPatterns: "FORM\\s*(NO\\.?)?\\s*16A", pathPatterns: "16a",
  });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  const form = new FormData();
  form.append("file", new Blob([pdfFrom(["FORM NO. 16A", "Certificate under section 203", "PAN of the Deductee ABCPS1234K", "Assessment Year 2025-26"])]), "16a.pdf");
  form.append("path", "Ramesh Sharma/TDS/16A.pdf");
  assert.equal((await owner.post(`${D}/documents/upload`, form)).data.status, "indexed");
  const out = await chat(RAMESH, "tds certificate");
  const picked = out[0]?.kind === "list" ? await chat(RAMESH, "1") : out;
  assert.deepEqual(docsOf(picked).map((d) => d.filename), ["Ramesh_Sharma_TDS_CERT_AY2025-26.pdf"]);
  const badRe = await owner.post(`${D}/doc-types`, { key: "X", label: "X", periodKind: "none", textPatterns: "([" });
  assert.equal(badRe.status, 400);
});

test("team: invite staff; staff can't change settings; outsiders see nothing", async () => {
  const inv = await owner.post(`/api/orgs/${orgId}/invites`, { email: "staff@firm.in", role: "staff" });
  const token = inv.data.link.split("/invite/")[1];
  const staff = await client();
  assert.equal((await staff.get(`/api/invites/${token}`)).data.org_name, "Jain & Associates");
  const acc = await staff.post(`/api/invites/${token}/accept`, { name: "Staff One", password: "staff-password-1" });
  assert.equal(acc.status, 200);
  assert.equal((await staff.get(`/api/orgs/${orgId}`)).data.role, "staff");
  assert.equal((await staff.patch(`/api/orgs/${orgId}/settings`, { bareYearMeans: "ay" })).status, 403);
  assert.equal((await staff.put(`/api/orgs/${orgId}/secrets`, { waAccessToken: "x" })).status, 403);
  assert.equal((await staff.get(`${D}/customers`)).status, 200);

  const outsider = await client();
  await outsider.post("/api/auth/signup", { name: "Other", email: "o@x.com", password: "other-password-1", code: "letmein" });
  assert.equal((await outsider.get(`/api/orgs/${orgId}`)).status, 404);
  assert.equal((await outsider.get(`${D}/documents`)).status, 404);
});

test("a non-CA business: generic customer IDs and document types", async () => {
  const org = await owner.post("/api/orgs", { name: "Shree Insurance Agency", industry: "general" });
  const G = `/api/orgs/${org.data.id}/docbot`;
  await owner.post(`/api/orgs/${org.data.id}/features/whatsapp_docbot`, { enabled: true });
  await owner.post(`${G}/doc-types`, { key: "POLICY", label: "Policy document", periodKind: "none", aliases: "policy, policy copy",
    textPatterns: "POLICY\\s+SCHEDULE" });
  const c = await owner.post(`${G}/customers`, { name: "Anita Verma", keyDate: "02-03-1988",
    identifiers: [{ kind: "CUSTOMER_ID", value: "cust-0042" }], contacts: [{ phone: "9876500001", name: "Anita" }] });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const form = new FormData();
  form.append("file", new Blob([pdfFrom(["POLICY SCHEDULE", "Customer ID: CUST-0042", "Sum assured 10,00,000"])]), "p.pdf");
  form.append("path", "policies/p.pdf");
  assert.equal((await owner.post(`${G}/documents/upload`, form)).data.status, "indexed");
  const r = await owner.post(`${G}/simulator`, { phone: "9876500001", text: "please send my policy copy" });
  const d = r.data.replies.find((x: any) => x.kind === "document");
  assert.equal(d.filename, "Anita_Verma_POLICY.pdf");
  assert.ok(lockedWith(new Uint8Array(Buffer.from(d.data, "base64")), "cust-004202031988"));
  // The CA workspace's data is invisible here
  assert.equal((await owner.get(`${G}/customers`)).data.customers.length, 1);
});
