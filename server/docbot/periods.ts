// Periods. Every document has a date range:
//   yearly docs  -> the financial year (starts in settings.fyStartMonth; April in India)
//   monthly docs -> that month (quarterly returns cover their quarter)
// A request matches a document when their ranges overlap.

export interface Range { start: string; end: string } // YYYY-MM-DD

export interface YearStyle {
  fyStartMonth: number;        // 1..12
  showAssessmentYear: boolean; // Indian income tax: AY = FY + 1
}

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");

export const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const monthRange = (y: number, m: number): Range => ({ start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDay(y, m))}` });

export function monthsRange(y1: number, m1: number, y2: number, m2: number): Range {
  return { start: monthRange(y1, m1).start, end: monthRange(y2, m2).end };
}

/** Financial year beginning in `startYear`. With a January start it's the calendar year. */
export function fyRange(startYear: number, style: YearStyle): Range {
  const m = style.fyStartMonth;
  if (m === 1) return { start: `${startYear}-01-01`, end: `${startYear}-12-31` };
  const endMonth = m - 1;
  return { start: `${startYear}-${pad(m)}-01`, end: `${startYear + 1}-${pad(endMonth)}-${pad(lastDay(startYear + 1, endMonth))}` };
}

export const fyStartOf = (d: Date, style: YearStyle) =>
  d.getMonth() + 1 >= style.fyStartMonth ? d.getFullYear() : d.getFullYear() - 1;

/** Year of month `m` inside the FY that starts in `fyStart`. */
export const yearOfMonthInFy = (m: number, fyStart: number, style: YearStyle) =>
  m >= style.fyStartMonth ? fyStart : fyStart + 1;

const yy = (y: number) => pad(y % 100);
export function fyLabel(startYear: number, style: YearStyle) {
  if (style.fyStartMonth === 1) return String(startYear);
  return `FY ${startYear}-${yy(startYear + 1)}`;
}
export function ayLabel(fyStart: number) {
  return `AY ${fyStart + 1}-${yy(fyStart + 2)}`;
}

/** Is this range exactly one financial year? Returns its start year. */
export function fyOfRange(r: Range, style: YearStyle): number | undefined {
  const y = Number(r.start.slice(0, 4));
  const f = fyRange(y, style);
  return f.start === r.start && f.end === r.end ? y : undefined;
}

export function describePeriod(r: { start: string | null; end: string | null }, style: YearStyle) {
  if (!r.start || !r.end) return "";
  const fy = fyOfRange(r as Range, style);
  if (fy !== undefined) return style.showAssessmentYear ? `${ayLabel(fy)} (${fyLabel(fy, style)})` : fyLabel(fy, style);
  const [sy, sm] = r.start.split("-").map(Number);
  const [ey, em] = r.end.split("-").map(Number);
  if (sy === ey && sm === em) return `${MONTH_NAMES[sm - 1]} ${sy}`;
  return `${MONTH_NAMES[sm - 1].slice(0, 3)}–${MONTH_NAMES[em - 1].slice(0, 3)} ${ey}`;
}

/** Short form for file names: AY2025-26, FY2024-25, Mar2026, Jan-Mar2026. */
export function periodSlug(r: { start: string | null; end: string | null }, style: YearStyle) {
  if (!r.start || !r.end) return "";
  const fy = fyOfRange(r as Range, style);
  if (fy !== undefined) {
    if (style.showAssessmentYear) return `AY${fy + 1}-${yy(fy + 2)}`;
    return style.fyStartMonth === 1 ? String(fy) : `FY${fy}-${yy(fy + 1)}`;
  }
  const [sy, sm] = r.start.split("-").map(Number);
  const [ey, em] = r.end.split("-").map(Number);
  const mon = (m: number) => MONTH_NAMES[m - 1].slice(0, 3);
  return sy === ey && sm === em ? `${mon(sm)}${sy}` : `${mon(sm)}-${mon(em)}${ey}`;
}

/** Today in the workspace's timezone, as a local Date at midnight. */
export function todayIn(timezone: string, now = new Date()): Date {
  const s = now.toLocaleDateString("en-CA", { timeZone: timezone || "Asia/Kolkata" });
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
