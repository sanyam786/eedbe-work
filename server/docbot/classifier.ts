// Works out what a PDF is (type, whose, which period) from its text and folder path.
// Files it can't place confidently go to the staff review queue.

import { fyRange, monthRange, monthsRange, yearOfMonthInFy, type Range, type YearStyle } from "./periods.js";
import { normalizeName, type DocType, type Directory } from "./types.js";

export interface Classification {
  docType?: string;
  entityId?: number;
  identifierId?: number;
  period?: Range;
  classifiedBy: "rules" | "path" | "ai";
  reviewReason?: string;
}

const MONTH_RE =
  "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\b";
const MONTH_IDX: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const monthIdx = (s: string) => MONTH_IDX[s.toLowerCase().slice(0, 3)];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function yearPair(a: string, b: string): number | undefined {
  const y = Number(a);
  const e = Number(b.length === 2 ? `${a.slice(0, 2)}${b}` : b);
  return e === y + 1 ? y : undefined;
}

/** Start year of the financial/assessment year mentioned in text. */
export function findFyStart(text: string, style: YearStyle, preferAy = true): number | undefined {
  const ay = style.showAssessmentYear
    ? /(?:Assessment\s+Year|\bA\.?\s?Y\.?)\s*[:\-]?\s*(20\d{2})\s*[-–]\s*(\d{2,4})/i.exec(text) : null;
  const fy = /(?:Financial\s+Year|\bF\.?\s?Y\.?|\bYear)\s*[:\-]?\s*(20\d{2})\s*[-–]\s*(\d{2,4})/i.exec(text);
  const ayStart = ay ? yearPair(ay[1], ay[2]) : undefined;
  const fyStart = fy ? yearPair(fy[1], fy[2]) : undefined;
  if (preferAy && ayStart !== undefined) return ayStart - 1;
  if (fyStart !== undefined) return fyStart;
  if (ayStart !== undefined) return ayStart - 1;
  const bare = /\b(20\d{2})\s*[-–_]\s*(\d{2})\b/.exec(text);
  if (bare) return yearPair(bare[1], bare[2]);
  if (style.fyStartMonth === 1) {
    const cal = /(?:Year|FY)\s*[:\-]?\s*(20\d{2})\b/i.exec(text);
    if (cal) return Number(cal[1]);
  }
  return undefined;
}

/** Month or quarter of a periodic document. Bare month words are only trusted in file names. */
export function findMonthPeriod(text: string, style: YearStyle, fyStart?: number, allowBareMonth = false): Range | undefined {
  const yearFor = (m: number) => (fyStart === undefined ? undefined : yearOfMonthInFy(m, fyStart, style));

  const mmyyyy = /(?:period)\s*[:\-]?\s*(0[1-9]|1[0-2])\s*\/?\s*(20\d{2})\b/i.exec(text);
  if (mmyyyy) return monthRange(Number(mmyyyy[2]), Number(mmyyyy[1]));

  const q = new RegExp(`\\b${MONTH_RE}\\s*(?:-|–|to)\\s*${MONTH_RE}`, "i").exec(text);
  if (q) {
    const a = monthIdx(q[1]), b = monthIdx(q[2]);
    const ya = yearFor(a), yb = yearFor(b);
    if (ya && yb && (b - a + 12) % 12 === 2) return monthsRange(ya, a, yb, b);
  }

  const labelled = new RegExp(`(?:period|month)\\s*[:\\-]?\\s*${MONTH_RE}(?:\\s*[-,]?\\s*(20\\d{2}))?`, "i").exec(text);
  const loose = allowBareMonth ? new RegExp(`(?:^|[^a-z])${MONTH_RE}(?:\\s*[-,]?\\s*(20\\d{2}))?`, "i").exec(text) : null;
  const m = labelled ?? loose;
  if (m) {
    const month = monthIdx(m[1]);
    const year = m[2] ? Number(m[2]) : yearFor(month);
    if (year) return monthRange(year, month);
  }
  return undefined;
}

/** Known identifiers of one kind, in the order they appear in `text`. */
function findIdentifiers(text: string, kind: string, dir: Directory, upper: boolean) {
  const known = dir.byValue.get(kind);
  if (!known?.size) return [];
  const spec = dir.kinds.find((k) => k.key === kind);
  const hay = upper ? text.toUpperCase() : text;
  const hits: { pos: number; id: number; entityId: number }[] = [];
  if (spec?.pattern) {
    for (const m of hay.matchAll(new RegExp(`\\b(?:${spec.pattern})\\b`, "g"))) {
      const row = known.get(m[0].toUpperCase());
      if (row) hits.push({ pos: m.index!, ...row });
    }
  } else {
    const lower = hay.toLowerCase();
    for (const [value, row] of known) {
      const m = new RegExp(`(?<![a-z0-9])${escapeRe(value.toLowerCase())}(?![a-z0-9])`).exec(lower);
      if (m) hits.push({ pos: m.index, ...row });
    }
  }
  return hits.sort((a, b) => a.pos - b.pos);
}

function entityFromFolderNames(filePath: string, dir: Directory) {
  const segs = filePath.split("/").slice(0, -1).map(normalizeName).filter(Boolean).reverse();
  for (const s of segs) {
    const id = dir.entityByName.get(s);
    if (id !== undefined) return id;
  }
  return undefined;
}

export function classify(text: string, filePath: string, types: DocType[], dir: Directory, style: YearStyle): Classification {
  const fileName = filePath.split("/").pop() ?? filePath;
  let classifiedBy: Classification["classifiedBy"] = "rules";

  let type = types.find((t) => t.textPatterns.some((r) => r.test(text)));
  if (!type) {
    type = types.find((t) => t.pathPatterns.some((r) => r.test(fileName)))
      ?? types.find((t) => t.pathPatterns.some((r) => r.test(filePath)));
    if (type) classifiedBy = "path";
  }
  if (!type) return { classifiedBy, reviewReason: "Could not tell what kind of document this is" };

  // Whose document?
  let entityId: number | undefined;
  let identifierId: number | undefined;
  if (type.identifierKind) {
    const hit = findIdentifiers(text, type.identifierKind, dir, false)[0] ?? findIdentifiers(filePath, type.identifierKind, dir, true)[0];
    if (hit) { entityId = hit.entityId; identifierId = hit.id; }
  }
  if (entityId === undefined) {
    const kinds = [...dir.kinds].sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
    for (const src of [{ t: text, upper: false }, { t: filePath, upper: true }]) {
      for (const k of kinds) {
        const hit = findIdentifiers(src.t, k.key, dir, src.upper)[0];
        if (hit) { entityId = hit.entityId; break; }
      }
      if (entityId !== undefined) break;
    }
    entityId ??= entityFromFolderNames(filePath, dir);
  }
  if (type.identifierKind && entityId !== undefined && identifierId === undefined) {
    const own = dir.idsOfEntity.get(entityId)?.get(type.identifierKind) ?? [];
    if (own.length === 1) identifierId = own[0];
  }

  // Which period?
  let period: Range | undefined;
  if (type.periodKind === "fy") {
    const fy = findFyStart(text, style, true) ?? findFyStart(filePath, style, true);
    if (fy !== undefined) period = fyRange(fy, style);
  } else if (type.periodKind === "month") {
    const fy = findFyStart(text, style, false) ?? findFyStart(filePath, style, false);
    period = findMonthPeriod(text, style, fy);
    for (const seg of filePath.split("/").reverse()) {
      if (period) break;
      if (dir.entityByName.has(normalizeName(seg))) continue; // a customer folder like "May Enterprises"
      period = findMonthPeriod(seg.replace(/[_.]/g, " "), style, fy, true);
    }
  }

  let reviewReason: string | undefined;
  if (entityId === undefined) reviewReason = "No matching customer found in the file or its folder";
  else if (type.identifierKind && identifierId === undefined) {
    const kind = dir.kinds.find((k) => k.key === type!.identifierKind)?.label ?? type.identifierKind;
    const count = dir.idsOfEntity.get(entityId)?.get(type.identifierKind)?.length ?? 0;
    reviewReason = count ? `Customer has several ${kind}s and this file doesn't say which one` : `Customer has no ${kind} on record`;
  } else if (type.periodKind !== "none" && !period) reviewReason = "Could not find the period (year/month)";

  return { docType: type.key, entityId, identifierId, period, classifiedBy, reviewReason };
}
