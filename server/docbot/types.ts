// Runtime view of a workspace's document types and customers, loaded from the database.

import { query } from "../db.js";
import type { IdentifierKind, OrgSettings } from "../settings.js";
import type { YearStyle } from "./periods.js";

export interface DocType {
  key: string;
  label: string;
  periodKind: "none" | "month" | "fy";
  identifierKind: string | null;
  aliases: string[];
  textPatterns: RegExp[];
  pathPatterns: RegExp[];
  bundle: string[] | null;
  bundleOptional: string[];
  priority: number;
}

const compile = (sources: string[], flags = "i") =>
  sources.flatMap((s) => { try { return [new RegExp(s, flags)]; } catch { return []; } });

export async function loadDocTypes(orgId: string): Promise<DocType[]> {
  const rows = await query(
    `SELECT key, label, period_kind, identifier_kind, aliases, text_patterns, path_patterns, bundle, bundle_optional, priority
       FROM doc_types WHERE org_id=$1 AND active ORDER BY priority, key`, [orgId]);
  return rows.map((r) => ({
    key: r.key, label: r.label, periodKind: r.period_kind, identifierKind: r.identifier_kind,
    aliases: r.aliases, textPatterns: compile(r.text_patterns), pathPatterns: compile(r.path_patterns),
    bundle: r.bundle, bundleOptional: r.bundle_optional ?? [], priority: r.priority,
  }));
}

/** Real document types (bundles excluded), in recognition order. */
export const fileTypes = (types: DocType[]) => types.filter((t) => !t.bundle);

/** Expands bundles ("ITR" -> ITR_V + COMPUTATION) into real types. */
export function expand(keys: string[], types: DocType[]) {
  const byKey = new Map(types.map((t) => [t.key, t]));
  const out: DocType[] = [];
  const optional = new Set<string>();
  const add = (t?: DocType) => { if (t && !out.includes(t)) out.push(t); };
  for (const k of keys) {
    const t = byKey.get(k);
    if (!t) continue;
    if (t.bundle) {
      t.bundle.forEach((m) => add(byKey.get(m)));
      t.bundleOptional.forEach((m) => { if (!keys.includes(m)) optional.add(m); });
    } else add(t);
  }
  return { types: out.filter((t) => !t.bundle), optional };
}

export interface Directory {
  kinds: IdentifierKind[];
  /** kind -> value -> identifier row */
  byValue: Map<string, Map<string, { id: number; entityId: number }>>;
  /** normalized customer / trade name -> entity id */
  entityByName: Map<string, number>;
  /** entity -> identifier ids per kind */
  idsOfEntity: Map<number, Map<string, number[]>>;
  /** candidates for opening portal-locked PDFs */
  passwordSources: { entityId: number; primaryId: string; keyDate: string | null }[];
}

export function normalizeName(s: string) {
  return s.toLowerCase()
    .replace(/\bm\/s\.?/g, "")
    .replace(/\b(private|pvt|limited|ltd|llp)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export async function loadDirectory(orgId: string, settings: OrgSettings): Promise<Directory> {
  const entities = await query<{ id: number; name: string; key_date: string | null }>(
    `SELECT id, name, key_date FROM entities WHERE org_id=$1 AND active`, [orgId]);
  const ids = await query<{ id: number; entity_id: number; kind: string; value: string; label: string | null }>(
    `SELECT i.id, i.entity_id, i.kind, i.value, i.label FROM identifiers i JOIN entities e ON e.id=i.entity_id AND e.active
      WHERE i.org_id=$1 AND i.active`, [orgId]);
  const dir: Directory = {
    kinds: settings.identifierKinds, byValue: new Map(), entityByName: new Map(), idsOfEntity: new Map(), passwordSources: [],
  };
  const primary = settings.identifierKinds.find((k) => k.primary)?.key;
  const keyDate = new Map(entities.map((e) => [e.id, e.key_date]));
  for (const e of entities) dir.entityByName.set(normalizeName(e.name), e.id);
  for (const i of ids) {
    if (!dir.byValue.has(i.kind)) dir.byValue.set(i.kind, new Map());
    dir.byValue.get(i.kind)!.set(i.value.toUpperCase(), { id: i.id, entityId: i.entity_id });
    if (i.label) dir.entityByName.set(normalizeName(i.label), i.entity_id);
    const m = dir.idsOfEntity.get(i.entity_id) ?? new Map<string, number[]>();
    m.set(i.kind, [...(m.get(i.kind) ?? []), i.id]);
    dir.idsOfEntity.set(i.entity_id, m);
    if (i.kind === primary) dir.passwordSources.push({ entityId: i.entity_id, primaryId: i.value, keyDate: keyDate.get(i.entity_id) ?? null });
  }
  return dir;
}

export const yearStyle = (s: OrgSettings): YearStyle => ({ fyStartMonth: s.fyStartMonth, showAssessmentYear: s.showAssessmentYear });
