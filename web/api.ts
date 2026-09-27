// Small fetch wrapper for the dashboard API.

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function call<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "x-requested-with": "eedbe" };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload, credentials: "same-origin" });
  const type = res.headers.get("content-type") ?? "";
  const data: any = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  get: <T = any>(u: string) => call<T>("GET", u),
  post: <T = any>(u: string, b?: unknown) => call<T>("POST", u, b ?? {}),
  put: <T = any>(u: string, b?: unknown) => call<T>("PUT", u, b ?? {}),
  patch: <T = any>(u: string, b?: unknown) => call<T>("PATCH", u, b ?? {}),
  del: <T = any>(u: string) => call<T>("DELETE", u),
};

// ---------- shared types

export interface IdentifierKind { key: string; label: string; pattern?: string; primary?: boolean; selectable?: boolean }
export interface Settings {
  businessName: string; officeContact: string; timezone: string; fyStartMonth: number; showAssessmentYear: boolean;
  bareYearMeans: "fy" | "ay"; identifierKinds: IdentifierKind[]; entityTypes: string[]; keyDateLabel: string;
  pdfPassword: { mode: "id_date" | "id" | "none" }; limits: { maxDocsPerHour: number; maxDocsPerRequest: number };
  staffPhones: string[]; welcomeMessage: string; examples: string[]; ai: { enabled: boolean; classifyDocuments: boolean };
  whatsapp: { phoneNumberId: string; businessAccountId: string; displayNumber: string; templateName: string; templateLang: string };
  storage: { driver: "upload" | "google_drive"; driveId: string };
}
export interface OrgInfo {
  id: string; name: string; industry: string; role: "owner" | "admin" | "staff"; settings: Settings;
  secrets: Record<string, { set: boolean; preview: string }>; features: Record<string, boolean>; webhookUrl: string;
  aiAvailable: boolean; platformAiKey: boolean;
}
export interface DocType {
  key: string; label: string; period_kind: "none" | "month" | "fy"; identifier_kind: string | null; aliases: string[];
  text_patterns: string[]; path_patterns: string[]; bundle: string[] | null; bundle_optional: string[]; priority: number; active: boolean; documents: number;
}
