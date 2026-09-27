// Local API server (the Vite dev server proxies /api here). With FAKE_WHATSAPP=1, messages the bot
// would send on WhatsApp are printed instead.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import fs from "node:fs";
if (fs.existsSync(".env")) process.loadEnvFile(".env");
const { app } = await import("../server/app.js");
const { setMessengerFactory } = await import("../server/docbot/runtime.js");
const { RecordingMessenger } = await import("../server/docbot/messenger.js");

if (process.env.FAKE_WHATSAPP === "1") {
  setMessengerFactory(() => {
    const m = new RecordingMessenger(false);
    const push = m.sent.push.bind(m.sent);
    m.sent.push = (...items) => {
      for (const o of items) console.log(`[fake WhatsApp → ${o.to}]`, o.kind === "document" ? `📎 ${o.filename}` : (o as any).text);
      return push(...items);
    };
    return m;
  });
}

const root = new Hono();
root.route("/", app);
if (fs.existsSync("dist/index.html")) {
  root.use("/*", serveStatic({ root: "./dist" }));
  root.get("*", (c) => c.html(fs.readFileSync("dist/index.html", "utf8")));
}
const port = Number(process.env.API_PORT ?? 8787);
serve({ fetch: root.fetch, port }, () => console.log(`API on http://localhost:${port}`));
