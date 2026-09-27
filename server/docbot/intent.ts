// Understanding a client's message: which documents, whose, which period.

import type { DocType } from "./types.js";
import type { YearStyle } from "./periods.js";

export type PeriodSpec =
  | { kind: "ay" | "fy" | "year"; startYear: number } // "year" = a range like 2024-25 without saying FY/AY
  | { kind: "month"; month: number; year?: number | null };

export interface Intent {
  action: "get_documents" | "list_documents" | "greeting" | "help" | "other";
  docTypes: string[];          // document type or bundle keys
  entityHint?: string | null;  // business/person named in the message
  periods: PeriodSpec[];       // empty = latest available
  latestCount?: number | null; // "last 3 years" -> 3
}

const MONTHS: [RegExp, number][] = [
  [/\bjan(uary)?\b/, 1], [/\bfeb(ruary)?\b/, 2], [/\bmar(ch)?\b/, 3], [/\bapr(il)?\b/, 4], [/\bmay\b/, 5],
  [/\bjune?\b/, 6], [/\bjuly?\b/, 7], [/\baug(ust)?\b/, 8], [/\bsep(t|tember)?\b/, 9], [/\boct(ober)?\b/, 10],
  [/\bnov(ember)?\b/, 11], [/\bdec(ember)?\b/, 12],
];

export const normalizeText = (s: string) =>
  s.toLowerCase().replace(/[’'`]/g, "").replace(/[-_./,:;!?()]+/g, " ").replace(/\s+/g, " ").trim();

/** Document types named in the message. A shorter match inside a longer one is dropped ("gst" in "gst certificate"). */
export function findDocTypes(message: string, types: DocType[]): string[] {
  const n = normalizeText(message);
  const spans: { key: string; start: number; end: number }[] = [];
  for (const t of types) {
    for (const alias of t.aliases) {
      const a = normalizeText(alias);
      if (!a) continue;
      const re = new RegExp(`(?<![a-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "g");
      for (const m of n.matchAll(re)) spans.push({ key: t.key, start: m.index!, end: m.index! + m[0].length });
    }
  }
  const kept = spans.filter((s) => !spans.some((o) => o !== s && o.key !== s.key && o.start <= s.start && o.end >= s.end
    && o.end - o.start > s.end - s.start));
  kept.sort((a, b) => a.start - b.start);
  return [...new Set(kept.map((s) => s.key))];
}

export function parseWithRules(message: string, today: Date, types: DocType[], style: YearStyle): Intent {
  const m = message.toLowerCase().replace(/[’']/g, "").trim();

  if (/^(hi+|hello|hey|namaste|namaskar|good\s+(morning|afternoon|evening))[\s!.]*$/.test(m)) return { action: "greeting", docTypes: [], periods: [] };
  if (/^(help|menu|\?|options|start)$/.test(m)) return { action: "help", docTypes: [], periods: [] };
  if (/(what|which|kaun|konse).*(documents?|docs|files)|list.*(documents?|docs)/.test(m)) return { action: "list_documents", docTypes: [], periods: [] };

  const docTypes = findDocTypes(message, types);
  const periods: PeriodSpec[] = [];
  let latestCount: number | null = null;

  for (const y of m.matchAll(/\b(a\.?y\.?|f\.?y\.?)?\s*(20)?(\d{2})\s*[-/–]\s*(20)?(\d{2})\b/g)) {
    const start = 2000 + Number(y[3]);
    if (2000 + Number(y[5]) !== start + 1) continue;
    const label = y[1]?.replace(/\./g, "");
    const kind = label === "ay" && style.showAssessmentYear ? "ay" : label === "fy" ? "fy" : "year";
    periods.push({ kind, startYear: start });
  }
  if (!periods.length && style.fyStartMonth === 1) {
    for (const y of m.matchAll(/\b(20\d{2})\b/g)) periods.push({ kind: "fy", startYear: Number(y[1]) });
  }

  if (!periods.length) {
    for (const [re, month] of MONTHS) {
      const hit = re.exec(m);
      if (!hit) continue;
      const after = m.slice(hit.index + hit[0].length);
      const yr = /^\s*[-,']?\s*(20)?(\d{2})\b/.exec(after);
      // "may" is usually the verb ("may I get..."): only count it with a year or "of/for May" / "May ka".
      if (month === 5 && !yr && !/\b(of|for|in)\s+$/.test(m.slice(0, hit.index)) && !/^\s+(ka|ki|ke|month|mahine)\b/.test(after)) continue;
      periods.push({ kind: "month", month, year: yr ? 2000 + Number(yr[2]) : null });
    }
  }

  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, do: 2, teen: 3, char: 4, paanch: 5 };
  const n = /\b(last|past|pichle|previous)\s+(\d|two|three|four|five|do|teen|char|paanch)\s*(years?|saal|sal|yrs?)\b/.exec(m);
  if (!periods.length && n) latestCount = Number(n[2]) || words[n[2]] || null;
  if (!periods.length && /\b(last|pichle|previous|pichla)\s+(month|mahine|mahina)\b/.test(m)) {
    const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    periods.push({ kind: "month", month: d.getMonth() + 1, year: d.getFullYear() });
  }
  if (!periods.length && /\b(this|is)\s+(month|mahine)\b/.test(m)) {
    periods.push({ kind: "month", month: today.getMonth() + 1, year: today.getFullYear() });
  }

  if (!docTypes.length) return { action: "other", docTypes, periods, latestCount };
  return { action: "get_documents", docTypes, periods, latestCount, entityHint: null };
}
