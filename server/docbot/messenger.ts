// Sending messages. WhatsAppMessenger talks to Meta's Cloud API; RecordingMessenger backs the
// dashboard's test chat and the automated tests.

import crypto from "node:crypto";
import { platform } from "../env.js";
import type { OrgSecrets, OrgSettings } from "../settings.js";

export interface ListRow { id: string; title: string; description?: string }

export interface Messenger {
  readonly simulated: boolean;
  sendText(to: string, text: string): Promise<void>;
  sendList(to: string, body: string, button: string, rows: ListRow[]): Promise<void>;
  sendDocument(to: string, file: Uint8Array, filename: string, caption: string): Promise<void>;
  /** Document outside WhatsApp's 24-hour window, via an approved template with a document header. */
  sendDocumentTemplate(to: string, file: Uint8Array, filename: string, docLabel: string): Promise<void>;
}

export type Outgoing =
  | { to: string; kind: "text"; text: string }
  | { to: string; kind: "list"; text: string; rows: ListRow[] }
  | { to: string; kind: "document"; filename: string; caption: string; file: Uint8Array; template?: boolean };

export class RecordingMessenger implements Messenger {
  sent: Outgoing[] = [];
  /** simulated=false lets tests stand in for real WhatsApp delivery. */
  constructor(readonly simulated = true) {}
  async sendText(to: string, text: string) { this.sent.push({ to, kind: "text", text }); }
  async sendList(to: string, text: string, _b: string, rows: ListRow[]) { this.sent.push({ to, kind: "list", text, rows }); }
  async sendDocument(to: string, file: Uint8Array, filename: string, caption: string) { this.sent.push({ to, kind: "document", filename, caption, file }); }
  async sendDocumentTemplate(to: string, file: Uint8Array, filename: string, caption: string) {
    this.sent.push({ to, kind: "document", filename, caption, file, template: true });
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export class WhatsAppMessenger implements Messenger {
  readonly simulated = false;
  private base: string;
  constructor(private settings: OrgSettings, private secrets: OrgSecrets) {
    this.base = `${platform.whatsappApiBase}/${settings.whatsapp.phoneNumberId}`;
  }

  private async call(path: string, init: RequestInit) {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.secrets.waAccessToken}`, ...(init.headers ?? {}) },
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp: ${body?.error?.message ?? res.status}`);
    return body;
  }
  private send(to: string, msg: Record<string, unknown>) {
    return this.call("/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...msg }),
    });
  }
  private async upload(file: Uint8Array, filename: string) {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "application/pdf");
    form.append("file", new Blob([new Uint8Array(file)], { type: "application/pdf" }), filename);
    return (await this.call("/media", { method: "POST", body: form })).id as string;
  }

  async sendText(to: string, text: string) {
    await this.send(to, { type: "text", text: { body: clip(text, 4096), preview_url: false } });
  }
  async sendList(to: string, body: string, button: string, rows: ListRow[]) {
    await this.send(to, {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: clip(body, 1024) },
        action: {
          button: clip(button, 20),
          sections: [{ title: "Choose one", rows: rows.slice(0, 10).map((r) => ({
            id: r.id, title: clip(r.title, 24), ...(r.description ? { description: clip(r.description, 72) } : {}),
          })) }],
        },
      },
    });
  }
  async sendDocument(to: string, file: Uint8Array, filename: string, caption: string) {
    const id = await this.upload(file, filename);
    await this.send(to, { type: "document", document: { id, filename, caption: clip(caption, 1024) } });
  }
  async sendDocumentTemplate(to: string, file: Uint8Array, filename: string, docLabel: string) {
    const id = await this.upload(file, filename);
    await this.send(to, {
      type: "template",
      template: {
        name: this.settings.whatsapp.templateName,
        language: { code: this.settings.whatsapp.templateLang },
        components: [
          { type: "header", parameters: [{ type: "document", document: { id, filename } }] },
          { type: "body", parameters: [{ type: "text", text: clip(docLabel, 60) }] },
        ],
      },
    });
  }

  /** Dashboard "check connection": reads the number's details. */
  async status() {
    return this.call("?fields=display_phone_number,verified_name,quality_rating,code_verification_status", { method: "GET" });
  }
  /** Sends Meta's built-in hello_world template (works for test numbers without an open chat). */
  async sendHelloWorld(to: string) {
    return this.send(to, { type: "template", template: { name: "hello_world", language: { code: "en_US" } } });
  }
}

export function verifySignature(appSecret: string | undefined, rawBody: Uint8Array, header: string | undefined) {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export interface Incoming { id: string; from: string; name?: string; text?: string; replyId?: string; type: string }

export function parseWebhook(body: any, phoneNumberId: string): Incoming[] {
  const out: Incoming[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (phoneNumberId && v?.metadata?.phone_number_id && v.metadata.phone_number_id !== phoneNumberId) continue;
      const names = new Map<string, string>((v?.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
      for (const m of v?.messages ?? []) {
        const msg: Incoming = { id: m.id, from: m.from, name: names.get(m.from), type: m.type };
        if (m.type === "text") msg.text = m.text?.body;
        if (m.type === "interactive") {
          const r = m.interactive?.list_reply ?? m.interactive?.button_reply;
          msg.replyId = r?.id;
          msg.text = r?.title;
        }
        if (m.type === "button") msg.text = m.button?.text;
        out.push(msg);
      }
    }
  }
  return out;
}
