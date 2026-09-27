import crypto from "node:crypto";
import { platform } from "./env.js";

let devKeyWarned = false;
function key() {
  let k = platform.encryptionKey;
  if (!k) {
    if (platform.isProduction) throw new Error("APP_ENCRYPTION_KEY is not set");
    if (!devKeyWarned) console.warn("[crypto] APP_ENCRYPTION_KEY not set; using an insecure development key");
    devKeyWarned = true;
    k = "development-only-key";
  }
  return crypto.createHash("sha256").update(k).digest();
}

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

export function decryptJson<T = any>(blob: string | null | undefined): T | undefined {
  if (!blob) return undefined;
  const raw = Buffer.from(blob, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** "abcd…wxyz" style preview so staff can see a secret is set without seeing it. */
export function mask(s: string | undefined) {
  if (!s) return "";
  return s.length <= 8 ? "••••" : `${s.slice(0, 4)}••••${s.slice(-4)}`;
}
