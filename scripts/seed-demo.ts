// Fills a workspace with the demo customers and sample PDFs, through the normal API.
//
//   npm run seed:demo -- <site URL> <email> <password> [signup code]
//   npm run seed:demo -- http://localhost:8787 demo@eedbe.com demo-password-1
//
// Signs in (or signs up), creates "Demo CA Office", turns on the WhatsApp assistant,
// imports demo/customers.csv and uploads the sample documents (python3 + reportlab + qpdf needed).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [base = "http://localhost:8787", email = "demo@eedbe.com", password = "demo-password-1", code = ""] = process.argv.slice(2);
let cookie = "";

async function call(method: string, url: string, body?: unknown) {
  const headers: Record<string, string> = { "x-requested-with": "eedbe" };
  if (cookie) headers.cookie = cookie;
  let payload: any;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers, body: payload });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const data: any = (res.headers.get("content-type") ?? "").includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${method} ${url}: ${data?.error ?? res.status}`);
  return data;
}

try {
  await call("POST", "/api/auth/login", { email, password });
  console.log(`Signed in as ${email}`);
} catch {
  await call("POST", "/api/auth/signup", { name: "Demo User", email, password, code });
  console.log(`Created account ${email}`);
}
const me = await call("GET", "/api/auth/me");
let org = me.orgs.find((o: any) => o.name === "Demo CA Office");
if (!org) {
  org = await call("POST", "/api/orgs", { name: "Demo CA Office", industry: "tax_accounting_in" });
  console.log("Created workspace Demo CA Office");
}
const D = `/api/orgs/${org.id}/docbot`;
await call("POST", `/api/orgs/${org.id}/features/whatsapp_docbot`, { enabled: true });
await call("PATCH", `/api/orgs/${org.id}/settings`, { officeContact: "0291-2345678" });

const root = path.resolve(import.meta.dirname, "..");
const imp = await call("POST", `${D}/customers/import`, { csv: fs.readFileSync(path.join(root, "demo/customers.csv"), "utf8") });
console.log(`Customers: ${imp.customers} customers, ${imp.numbers} WhatsApp numbers`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eedbe-demo-"));
execFileSync("python3", [path.join(root, "demo/make_sample_docs.py"), dir]);
const files: string[] = [];
const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } };
walk(dir);
let indexed = 0, review = 0;
for (const f of files.sort()) {
  const form = new FormData();
  const rel = path.relative(dir, f).split(path.sep).join("/");
  form.append("file", new Blob([fs.readFileSync(f)], { type: "application/pdf" }), path.basename(f));
  form.append("path", rel);
  const r = await call("POST", `${D}/documents/upload`, form);
  r.status === "indexed" ? indexed++ : review++;
}
console.log(`Documents: ${indexed} filed, ${review} to check`);
console.log(`\nOpen ${base}/w/${org.id} and try the Test chat as Ramesh Sharma (98123 45678).`);
