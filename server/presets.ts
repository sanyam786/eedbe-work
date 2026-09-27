// Starting points for a new workspace. Everything they set can be changed later in the dashboard.

import { BASE_SETTINGS, mergeSettings, type OrgSettings } from "./settings.js";

export interface DocTypeDef {
  key: string;
  label: string;
  periodKind: "none" | "month" | "fy";
  identifierKind?: string | null;
  aliases: string[];
  textPatterns?: string[];
  pathPatterns?: string[];
  bundle?: string[] | null;
  bundleOptional?: string[];
  priority?: number;
  active?: boolean;
}

export interface Preset {
  key: string;
  label: string;
  description: string;
  settings: Partial<OrgSettings>;
  docTypes: DocTypeDef[];
}

const PAN = "[A-Z]{5}[0-9]{4}[A-Z]";
const GSTIN = "[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]";

const TAX_IN: Preset = {
  key: "tax_accounting_in",
  label: "CA / tax & accounting firm (India)",
  description: "ITR, computation, Form 16, 26AS, AIS, GST returns, audit reports. Clients identified by PAN and GSTIN.",
  settings: {
    fyStartMonth: 4,
    showAssessmentYear: true,
    bareYearMeans: "fy",
    identifierKinds: [
      { key: "PAN", label: "PAN", pattern: PAN, primary: true },
      { key: "GSTIN", label: "GSTIN", pattern: GSTIN, selectable: true },
    ],
    entityTypes: ["individual", "firm", "company", "llp", "huf", "trust", "other"],
    keyDateLabel: "Date of birth / incorporation",
    pdfPassword: { mode: "id_date" },
    examples: ["ITR of last year", "Last 3 years ITR", "GSTR-3B for March", "Form 16 2024-25", "Computation AY 2025-26"],
  },
  docTypes: [
    { key: "ITR_V", label: "ITR acknowledgement (ITR-V)", periodKind: "fy", priority: 10,
      aliases: ["itr v", "itrv", "acknowledgement", "acknowledgment", "ack"],
      textPatterns: ["INCOME\\s+TAX\\s+RETURN\\s+ACKNOWLEDGE?MENT", "\\bITR[\\s-]*V\\b"],
      pathPatterns: ["itr[\\s_-]*v\\b", "acknowledg", "\\back\\b"] },
    { key: "COMPUTATION", label: "Computation of income", periodKind: "fy", priority: 20,
      aliases: ["computation", "computation of income", "comp", "coi"],
      textPatterns: ["COMPUTATION\\s+OF\\s+(TOTAL\\s+)?(TAXABLE\\s+)?INCOME", "STATEMENT\\s+OF\\s+(TOTAL\\s+)?INCOME"],
      pathPatterns: ["computation", "\\bcomp\\b", "\\bcoi\\b"] },
    { key: "FORM16", label: "Form 16", periodKind: "fy", priority: 30,
      aliases: ["form 16", "form16"],
      textPatterns: ["FORM\\s*(NO\\.?)?\\s*16\\b(?!\\s*A)"], pathPatterns: ["form[\\s_-]*16(?!a)"] },
    { key: "TAX_AUDIT", label: "Tax audit report", periodKind: "fy", priority: 40,
      aliases: ["tax audit", "audit report", "3cd", "3ca", "3cb"],
      textPatterns: ["FORM\\s*(NO\\.?)?\\s*3C[ABD]\\b"], pathPatterns: ["3c[abd]", "tax[\\s_-]*audit"] },
    { key: "AIS", label: "AIS", periodKind: "fy", priority: 50,
      aliases: ["ais", "annual information statement"],
      textPatterns: ["ANNUAL\\s+INFORMATION\\s+STATEMENT"], pathPatterns: ["\\bais\\b"] },
    { key: "FORM26AS", label: "Form 26AS", periodKind: "fy", priority: 60,
      aliases: ["26as", "26 as", "form 26as", "form 26 as", "tax credit statement"],
      textPatterns: ["FORM\\s*26\\s*AS", "ANNUAL\\s+TAX\\s+STATEMENT"], pathPatterns: ["26[\\s_-]*as"] },
    { key: "ITR_FORM", label: "ITR form", periodKind: "fy", priority: 70,
      aliases: ["itr form", "full itr", "itr 1", "itr 2", "itr 3", "itr 4", "itr 5", "itr 6", "itr 7"],
      textPatterns: ["INDIAN\\s+INCOME\\s+TAX\\s+RETURN", "\\bITR[\\s-]*[1-7]\\b", "\\bSAHAJ\\b|\\bSUGAM\\b"],
      pathPatterns: ["\\bitr[\\s_-]*[1-7]\\b", "\\bitr\\b"] },
    { key: "GSTR9C", label: "GSTR-9C", periodKind: "fy", identifierKind: "GSTIN", priority: 80,
      aliases: ["gstr 9c", "gstr9c", "9c"], textPatterns: ["GSTR[\\s-]*9C\\b"], pathPatterns: ["gstr[\\s_-]*9c", "\\b9c\\b"] },
    { key: "GSTR9", label: "GSTR-9 (annual return)", periodKind: "fy", identifierKind: "GSTIN", priority: 90,
      aliases: ["gstr 9", "gstr9", "gst annual return", "annual return"],
      textPatterns: ["GSTR[\\s-]*9\\b(?!C)"], pathPatterns: ["gstr[\\s_-]*9(?!c)\\b"] },
    { key: "GSTR3B", label: "GSTR-3B", periodKind: "month", identifierKind: "GSTIN", priority: 100,
      aliases: ["gstr 3b", "gstr3b", "3b"], textPatterns: ["GSTR[\\s-]*3B\\b"], pathPatterns: ["gstr[\\s_-]*3b", "\\b3b\\b"] },
    { key: "GSTR1", label: "GSTR-1", periodKind: "month", identifierKind: "GSTIN", priority: 110,
      aliases: ["gstr 1", "gstr1", "r1"], textPatterns: ["GSTR[\\s-]*1\\b"], pathPatterns: ["gstr[\\s_-]*1\\b", "\\bgstr1\\b"] },
    { key: "GST_CERT", label: "GST registration certificate", periodKind: "none", identifierKind: "GSTIN", priority: 120,
      aliases: ["gst certificate", "gst cert", "gst registration", "registration certificate", "reg 06"],
      textPatterns: ["REG[\\s-]*06\\b", "REGISTRATION\\s+CERTIFICATE"], pathPatterns: ["reg[\\s_-]*06", "gst[\\s_-]*cert"] },
    { key: "FINANCIALS", label: "Balance sheet & P&L", periodKind: "fy", priority: 130,
      aliases: ["balance sheet", "p&l", "p & l", "profit and loss", "profit & loss", "financials", "financial statements"],
      textPatterns: ["BALANCE\\s+SHEET"], pathPatterns: ["balance[\\s_-]*sheet", "financial"] },
    // Request words that send several types
    { key: "ITR", label: "ITR (acknowledgement + computation)", periodKind: "fy", priority: 500,
      aliases: ["itr", "itrs", "income tax return", "tax return"],
      bundle: ["ITR_V", "COMPUTATION"], bundleOptional: ["COMPUTATION"] },
    { key: "GST_RETURN", label: "GST return (GSTR-3B)", periodKind: "month", identifierKind: "GSTIN", priority: 510,
      aliases: ["gst", "gst return", "gst returns", "gst filing"], bundle: ["GSTR3B"] },
  ],
};

const GENERAL: Preset = {
  key: "general",
  label: "Any other business",
  description: "Start with invoices, statements, certificates and reports, then add your own document types.",
  settings: {
    identifierKinds: [{ key: "CUSTOMER_ID", label: "Customer ID", primary: true }],
    entityTypes: ["individual", "business"],
    keyDateLabel: "Date of birth",
    pdfPassword: { mode: "id_date" },
    examples: ["Invoice for March", "Latest statement", "My certificate"],
  },
  docTypes: [
    { key: "INVOICE", label: "Invoice", periodKind: "month", priority: 10, aliases: ["invoice", "invoices", "bill"],
      textPatterns: ["\\bTAX\\s+INVOICE\\b", "\\bINVOICE\\b"], pathPatterns: ["invoice", "\\bbill\\b"] },
    { key: "STATEMENT", label: "Statement", periodKind: "month", priority: 20, aliases: ["statement", "account statement", "ledger"],
      textPatterns: ["\\bSTATEMENT\\s+OF\\s+ACCOUNT\\b", "\\bSTATEMENT\\b"], pathPatterns: ["statement", "ledger"] },
    { key: "CERTIFICATE", label: "Certificate", periodKind: "none", priority: 30, aliases: ["certificate", "cert"],
      textPatterns: ["\\bCERTIFICATE\\b"], pathPatterns: ["certificate", "\\bcert\\b"] },
    { key: "REPORT", label: "Report", periodKind: "none", priority: 40, aliases: ["report"],
      textPatterns: ["\\bREPORT\\b"], pathPatterns: ["report"] },
  ],
};

export const PRESETS: Preset[] = [TAX_IN, GENERAL];
export const presetByKey = (k: string) => PRESETS.find((p) => p.key === k);

export function initialSettings(preset: Preset, businessName: string): OrgSettings {
  return mergeSettings(mergeSettings(BASE_SETTINGS, preset.settings), { businessName });
}
