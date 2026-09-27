// Customers: CSV import and create/update from the dashboard.
//
// CSV: one row per (WhatsApp number, customer it may receive documents for). Re-importing updates in place.
//   phone, contact_name, customer_name, customer_type, key_date, requires_approval,
//   one column per ID type (e.g. pan, gstin, customer_id), and <id>_label or trade_name for labels.
// The older CA format (entity_name, entity_type, dob) is accepted too.

import { tx } from "../db.js";
import type { OrgSettings } from "../settings.js";

type Q = (sql: string, p?: unknown[]) => Promise<any[]>;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

export function normalizePhone(raw: string, defaultCountry = "91"): string | undefined {
  const d = String(raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (d.length === 10) return defaultCountry + d;
  if (d.length >= 11 && d.length <= 15) return d;
  return undefined;
}

export function parseDate(raw: string): string | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return undefined;
}

export interface CustomerInput {
  name: string;
  entityType?: string;
  keyDate?: string | null;
  requiresApproval?: boolean;
  identifiers: { kind: string; value: string; label?: string | null }[];
  contacts: { phone: string; name?: string | null }[];
}

function checkIdentifier(settings: OrgSettings, kind: string, value: string) {
  const spec = settings.identifierKinds.find((k) => k.key === kind);
  if (!spec) throw new Error(`Unknown ID type ${kind}`);
  if (spec.pattern && !new RegExp(`^(?:${spec.pattern})$`).test(value)) throw new Error(`"${value}" doesn't look like a valid ${spec.label}`);
}

async function upsertContact(q: Q, orgId: string, phone: string, name?: string | null) {
  const [c] = await q(
    `INSERT INTO contacts (org_id, phone, name) VALUES ($1,$2,$3)
     ON CONFLICT (org_id, phone) DO UPDATE SET name=COALESCE(NULLIF(EXCLUDED.name,''), contacts.name), active=TRUE
     RETURNING id`, [orgId, phone, name || null]);
  return c.id as number;
}

async function upsertIdentifier(q: Q, orgId: string, entityId: number, kind: string, value: string, label?: string | null) {
  const [clash] = await q(`SELECT entity_id FROM identifiers WHERE org_id=$1 AND kind=$2 AND value=$3`, [orgId, kind, value]);
  if (clash && clash.entity_id !== entityId) {
    const [e] = await q(`SELECT name, active FROM entities WHERE id=$1`, [clash.entity_id]);
    if (e?.active) throw new Error(`${kind} ${value} already belongs to ${e.name}`);
  }
  await q(
    `INSERT INTO identifiers (org_id, entity_id, kind, value, label) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (org_id, kind, value) DO UPDATE SET entity_id=EXCLUDED.entity_id, label=COALESCE(EXCLUDED.label, identifiers.label), active=TRUE`,
    [orgId, entityId, kind, value, label || null]);
}

/** Creates or replaces one customer (dashboard form). Returns its id. */
export async function saveCustomer(orgId: string, settings: OrgSettings, input: CustomerInput, id?: number) {
  const name = input.name?.trim();
  if (!name) throw new Error("Customer name is required");
  const keyDate = input.keyDate ? parseDate(input.keyDate) : null;
  if (input.keyDate && !keyDate) throw new Error(`${settings.keyDateLabel} should be DD-MM-YYYY`);
  const ids = (input.identifiers ?? []).map((i) => ({ kind: i.kind, value: i.value.trim().toUpperCase(), label: i.label?.trim() || null })).filter((i) => i.value);
  for (const i of ids) checkIdentifier(settings, i.kind, i.value);
  const contacts = (input.contacts ?? []).map((c) => {
    const phone = normalizePhone(c.phone);
    if (!phone) throw new Error(`"${c.phone}" isn't a valid phone number`);
    return { phone, name: c.name?.trim() || null };
  });

  return tx(async (q) => {
    let entityId = id;
    if (entityId) {
      const [e] = await q(`UPDATE entities SET name=$3, entity_type=$4, key_date=$5, requires_approval=$6, active=TRUE
                            WHERE id=$1 AND org_id=$2 RETURNING id`,
        [entityId, orgId, name, input.entityType || "individual", keyDate, !!input.requiresApproval]);
      if (!e) throw new Error("Customer not found");
    } else {
      const [e] = await q(`INSERT INTO entities (org_id, name, entity_type, key_date, requires_approval) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [orgId, name, input.entityType || "individual", keyDate, !!input.requiresApproval]);
      entityId = e.id;
    }
    // Identifiers: keep listed, deactivate the rest
    for (const i of ids) await upsertIdentifier(q, orgId, entityId!, i.kind, i.value, i.label);
    await q(`UPDATE identifiers SET active=FALSE WHERE entity_id=$1 AND NOT ((kind || ':' || value) = ANY($2))`,
      [entityId, ids.map((i) => `${i.kind}:${i.value}`)]);
    // Contacts: replace links
    await q(`DELETE FROM contact_entities WHERE entity_id=$1`, [entityId]);
    for (const c of contacts) {
      const cid = await upsertContact(q, orgId, c.phone, c.name);
      await q(`INSERT INTO contact_entities (contact_id, entity_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [cid, entityId]);
    }
    return entityId!;
  });
}

export async function importCustomersCsv(orgId: string, settings: OrgSettings, text: string) {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ""));
  if (!header) throw new Error("The file is empty");
  const h = header.map((x) => x.trim().toLowerCase());
  const col = (...names: string[]) => { for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; } return -1; };
  const idx = {
    phone: col("phone", "whatsapp", "mobile"), contact: col("contact_name", "contact"),
    name: col("customer_name", "entity_name", "name"), type: col("customer_type", "entity_type", "type"),
    date: col("key_date", "dob", "date_of_birth", "incorporation_date"), approval: col("requires_approval", "approval"),
    trade: col("trade_name"),
  };
  if (idx.phone < 0 || idx.name < 0) throw new Error("The CSV needs 'phone' and 'customer_name' columns");
  const kindCols = settings.identifierKinds.map((k) => ({
    kind: k, col: col(k.key.toLowerCase()), label: col(`${k.key.toLowerCase()}_label`),
  })).filter((k) => k.col >= 0);
  const primary = settings.identifierKinds.find((k) => k.primary)?.key;

  const errors: string[] = [];
  const phones = new Set<string>();
  const customers = new Set<number>();
  let imported = 0;

  await tx(async (q) => {
    for (const [n, r] of rows.entries()) {
      const line = n + 2;
      const get = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
      try {
        const phone = normalizePhone(get(idx.phone));
        if (!phone) throw new Error(`bad phone "${get(idx.phone)}"`);
        const name = get(idx.name);
        if (!name) throw new Error("missing customer_name");
        const dateRaw = get(idx.date);
        const keyDate = dateRaw ? parseDate(dateRaw) : null;
        if (dateRaw && !keyDate) throw new Error(`date "${dateRaw}" should be DD-MM-YYYY`);
        const type = (get(idx.type) || settings.entityTypes[0] || "individual").toLowerCase();
        const approval = /^(y|yes|true|1)$/i.test(get(idx.approval));
        const ids = kindCols.map((k) => ({
          kind: k.kind.key, value: get(k.col).toUpperCase(),
          label: get(k.label) || (k.kind.selectable ? get(idx.trade) : "") || null,
        })).filter((i) => i.value);
        for (const i of ids) checkIdentifier(settings, i.kind, i.value);

        // Find the customer: by main ID, else by name
        const pid = ids.find((i) => i.kind === primary);
        let entityId: number | undefined;
        if (pid) {
          const [hit] = await q(`SELECT entity_id FROM identifiers WHERE org_id=$1 AND kind=$2 AND value=$3`, [orgId, pid.kind, pid.value]);
          entityId = hit?.entity_id;
        }
        if (!entityId && !pid) {
          const [hit] = await q(`SELECT id FROM entities WHERE org_id=$1 AND lower(name)=lower($2) ORDER BY active DESC, id LIMIT 1`, [orgId, name]);
          entityId = hit?.id;
        }
        if (entityId) {
          await q(`UPDATE entities SET name=$2, entity_type=$3, key_date=COALESCE($4, key_date), requires_approval=$5, active=TRUE WHERE id=$1`,
            [entityId, name, type, keyDate, approval]);
        } else {
          const [e] = await q(`INSERT INTO entities (org_id, name, entity_type, key_date, requires_approval) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [orgId, name, type, keyDate, approval]);
          entityId = e.id;
        }
        for (const i of ids) await upsertIdentifier(q, orgId, entityId!, i.kind, i.value, i.label);
        const cid = await upsertContact(q, orgId, phone, get(idx.contact));
        await q(`INSERT INTO contact_entities (contact_id, entity_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [cid, entityId]);
        imported++;
        phones.add(phone);
        customers.add(entityId!);
      } catch (e) {
        errors.push(`Line ${line}: ${(e as Error).message}`);
        if (/violates|constraint/.test((e as Error).message)) throw e;
      }
    }
  });
  return { rows: imported, numbers: phones.size, customers: customers.size, errors };
}
