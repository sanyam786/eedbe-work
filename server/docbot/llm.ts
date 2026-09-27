// Claude reads client messages (and, optionally, unrecognised documents).
// For messages it receives only the text and the names of that client's own businesses —
// never ID numbers or documents.

import Anthropic from "@anthropic-ai/sdk";
import { platform } from "../env.js";
import type { OrgSettings, OrgSecrets } from "../settings.js";
import type { Intent } from "./intent.js";
import type { DocType, Directory } from "./types.js";
import type { Classification } from "./classifier.js";
import { fyRange, isoDate, monthRange, MONTH_NAMES, type YearStyle } from "./periods.js";

const clients = new Map<string, Anthropic>();
export function aiKey(settings: OrgSettings, secrets: OrgSecrets) {
  if (!settings.ai.enabled) return undefined;
  return secrets.anthropicApiKey || platform.anthropicApiKey || undefined;
}
function client(key: string) {
  let c = clients.get(key);
  if (!c) clients.set(key, (c = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 15_000 })));
  return c;
}

export async function parseIntentWithAi(key: string, message: string, names: string[], today: Date,
                                       types: DocType[], settings: OrgSettings): Promise<Intent> {
  const style = settings;
  const typeList = types.map((t) => `${t.key}: ${t.label}${t.aliases.length ? ` (clients say: ${t.aliases.slice(0, 6).join(", ")})` : ""}`).join("\n");
  const yearRules = style.showAssessmentYear
    ? `Financial year (FY) starts in ${MONTH_NAMES[style.fyStartMonth - 1]}. Assessment year (AY) = FY + 1: income of FY 2024-25 is assessed in AY 2025-26.`
    : style.fyStartMonth === 1 ? "Years are calendar years." : `The financial year starts in ${MONTH_NAMES[style.fyStartMonth - 1]}.`;
  const system = `You read WhatsApp messages sent to ${settings.businessName || "a business"} by its customers and record which documents they want. Messages may be in English, Hindi, Hinglish or other Indian languages, with typos.

Today is ${isoDate(today)}. ${yearRules}

Document types (use these keys):
${typeList}

Rules:
- Only use a type the customer asked for. Prefer the most specific type that fits.
- periods: only what was explicitly asked. kind "ay" if they said AY/assessment year, "fy" if FY/financial year, "year" for a bare range like 2024-25. A month without a year: kind "month", year null. Resolve relative months ("last month") with today's date.
- "latest", "last year's", "pichle saal ka" -> periods [] (the latest one is sent). "last 3 years" -> periods [], latestCount 3.
- entityHint: only if the message names one of the customer's businesses/people listed below.
- Only greetings -> "greeting". Asking what documents exist -> "list_documents". How to use this -> "help". Not about getting documents -> "other".

The customer's businesses/people: ${names.map((n) => `"${n}"`).join(", ") || "(one)"}`;

  const res = await client(key).messages.create({
    model: platform.anthropicModel,
    max_tokens: 400,
    system,
    tools: [{
      name: "record_request",
      description: "Record what the customer is asking for.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get_documents", "list_documents", "greeting", "help", "other"] },
          docTypes: { type: "array", items: { type: "string", enum: types.map((t) => t.key) } },
          entityHint: { type: ["string", "null"] },
          periods: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["ay", "fy", "year", "month"] },
                startYear: { type: "integer" },
                month: { type: "integer", minimum: 1, maximum: 12 },
                year: { type: ["integer", "null"] },
              },
              required: ["kind"],
            },
          },
          latestCount: { type: ["integer", "null"] },
        },
        required: ["action", "docTypes", "periods"],
      },
    }],
    tool_choice: { type: "tool", name: "record_request" },
    messages: [{ role: "user", content: message.slice(0, 1000) }],
  });
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("no tool call");
  const r = block.input as any;
  const known = new Set(types.map((t) => t.key));
  return {
    action: r.action,
    docTypes: (Array.isArray(r.docTypes) ? r.docTypes : []).filter((k: string) => known.has(k)),
    entityHint: r.entityHint ?? null,
    periods: (Array.isArray(r.periods) ? r.periods : []).filter((p: any) =>
      (p.kind === "month" && p.month >= 1 && p.month <= 12) || (p.kind !== "month" && Number.isInteger(p.startYear))),
    latestCount: Number.isInteger(r.latestCount) ? r.latestCount : null,
  };
}

/** Second opinion for files the rules couldn't place. IDs must match a known customer. */
export async function classifyWithAi(key: string, text: string, filePath: string, types: DocType[], dir: Directory,
                                     style: YearStyle, prior: Classification): Promise<Classification | undefined> {
  try {
    const res = await client(key).messages.create({
      model: platform.anthropicModel,
      max_tokens: 300,
      tools: [{
        name: "classify_document",
        description: "Record what this document is.",
        input_schema: {
          type: "object",
          properties: {
            docType: { type: ["string", "null"], enum: [...types.map((t) => t.key), null] },
            identifiers: { type: "array", items: { type: "string" }, description: "ID numbers of the customer this document belongs to" },
            fyStartYear: { type: ["integer", "null"] },
            month: { type: ["integer", "null"] },
            year: { type: ["integer", "null"] },
          },
          required: ["docType"],
        },
      }],
      tool_choice: { type: "tool", name: "classify_document" },
      messages: [{ role: "user", content: `ID types used: ${dir.kinds.map((k) => k.label).join(", ")}\nFile path: ${filePath}\n\nText:\n${text.slice(0, 6000)}` }],
    });
    const b = res.content.find((x) => x.type === "tool_use");
    if (!b || b.type !== "tool_use") return undefined;
    const r = b.input as any;
    const type = types.find((t) => t.key === (r.docType ?? prior.docType));
    if (!type) return undefined;
    let entityId = prior.entityId, identifierId = prior.identifierId;
    for (const v of (r.identifiers ?? []) as string[]) {
      for (const [kind, map] of dir.byValue) {
        const hit = map.get(String(v).toUpperCase());
        if (!hit) continue;
        entityId ??= hit.entityId;
        if (kind === type.identifierKind) identifierId ??= hit.id;
      }
    }
    if (type.identifierKind && entityId !== undefined && identifierId === undefined) {
      const own = dir.idsOfEntity.get(entityId)?.get(type.identifierKind) ?? [];
      if (own.length === 1) identifierId = own[0];
    }
    let period = prior.period;
    if (!period && type.periodKind === "fy" && r.fyStartYear) period = fyRange(r.fyStartYear, style);
    if (!period && type.periodKind === "month" && r.month && r.year) period = monthRange(r.year, r.month);
    let reviewReason: string | undefined;
    if (entityId === undefined) reviewReason = "No matching customer (checked by AI)";
    else if (type.identifierKind && identifierId === undefined) reviewReason = "Which registration is unclear (checked by AI)";
    else if (type.periodKind !== "none" && !period) reviewReason = "Period unclear (checked by AI)";
    return { docType: type.key, entityId, identifierId, period, classifiedBy: "ai", reviewReason };
  } catch (e) {
    console.error("[ai] classify failed:", (e as Error).message);
    return undefined;
  }
}
