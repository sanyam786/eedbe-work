// All /api/* requests: dashboard API and the WhatsApp webhook.
import { handle } from "hono/netlify";
import { app } from "../../server/app.js";

export default handle(app);

export const config = { path: "/api/*" };
