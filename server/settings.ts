// Per-workspace configuration. Everything here is editable in the dashboard.

export interface IdentifierKind {
  key: string;          // "PAN", "GSTIN", "CUSTOMER_ID"
  label: string;
  pattern?: string;     // regex to spot it in documents; without one, known values are searched literally
  primary?: boolean;    // the customer's main ID (used in PDF passwords)
  selectable?: boolean; // customers may hold several and pick one (e.g. GSTINs per state)
}

export interface OrgSettings {
  businessName: string;
  officeContact: string;
  timezone: string;
  fyStartMonth: number;          // 4 = April (Indian financial year), 1 = calendar year
  showAssessmentYear: boolean;   // Indian income-tax "AY" labels
  bareYearMeans: "fy" | "ay";    // client writes "2024-25" without saying which
  identifierKinds: IdentifierKind[];
  entityTypes: string[];
  keyDateLabel: string;
  pdfPassword: { mode: "id_date" | "id" | "none" };
  limits: { maxDocsPerHour: number; maxDocsPerRequest: number };
  staffPhones: string[];
  welcomeMessage: string;        // first line of the help reply; empty = default
  examples: string[];            // example requests shown to clients
  ai: { enabled: boolean; classifyDocuments: boolean };
  whatsapp: { phoneNumberId: string; businessAccountId: string; displayNumber: string; templateName: string; templateLang: string };
  storage: { driver: "upload" | "google_drive"; driveId: string };
}

export interface OrgSecrets {
  waAccessToken?: string;
  waAppSecret?: string;
  waVerifyToken?: string;
  googleServiceAccount?: string; // JSON key file contents
  anthropicApiKey?: string;
}
export const SECRET_KEYS: (keyof OrgSecrets)[] = ["waAccessToken", "waAppSecret", "waVerifyToken", "googleServiceAccount", "anthropicApiKey"];

export const BASE_SETTINGS: OrgSettings = {
  businessName: "",
  officeContact: "",
  timezone: "Asia/Kolkata",
  fyStartMonth: 4,
  showAssessmentYear: false,
  bareYearMeans: "fy",
  identifierKinds: [{ key: "CUSTOMER_ID", label: "Customer ID", primary: true }],
  entityTypes: ["individual", "business"],
  keyDateLabel: "Date of birth",
  pdfPassword: { mode: "id_date" },
  limits: { maxDocsPerHour: 20, maxDocsPerRequest: 12 },
  staffPhones: [],
  welcomeMessage: "",
  examples: [],
  ai: { enabled: true, classifyDocuments: false },
  whatsapp: { phoneNumberId: "", businessAccountId: "", displayNumber: "", templateName: "document_ready", templateLang: "en" },
  storage: { driver: "upload", driveId: "" },
};

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => !!v && typeof v === "object" && !Array.isArray(v);

/** Deep merge for nested setting objects; arrays and scalars are replaced. */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isPlain(base) || !isPlain(patch)) return (patch === undefined ? base : patch) as T;
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in base)) continue; // ignore unknown keys
    out[k] = isPlain((base as Plain)[k]) ? mergeSettings((base as Plain)[k], v) : v;
  }
  return out as T;
}

/** Throws with a readable message if the settings are invalid. */
export function validateSettings(s: OrgSettings) {
  const fail = (m: string) => { throw new Error(m); };
  if (!s.businessName?.trim()) fail("Business name is required");
  if (!(Number.isInteger(s.fyStartMonth) && s.fyStartMonth >= 1 && s.fyStartMonth <= 12)) fail("Year start month must be 1–12");
  if (!["fy", "ay"].includes(s.bareYearMeans)) fail("Year convention must be FY or AY");
  if (!["id_date", "id", "none"].includes(s.pdfPassword.mode)) fail("Unknown PDF password mode");
  if (!["upload", "google_drive"].includes(s.storage.driver)) fail("Unknown storage");
  const n = (v: unknown) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 1000;
  if (!n(s.limits.maxDocsPerHour) || !n(s.limits.maxDocsPerRequest)) fail("Limits must be whole numbers 1–1000");
  if (!Array.isArray(s.identifierKinds) || !s.identifierKinds.length) fail("At least one ID type is needed");
  const keys = new Set<string>();
  for (const k of s.identifierKinds) {
    if (!/^[A-Z][A-Z0-9_]{0,30}$/.test(k.key)) fail(`ID type key "${k.key}" must be CAPITALS_AND_UNDERSCORES`);
    if (keys.has(k.key)) fail(`Duplicate ID type ${k.key}`);
    keys.add(k.key);
    if (k.pattern) try { new RegExp(k.pattern); } catch { fail(`Pattern for ${k.key} is not a valid regular expression`); }
  }
  if (s.identifierKinds.filter((k) => k.primary).length > 1) fail("Only one ID type can be the main one");
  for (const p of s.staffPhones) if (!/^\d{11,15}$/.test(p)) fail(`Staff number ${p} must include the country code, digits only`);
}
