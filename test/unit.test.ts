import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS } from "../server/presets.js";
import { findDocTypes, parseWithRules } from "../server/docbot/intent.js";
import { findFyStart, findMonthPeriod } from "../server/docbot/classifier.js";
import { describePeriod, fyRange, periodSlug, todayIn } from "../server/docbot/periods.js";
import { normalizePhone, parseCsv, parseDate } from "../server/docbot/customers.js";
import { encryptJson, decryptJson } from "../server/crypto.js";
import { mergeSettings, BASE_SETTINGS, validateSettings } from "../server/settings.js";

const tax = PRESETS.find((p) => p.key === "tax_accounting_in")!;
const types = tax.docTypes.map((d) => ({
  key: d.key, label: d.label, periodKind: d.periodKind, identifierKind: d.identifierKind ?? null, aliases: d.aliases,
  textPatterns: [], pathPatterns: [], bundle: d.bundle ?? null, bundleOptional: d.bundleOptional ?? [], priority: d.priority ?? 100,
}));
const IN = { fyStartMonth: 4, showAssessmentYear: true };
const today = new Date(2026, 8, 27);

test("request words -> document types (longest match wins)", () => {
  const t = (m: string) => findDocTypes(m, types);
  assert.deepEqual(t("send my ITR"), ["ITR"]);
  assert.deepEqual(t("pichle saal ka itr bhejo"), ["ITR"]);
  assert.deepEqual(t("ITR-V please"), ["ITR_V"]);
  assert.deepEqual(t("gst certificate"), ["GST_CERT"]);
  assert.deepEqual(t("march ka gst"), ["GST_RETURN"]);
  assert.deepEqual(t("GSTR-3B for March"), ["GSTR3B"]);
  assert.deepEqual(t("gstr1 aug"), ["GSTR1"]);
  assert.deepEqual(t("26AS and Form 16"), ["FORM26AS", "FORM16"]);
  assert.deepEqual(t("ITR-1 form"), ["ITR_FORM"]);
  assert.deepEqual(t("P&L and balance sheet"), ["FINANCIALS"]);
});

test("periods from messages", () => {
  const p = (m: string) => parseWithRules(m, today, types, IN);
  assert.deepEqual(p("ITR AY 2025-26").periods, [{ kind: "ay", startYear: 2025 }]);
  assert.deepEqual(p("itr fy 24-25").periods, [{ kind: "fy", startYear: 2024 }]);
  assert.deepEqual(p("ITR 2024-2025").periods, [{ kind: "year", startYear: 2024 }]);
  assert.deepEqual(p("3b mar-26").periods, [{ kind: "month", month: 3, year: 2026 }]);
  assert.deepEqual(p("gst return last month").periods, [{ kind: "month", month: 8, year: 2026 }]);
  assert.deepEqual(p("may I get my ITR").periods, []);
  assert.deepEqual(p("may ka gst").periods, [{ kind: "month", month: 5, year: null }]);
  assert.equal(p("pichle teen saal ka itr").latestCount, 3);
  assert.equal(p("hello").action, "greeting");
  assert.equal(p("which documents do you have").action, "list_documents");
  // Without AY support, "AY" is treated as a plain year
  assert.deepEqual(parseWithRules("report AY 2025-26", today, types, { fyStartMonth: 4, showAssessmentYear: false }).periods, [{ kind: "year", startYear: 2025 }]);
});

test("periods in documents", () => {
  assert.equal(findFyStart("Assessment Year 2025-26 Previous Year 2024-25", IN), 2024);
  assert.equal(findFyStart("Year 2026-27\nPeriod August", IN, false), 2026);
  assert.deepEqual(findMonthPeriod("Year 2025-26\nPeriod March", IN, 2025), { start: "2026-03-01", end: "2026-03-31" });
  assert.deepEqual(findMonthPeriod("Return Period Jan-Mar", IN, 2025), { start: "2026-01-01", end: "2026-03-31" });
  assert.equal(findMonthPeriod("This may be amended in the market", IN, 2025), undefined);
  const cal = { fyStartMonth: 1, showAssessmentYear: false };
  assert.deepEqual(fyRange(2025, cal), { start: "2025-01-01", end: "2025-12-31" });
  assert.equal(findFyStart("Policy year 2025", cal), 2025);
});

test("labels", () => {
  assert.equal(describePeriod(fyRange(2024, IN), IN), "AY 2025-26 (FY 2024-25)");
  assert.equal(describePeriod(fyRange(2024, { fyStartMonth: 4, showAssessmentYear: false }), { fyStartMonth: 4, showAssessmentYear: false }), "FY 2024-25");
  assert.equal(periodSlug({ start: "2026-01-01", end: "2026-03-31" }, IN), "Jan-Mar2026");
  const d = todayIn("Asia/Kolkata", new Date("2026-03-31T20:00:00Z"));
  assert.equal(d.getMonth(), 3);
});

test("CSV helpers, secrets and settings", () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\r\n'), [["a", "b"], ["x, y", 'say "hi"']]);
  assert.equal(normalizePhone("+91-98123-45678"), "919812345678");
  assert.equal(normalizePhone("098123 45678"), "919812345678");
  assert.equal(parseDate("1/4/2010"), "2010-04-01");
  const blob = encryptJson({ token: "abc" });
  assert.ok(!blob.includes("abc"));
  assert.deepEqual(decryptJson(blob), { token: "abc" });
  const s = mergeSettings(BASE_SETTINGS, { businessName: "X", limits: { maxDocsPerHour: 5 }, unknownKey: 1 });
  assert.equal(s.limits.maxDocsPerRequest, 12);
  assert.ok(!("unknownKey" in s));
  assert.throws(() => validateSettings({ ...s, identifierKinds: [{ key: "bad key", label: "x" }] }));
});
