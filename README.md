# eedbe Work

A multi-business automation platform, hosted at **work.eedbe.com**. Each business gets its own workspace (customers, documents, team, settings) and turns on the features it needs. The first feature is the **WhatsApp Document Assistant**; the platform is built so more features can be added the same way.

## WhatsApp Document Assistant

Customers message the business's WhatsApp number ("send my ITR", "March ka GST", "policy copy") and immediately get the right PDF back, password-protected.

- **Works for any business.** Document types, the words customers use, customer ID types (PAN, GSTIN, policy number, customer code…) and year rules are all settings. New workspaces start from a preset: *CA / tax firm (India)* or *Any other business*.
- **Only registered numbers get documents**, and each number only gets the customers linked to it.
- **Asks which one** when a customer has several (e.g. a person and their firm, or two GSTINs), unless the message already says.
- **Reads each PDF** to find the type, the customer (by ID number) and the period. It can open portal-locked PDFs (PAN + DOB) and falls back to folder names for scans. Files it can't place go to a review queue.
- **Locks every PDF** (AES-256; ID + date as DDMMYYYY, like an ITR-V). Files already locked by a portal are sent as they are.
- **Chases missing documents**: tells the customer, alerts staff, and sends the file automatically once it's uploaded.
- **FY/AY setting**: whether a bare "2024-25" means the financial or assessment year (default: FY).
- Staff approval per customer, hourly limits, full activity log.
- **Test chat** in the dashboard: chat as any customer with real documents, no WhatsApp needed.
- AI (Claude) understands Hindi/Hinglish and odd phrasing; built-in rules work without it. Only the message and the customer's business names go to the AI.

## How it runs on Netlify

```
Browser ──► work.eedbe.com (Netlify)
              ├─ dashboard (React, static)
              ├─ /api/* ─► api function  ── Postgres (Neon)
              │              └─ WhatsApp webhook /api/webhooks/whatsapp/<workspace id>
              ├─ scheduled-sync (every 5 min) ─► Google Drive (read-only)
              └─ Netlify Blobs: uploaded PDFs
```

Everything is JavaScript, so it fits in Netlify Functions: pdf.js reads PDFs and pdf-lib encrypts them. The webhook replies to Meta immediately and finishes the conversation in the background, within the function's 60-second limit.

## Deploy to work.eedbe.com

**1. Database (free).** Create a project at [neon.tech](https://neon.tech). Pick region **AWS US East 2 (Ohio)**, which is where Netlify runs functions by default, so queries stay fast. Copy the **pooled** connection string. (On a Netlify credit-based plan you can use Netlify Database instead.)

**2. Code on GitHub.** Push this folder to a private repository.

**3. Netlify.** Add new project → Import an existing project → GitHub → pick the repo. Build settings come from `netlify.toml`. Before deploying, add these environment variables (see `.env.example`):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon pooled connection string |
| `SESSION_SECRET` | output of `openssl rand -base64 32` |
| `APP_ENCRYPTION_KEY` | another `openssl rand -base64 32`. **Keep a copy**: if it's lost, saved WhatsApp/Google keys must be re-entered |
| `PUBLIC_URL` | `https://work.eedbe.com` |
| `SIGNUP_CODE` | a code you give to businesses you onboard |
| `ANTHROPIC_API_KEY` | optional, AI for all workspaces |

The database tables are created automatically on the first request.

**4. Domain.** Project → Domain management → Add domain → `work.eedbe.com`. If eedbe.com uses Netlify DNS, the subdomain record is created for you. If its DNS is managed elsewhere (e.g. GoDaddy), add a CNAME record `work` → `<project>.netlify.app` there. Netlify then issues the HTTPS certificate automatically.

**5. First workspace.** Open work.eedbe.com → Create account (with the sign-up code) → Set up your business → CA / tax firm.

**6. Dummy data.** Either upload the `demo-documents` folder on the Documents page and import `demo/customers.csv` on the Customers page, or run:

```bash
npm install
npm run seed:demo -- https://work.eedbe.com you@example.com your-password SIGNUP_CODE
```

Then open **Test chat**, chat as Ramesh Sharma and try "send my ITR", "GSTR-3B for March", "GST returns 2026-27".

## Test with a real WhatsApp (Meta test number)

No new SIM needed for testing. In the dashboard, **Assistant setup → WhatsApp number** has the same steps.

1. [developers.facebook.com](https://developers.facebook.com) → Create app → Business → add **WhatsApp**. Meta creates a free **test number**.
2. WhatsApp → API Setup: add your own phone (and up to 4 more) as recipients, and verify each with the code WhatsApp sends.
3. Copy the **Phone number ID** and the **temporary access token** into the dashboard, plus the **App secret** (App settings → Basic). Generate a verify token there. Save.
4. WhatsApp → Configuration → Webhook: paste the **Callback URL** and **verify token** shown in the dashboard → Verify and save → subscribe to **messages**.
5. In the dashboard, add your phone number to a customer (e.g. Ramesh Sharma), or replace his number with yours.
6. Message the test number from your phone: "hi", then "send my ITR".

The temporary token lasts 24 hours. For daily use, create a **System User** token (Business settings → Users → System users) with `whatsapp_business_messaging` and `whatsapp_business_management`.

**Going live:** add the firm's real number under API Setup (a number not already on the WhatsApp app), verify the business in Business Manager, and create the `document_ready` template (Utility; header: Document; body: `Your {{1}} is ready. Please find it attached.`). The template is only used when a file arrives more than 24 hours after the request.

## Google Workspace (when the office moves off Saurabh's PC)

1. Google Workspace for the firm, with a **Shared Drive** (e.g. "Customer Documents").
2. Install **Google Drive for desktop** on the office PC and move the client folders into the Shared Drive. Staff keep saving as usual, and the PC can be switched off.
3. [console.cloud.google.com](https://console.cloud.google.com) → new project → enable **Google Drive API** → Service accounts → Create → Keys → Add key → JSON.
4. Add the service account email to the Shared Drive as **Viewer**.
5. Dashboard → Document storage → Google Drive: paste the Shared Drive link and upload the JSON key → Test connection → Scan whole Drive now. After that, it checks every 5 minutes.
6. Keep a separate backup. Syncing isn't one.

## Local development

```bash
npm install
cp .env.example .env      # DATABASE_URL to a local Postgres
npm run dev               # dashboard on :5173, API on :8787
npm test                  # 18 tests, against the database in DATABASE_URL (it is wiped)
FAKE_WHATSAPP=1 npm run dev:api   # print WhatsApp sends instead of calling Meta
```

The sample PDFs come from `python3 demo/make_sample_docs.py <folder>` (needs `reportlab`; `qpdf` for the locked samples).

## Adding a feature later

1. Add it to `server/features.ts` (catalog shown on the workspace Home).
2. Put its tables in `server/schema.ts` (with `org_id`), bump `SCHEMA_VERSION`, and add its routes in `server/app.ts` under `/orgs/:orgId/<feature>/…` using `org("staff")` / `org("admin")`.
3. Add its pages and a sidebar group in `web/App.tsx`, shown when `org.features[key]` is on.

## Code map

| | |
|---|---|
| `server/app.ts` | API routes and the WhatsApp webhook |
| `server/auth.ts`, `orgs.ts`, `settings.ts`, `presets.ts`, `features.ts` | accounts, workspaces, settings, industry presets, feature catalog |
| `server/docbot/bot.ts` | the conversation: identify → understand → choose → find → lock → send → chase |
| `server/docbot/classifier.ts`, `indexer.ts` | recognising documents; uploads and Drive sync |
| `server/docbot/intent.ts`, `llm.ts` | understanding messages (rules / Claude) |
| `server/docbot/messenger.ts` | WhatsApp Cloud API |
| `netlify/functions/` | `api` (all `/api/*`) and `scheduled-sync` |
| `web/` | dashboard (React) |

## Security notes

- Passwords are hashed with bcrypt. Sessions use signed httpOnly cookies. Every change request must carry a custom header (CSRF protection). Logins are rate-limited.
- WhatsApp tokens, app secrets, Google keys and AI keys are encrypted (AES-256-GCM) in the database and only ever shown masked.
- Webhooks are verified with Meta's HMAC signature, per workspace.
- Every query is scoped to the workspace. Staff can't change settings or keys; admins can.
- Test-chat activity is labelled and never delivered on WhatsApp.
