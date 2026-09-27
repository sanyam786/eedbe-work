# Deploying eedbe Work to work.eedbe.com

Takes about 45 minutes the first time. You need accounts on GitHub, Neon (free), Netlify (where eedbe.com already is) and Meta for Developers (for WhatsApp).

---

## Step 1 — Put the code on GitHub

1. Go to https://github.com/new
   - Repository name: `eedbe-work`
   - Visibility: **Private**
   - Leave "Add a README", ".gitignore" and "license" **unticked** (the code already has them)
   - Click **Create repository**
2. Open Terminal on your Mac and run (replace `YOUR-GITHUB-USERNAME`):

   ```bash
   cd ~/Personal/Sanyam/Claude/work/eedbe-work
   git remote add origin https://github.com/YOUR-GITHUB-USERNAME/eedbe-work.git
   git push -u origin main
   ```

3. If Git asks for a password: GitHub doesn't accept account passwords any more. Easiest fix:

   ```bash
   brew install gh
   gh auth login          # choose GitHub.com → HTTPS → log in with a web browser
   git push -u origin main
   ```

4. Refresh the GitHub page. You should see `server/`, `web/`, `netlify/`, `README.md` and the rest.

---

## Step 2 — Create the database (Neon, free)

1. Go to https://neon.tech → **Sign up** (you can use "Continue with GitHub").
2. **Create project**
   - Project name: `eedbe-work`
   - Postgres version: leave the default
   - Region: **AWS US East 2 (Ohio)**. Netlify runs the app's code in Ohio by default; keeping the database next to it makes every WhatsApp reply faster.
   - Click **Create project**
3. On the project dashboard click **Connect**.
   - Turn **Connection pooling** ON.
   - Copy the connection string. It looks like
     `postgresql://neondb_owner:xxxx@ep-xxxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`
   - Keep it for step 3. You don't need to create any tables: the app creates them itself on first use.

---

## Step 3 — Create the Netlify project

1. Go to https://app.netlify.com → **Add new project** → **Import an existing project**.
2. Choose **GitHub**. Approve Netlify's access if asked, and allow it to see the `eedbe-work` repo.
3. Pick **eedbe-work**. Netlify reads `netlify.toml`, so the settings are already filled in:
   - Branch: `main`
   - Build command: `npm run build`
   - Publish directory: `dist`
   - Functions directory: `netlify/functions`
4. Before clicking Deploy, click **Add environment variables** (or add them later under **Project configuration → Environment variables**, then redeploy).

   First make two random secrets in Terminal. Run this twice and copy each output:

   ```bash
   openssl rand -base64 32
   ```

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string from step 2 |
   | `SESSION_SECRET` | first random value |
   | `APP_ENCRYPTION_KEY` | second random value. **Save it in your password manager.** It encrypts the WhatsApp/Google keys stored in the database; if it's lost or changed, those keys must be entered again. |
   | `PUBLIC_URL` | `https://work.eedbe.com` |
   | `SIGNUP_CODE` | any code you choose, e.g. `eedbe-ca-2026`. Only people who have it can create an account. |
   | `NODE_VERSION` | `22` |
   | `ANTHROPIC_API_KEY` | optional: an API key from https://console.anthropic.com for AI understanding of messages. Without it, the built-in rules are used. |

5. Click **Deploy**. The first build takes 2–3 minutes (**Deploys** tab → "Published").
6. Check it: open `https://<your-project-name>.netlify.app/api/health`. It should show `{"ok":true}`.
   If the build fails, open the deploy log and look at the first red line (see Troubleshooting at the end).

---

## Step 4 — Connect work.eedbe.com

1. In the new project: **Domain management → Add a domain** → type `work.eedbe.com` → **Verify** → **Add subdomain**.
2. DNS:
   - **If eedbe.com's DNS is managed by Netlify** (Netlify → Domains shows eedbe.com with Netlify nameservers), the record is created automatically. Nothing else to do.
   - **If the DNS is at your registrar** (GoDaddy, Hostinger, etc.), add a record there:
     Type `CNAME`, Name/Host `work`, Value `<your-project-name>.netlify.app`, TTL default.
3. HTTPS: under **Domain management → HTTPS**, Netlify issues the certificate automatically once DNS resolves (a few minutes, occasionally up to an hour). Click **Verify DNS configuration** if it's waiting.
4. Open https://work.eedbe.com. You should see the eedbe Work sign-in page.

---

## Step 5 — First workspace and dummy data

1. https://work.eedbe.com/signup → your name, email, a password (10+ characters) and the `SIGNUP_CODE`.
2. **Set up your business**: name e.g. `Demo CA Office`, type **CA / tax & accounting firm (India)**, leave **WhatsApp Document Assistant** ticked → **Create workspace**.
3. **Customers → Import CSV** → choose `eedbe-work/demo/customers.csv`. That adds 4 customers and 3 WhatsApp numbers.
4. **Documents → Choose folder** → pick `work/demo-documents`. After about a minute: 18 filed, 2 "needs checking" (those two are deliberately unplaceable).
5. **Test chat** → "Chat as" Ramesh Sharma → try:
   - `hi`
   - `send my ITR` → tap **Ramesh Sharma** → two locked PDFs (password `abcps1234k15081975`)
   - `GSTR-3B for March` → pick the first GSTIN
   - `GST returns 2026-27` → 4 months sent, July reported missing
   - `last 3 years itr`
6. **Replies & rules**: FY is the default for a bare "2024-25"; switch to AY there if needed.

The platform works fully at this point. Only real WhatsApp delivery is left.

---

## Step 6 — Test on real WhatsApp with Meta's free test number

This uses Meta's test number, so no SIM is needed. You can test from your own phone.

### 6a. Create the Meta app
1. https://developers.facebook.com → log in with Facebook → if asked, finish **Register as a developer**.
2. **My Apps → Create app**.
   - App name: `eedbe Work`
   - Use case: **Connect with customers through WhatsApp** (older screens: type **Business**, then add the **WhatsApp** product)
   - Business portfolio: pick yours or create one
   - Create the app.
3. Open **WhatsApp → API Setup**. You'll see:
   - **Temporary access token** (valid 24 hours)
   - **From**: a test phone number, with its **Phone number ID** and **WhatsApp Business Account ID**
   - **To**: click **Manage phone number list** → add your own WhatsApp number → enter the code WhatsApp sends you. Up to 5 numbers can be added.
4. **App settings → Basic → App secret → Show** (Facebook asks for your password) → copy it.

### 6b. Enter it in the dashboard
work.eedbe.com → **Assistant setup → WhatsApp number**:
1. **Phone number ID** and **WhatsApp Business Account ID** → paste.
2. **Access token → Add** → paste the temporary token.
3. **App secret → Add** → paste.
4. **Verify token → Generate** → **Copy** it (it's shown only now).
5. **Save**.

### 6c. Point Meta's webhook at the dashboard
1. Meta app → **WhatsApp → Configuration** → **Webhook → Edit**.
   - **Callback URL**: copy it from the dashboard's Webhook box (`https://work.eedbe.com/api/webhooks/whatsapp/<workspace-id>`)
   - **Verify token**: the one you copied
   - **Verify and save**. It fails if the dashboard values weren't saved or the token doesn't match.
2. Under **Webhook fields → Manage**, find **messages** → **Subscribe**.

### 6d. Try it
1. Dashboard → **Check connection**: it shows the test number.
2. **Send test message** to your number: you receive Meta's "Hello World".
3. **Customers → Ramesh Sharma → + Add number** → your WhatsApp number → **Save**.
4. From your phone, message the test number:
   - `hi` → the assistant introduces itself
   - `send my ITR` → tap **Ramesh Sharma** in the list → two PDFs arrive; open with `abcps1234k15081975`
5. Everything shows up under **Activity** (filter "Real WhatsApp").

### 6e. Keep it working beyond 24 hours (permanent token)
1. https://business.facebook.com → **Settings → Users → System users → Add** → name `eedbe-bot`, role **Admin**.
2. **Assign assets**: your app (Full control) and your WhatsApp account (Full control).
3. **Generate new token** → choose the app → expiry **Never** → permissions `whatsapp_business_messaging` and `whatsapp_business_management` → Generate → copy.
4. Dashboard → WhatsApp number → **Access token → Replace** → paste → **Save**.

---

## Step 7 — Going live with the firm's real number (when ready)

1. Get a number that is **not** registered on the WhatsApp or WhatsApp Business app (a new SIM/landline, or delete WhatsApp from it first).
2. Meta app → **WhatsApp → API Setup → Add phone number** → display name (e.g. the firm's name) → verify by SMS/call. Display names are reviewed by Meta.
3. **Business verification**: business.facebook.com → Security Centre → Start verification (GST certificate / utility bill with the firm's name). This raises the daily limit on business-initiated messages.
4. Dashboard → WhatsApp number → replace the **Phone number ID** with the new number's ID → Save → Check connection.
5. **Template** for late deliveries (a file uploaded more than 24 hours after the request): WhatsApp Manager → Message templates → Create
   - Category **Utility**, name `document_ready`, language **English**
   - Header **Document**
   - Body `Your {{1}} is ready. Please find it attached.`
   - Submit; approval usually takes minutes.
6. If Meta asks for it, switch the app to **Live** (App settings → Basic needs a Privacy Policy URL, e.g. a page on eedbe.com).
7. Add the real customers (Customers → Import CSV) and documents (upload, or Google Drive in step 8).

---

## Step 8 — Google Drive instead of uploads (optional, for the office)

1. The firm uses Google Workspace with a **Shared Drive** (e.g. "Customer Documents").
2. Install **Google Drive for desktop** on Saurabh's PC and move the client folders into the Shared Drive.
3. https://console.cloud.google.com → create project `eedbe-work` → **APIs & Services → Library → Google Drive API → Enable**.
4. **IAM & Admin → Service accounts → Create service account** (name `eedbe-drive`) → Done → open it → **Keys → Add key → Create new key → JSON** (downloads a file).
5. In Google Drive, open the Shared Drive → **Manage members** → add the service account's email (ends in `iam.gserviceaccount.com`) as **Viewer**.
6. Dashboard → **Document storage → Google Drive** → paste the Shared Drive's link → **choose the file** (the JSON key) → **Save** → **Test connection** → **Scan whole Drive now**.
7. From then on, new files are picked up every 5 minutes. Check **Documents → Needs checking** now and then.

---

## Everyday operations

- **Updating the app**: commit and `git push`. Netlify rebuilds and deploys automatically (Deploys tab). To undo a bad deploy: Deploys → pick an older one → **Publish deploy**.
- **Logs**: Netlify → Logs → Functions → `api` (requests, webhook) and `scheduled-sync` (Drive).
- **Onboarding another business**: give them the `SIGNUP_CODE`. They sign up and create their own workspace. Their data is completely separate from other workspaces.
- **Inviting staff** of a firm: Workspace → Team → invite link.
- **Database backups**: Neon keeps a restore window (point-in-time restore) on its plans; check the current window under Neon → Backup & Restore.

## Troubleshooting

| What you see | What to check |
|---|---|
| Build fails in Netlify | Deploy log. `npm ci` errors → Node version (set `NODE_VERSION=22`). |
| `/api/health` works but sign-up says "Something went wrong" | `DATABASE_URL` is wrong (copy it again from Neon → Connect, with pooling on). Netlify function logs show the exact error. |
| "APP_ENCRYPTION_KEY is not set" / "SESSION_SECRET is not set" in logs | Add the variable, then **Deploys → Trigger deploy → Deploy project**. Variables only apply to new deploys. |
| Meta "Verify and save" fails | Save the WhatsApp page first; the verify token must match exactly; Callback URL must be https://work.eedbe.com/… (not the .netlify.app one, unless that's what you paste). |
| Messages arrive but no reply | Activity page: "Unregistered number" means the sender's number isn't on any customer. Function log shows `401` means the App secret is wrong. |
| Reply works but PDFs don't arrive | Access token expired (temporary tokens last 24 h), so create the permanent token (6e). |
| Customer gets "couldn't find" for a file you uploaded | Documents → Needs checking; place the file there, and it's sent to them automatically. |
