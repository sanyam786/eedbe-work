import { one, query, tx } from "./db.js";
import { decryptJson, encryptJson, mask } from "./crypto.js";
import { BASE_SETTINGS, mergeSettings, SECRET_KEYS, validateSettings, type OrgSecrets, type OrgSettings } from "./settings.js";
import { initialSettings, type DocTypeDef, type Preset } from "./presets.js";

export interface Org {
  id: string;
  name: string;
  industry: string;
  settings: OrgSettings;
  secrets: OrgSecrets;
  features: Record<string, boolean>;
}

export async function loadOrg(orgId: string): Promise<Org | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return undefined;
  const row = await one<{ id: string; name: string; industry: string; settings: any; secrets_enc: string | null }>(
    `SELECT id, name, industry, settings, secrets_enc FROM orgs WHERE id=$1`, [orgId]);
  if (!row) return undefined;
  const features = await query<{ feature: string; enabled: boolean }>(`SELECT feature, enabled FROM org_features WHERE org_id=$1`, [orgId]);
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    settings: mergeSettings(BASE_SETTINGS, row.settings),
    secrets: decryptJson<OrgSecrets>(row.secrets_enc) ?? {},
    features: Object.fromEntries(features.map((f) => [f.feature, f.enabled])),
  };
}

export async function createOrg(userId: string, name: string, preset: Preset) {
  const settings = initialSettings(preset, name);
  return tx(async (q) => {
    const [org] = await q<{ id: string }>(
      `INSERT INTO orgs (name, industry, settings) VALUES ($1,$2,$3) RETURNING id`,
      [name, preset.key, JSON.stringify(settings)]);
    await q(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'owner')`, [userId, org.id]);
    for (const d of preset.docTypes) await insertDocType(q, org.id, d);
    return org.id;
  });
}

export async function insertDocType(q: (sql: string, p?: unknown[]) => Promise<any[]>, orgId: string, d: DocTypeDef) {
  await q(
    `INSERT INTO doc_types (org_id, key, label, period_kind, identifier_kind, aliases, text_patterns, path_patterns,
                            bundle, bundle_optional, priority, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [orgId, d.key, d.label, d.periodKind, d.identifierKind ?? null, d.aliases, d.textPatterns ?? [], d.pathPatterns ?? [],
     d.bundle ?? null, d.bundleOptional ?? [], d.priority ?? 100, d.active ?? true]);
}

export async function saveSettings(org: Org, patch: unknown) {
  const next = mergeSettings(org.settings, patch);
  validateSettings(next);
  await query(`UPDATE orgs SET settings=$2, name=$3 WHERE id=$1`, [org.id, JSON.stringify(next), next.businessName]);
  return next;
}

/** Sets the given secrets; an empty string removes one. Others are untouched. */
export async function saveSecrets(org: Org, patch: Record<string, unknown>) {
  const next: OrgSecrets = { ...org.secrets };
  for (const k of SECRET_KEYS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (typeof v !== "string") throw new Error(`${k} must be text`);
    if (v.trim()) next[k] = v.trim();
    else delete next[k];
  }
  if (next.googleServiceAccount) {
    let sa: any;
    try { sa = JSON.parse(next.googleServiceAccount); } catch { throw new Error("The Google key must be the JSON file's contents"); }
    if (sa.type !== "service_account" || !sa.client_email || !sa.private_key) throw new Error("That JSON isn't a service-account key");
  }
  await query(`UPDATE orgs SET secrets_enc=$2 WHERE id=$1`, [org.id, encryptJson(next)]);
  return next;
}

/** What the dashboard may see about secrets: whether set, and a masked preview. */
export function secretSummary(s: OrgSecrets) {
  const out: Record<string, { set: boolean; preview: string }> = {};
  for (const k of SECRET_KEYS) {
    let preview = mask(s[k]);
    if (k === "googleServiceAccount" && s[k]) {
      try { preview = JSON.parse(s[k]!).client_email; } catch { /* keep mask */ }
    }
    out[k] = { set: Boolean(s[k]), preview };
  }
  return out;
}

export async function setFeature(orgId: string, feature: string, enabled: boolean) {
  await query(
    `INSERT INTO org_features (org_id, feature, enabled) VALUES ($1,$2,$3)
     ON CONFLICT (org_id, feature) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now()`,
    [orgId, feature, enabled]);
}
