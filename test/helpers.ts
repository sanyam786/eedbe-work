// Test setup: a clean database, a local folder for uploads, and an HTTP client with a cookie jar
// that calls the real Hono app (the same code Netlify runs).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL ??= "postgres://postgres@localhost:5433/eedbe_test";
process.env.BLOBS_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eedbe-blobs-"));
process.env.SESSION_SECRET = "test-session-secret";
process.env.APP_ENCRYPTION_KEY = "test-encryption-key";
process.env.ANTHROPIC_API_KEY = "";
process.env.PUBLIC_URL = "https://work.eedbe.com";
process.env.SIGNUP_CODE = "letmein";

export const root = path.resolve(import.meta.dirname, "..");
export const NOW = new Date();

export async function resetDb() {
  const db = await import("../server/db.js");
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await c.end();
  await db.closeDb();
  return db;
}

export function makeDocs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eedbe-docs-"));
  execFileSync("python3", [path.join(root, "demo/make_sample_docs.py"), dir]);
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p) : files.push(path.relative(dir, p));
  } };
  walk(dir);
  return { dir, files: files.sort() };
}

export function pdfFrom(lines: string[]) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eedbe-one-")), "f.pdf");
  execFileSync("python3", ["-c", `
from reportlab.pdfgen import canvas
import json, sys
c = canvas.Canvas(sys.argv[1])
for i, l in enumerate(json.loads(sys.argv[2])):
    c.drawString(50, 800 - i * 18, l)
c.save()`, out, JSON.stringify(lines)]);
  return fs.readFileSync(out);
}

/** A browser-like client: keeps the session cookie and sends the CSRF header. */
export async function client() {
  const { app } = await import("../server/app.js");
  let cookie = "";
  const call = async (method: string, url: string, body?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { "x-requested-with": "eedbe", ...extra };
    if (cookie) headers.cookie = cookie;
    let payload: any;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await app.request(`https://work.eedbe.com${url}`, { method, headers, body: payload });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    const type = res.headers.get("content-type") ?? "";
    const data = type.includes("json") ? await res.json() : type.includes("pdf") ? new Uint8Array(await res.arrayBuffer()) : await res.text();
    return { status: res.status, data: data as any };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, b?: unknown, h?: Record<string, string>) => call("POST", u, b ?? {}, h),
    put: (u: string, b?: unknown) => call("PUT", u, b ?? {}),
    patch: (u: string, b?: unknown) => call("PATCH", u, b ?? {}),
    del: (u: string) => call("DELETE", u),
    raw: call,
    app,
  };
}

/** True if the PDF needs a password and opens with `password` (checked with qpdf). */
export function lockedWith(file: Uint8Array, password: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eedbe-pw-"));
  const f = path.join(dir, "f.pdf");
  fs.writeFileSync(f, file);
  let locked = false, opens = false;
  try { execFileSync("qpdf", ["--requires-password", f]); locked = true; } catch { /* not locked */ }
  try { execFileSync("qpdf", [`--password=${password}`, "--decrypt", f, path.join(dir, "o.pdf")]); opens = true; } catch { /* wrong */ }
  fs.rmSync(dir, { recursive: true, force: true });
  return locked && opens;
}
