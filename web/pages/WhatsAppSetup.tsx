import { useState } from "react";
import { api } from "../api";
import { Copy, ErrorLine, Field, Notice, PageHead, useAction, useWs } from "../ui";
import { SecretField, saveSecrets, useSettingsForm } from "./settingsKit";

export function WhatsAppSetup() {
  const { org, reload, toast } = useWs();
  const form = useSettingsForm();
  const { s, set } = form;
  const [sec, setSec] = useState<Record<string, string | undefined>>({});
  const [newVerify, setNewVerify] = useState<string>();
  const [testTo, setTestTo] = useState("");
  const [status, setStatus] = useState<any>();
  const a = useAction();
  const connected = s.whatsapp.phoneNumberId && org.secrets.waAccessToken?.set && org.secrets.waAppSecret?.set && org.secrets.waVerifyToken?.set;

  const saveAll = async () => {
    const ok = await a.run(async () => {
      await saveSecrets(org.id, { ...sec, ...(newVerify ? { waVerifyToken: newVerify } : {}) });
      await api.patch(`/api/orgs/${org.id}/settings`, { whatsapp: s.whatsapp });
      return true;
    });
    if (ok) { setSec({}); await reload(); toast("WhatsApp settings saved"); }
  };
  const check = async () => { setStatus(undefined); const r = await a.run(() => api.get(`/api/orgs/${org.id}/docbot/whatsapp/status`)); if (r) { setStatus(r); await reload(); } };
  const test = async () => { const r = await a.run(() => api.post(`/api/orgs/${org.id}/docbot/whatsapp/test`, { to: testTo })); if (r) toast("Test message sent — check that phone"); };
  const generate = () => { const b = crypto.getRandomValues(new Uint8Array(18)); setNewVerify(btoa(String.fromCharCode(...b)).replace(/[+/=]/g, "")); };

  return (
    <>
      <PageHead title="WhatsApp number" sub="Connect the WhatsApp Business number customers will message. Until then, the test chat works without it." />
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr)", alignItems: "start" }}>
        <div className="stack">
          <div className="card card-pad stack">
            <div className="row"><h2>Connection</h2><span className="spacer" />{connected ? <span className="pill green">Details saved</span> : <span className="pill amber">Not connected</span>}</div>
            <div className="form-grid">
              <Field label="Phone number ID" help="Meta app → WhatsApp → API Setup"><input type="text" className="mono" value={s.whatsapp.phoneNumberId} onChange={(e) => set((d) => { d.whatsapp.phoneNumberId = e.target.value.trim(); })} /></Field>
              <Field label="WhatsApp Business Account ID" help="Optional, for reference"><input type="text" value={s.whatsapp.businessAccountId} onChange={(e) => set((d) => { d.whatsapp.businessAccountId = e.target.value.trim(); })} /></Field>
            </div>
            <SecretField name="waAccessToken" label="Access token" value={sec.waAccessToken} onChange={(v) => setSec({ ...sec, waAccessToken: v })}
              help="Use a permanent System User token. The temporary token from API Setup stops working after 24 hours." />
            <SecretField name="waAppSecret" label="App secret" value={sec.waAppSecret} onChange={(v) => setSec({ ...sec, waAppSecret: v })}
              help="App settings → Basic → App secret. Used to check that webhook messages really come from Meta." />
            <div className="stack" style={{ gap: 5 }}>
              <b style={{ fontSize: 13 }}>Verify token</b>
              {newVerify ? <div className="row"><code className="tag" style={{ padding: "4px 8px" }}>{newVerify}</code><Copy text={newVerify} /><span className="small dim">Copy it now — paste into Meta after saving.</span></div>
                : <div className="row">{org.secrets.waVerifyToken?.set ? <><span className="pill green">Set</span><span className="mono small">{org.secrets.waVerifyToken.preview}</span></> : <span className="pill amber">Not set</span>}
                  <button type="button" className="btn small" onClick={generate}>{org.secrets.waVerifyToken?.set ? "Make a new one" : "Generate"}</button></div>}
            </div>
            <div className="form-grid">
              <Field label="“Document ready” template name" help="Used when a file arrives more than 24 hours after the request"><input type="text" value={s.whatsapp.templateName} onChange={(e) => set((d) => { d.whatsapp.templateName = e.target.value.trim(); })} /></Field>
              <Field label="Template language code"><input type="text" value={s.whatsapp.templateLang} onChange={(e) => set((d) => { d.whatsapp.templateLang = e.target.value.trim(); })} /></Field>
            </div>
            <div className="row"><button className="btn primary" onClick={saveAll} disabled={a.busy}>{a.busy ? "Saving…" : "Save"}</button></div>
            <ErrorLine error={a.error || form.error} />
          </div>

          <div className="card card-pad stack">
            <h2>Webhook</h2>
            <p className="muted">In your Meta app → WhatsApp → Configuration → Webhook, enter these, then subscribe to the <b>messages</b> field.</p>
            <Field label="Callback URL"><div className="row"><input type="text" readOnly value={org.webhookUrl} className="mono" style={{ flex: 1 }} /><Copy text={org.webhookUrl} /></div></Field>
            <p className="small dim">Verify token: the one above.</p>
          </div>

          <div className="card card-pad stack">
            <h2>Check it works</h2>
            <div className="row"><button className="btn" onClick={check} disabled={a.busy || !connected}>Check connection</button>
              {s.whatsapp.displayNumber && <span className="muted">Number: <b>{s.whatsapp.displayNumber}</b></span>}</div>
            {status && <Notice kind="ok">Connected to <b>{status.display_phone_number}</b>{status.verified_name ? ` (${status.verified_name})` : ""}{status.quality_rating ? ` · quality ${status.quality_rating}` : ""}</Notice>}
            <div className="row">
              <input type="text" placeholder="Your WhatsApp number" value={testTo} onChange={(e) => setTestTo(e.target.value)} style={{ maxWidth: 220 }} />
              <button className="btn" onClick={test} disabled={a.busy || !connected || !testTo}>Send test message</button>
            </div>
            <p className="small dim">Sends Meta's built-in “hello_world” template. With a Meta test number, the receiving phone must be added as a test recipient first. Then message the number from a phone saved as a customer — the assistant should reply.</p>
          </div>
        </div>

        <div className="card card-pad stack">
          <h2>Setting up WhatsApp (one time)</h2>
          <ol className="steps">
            <li><div><b>Business Portfolio</b><br /><span className="muted small">At business.facebook.com, create or use the firm's Business Portfolio. Verify the business later (GST certificate works) to lift sending limits.</span></div></li>
            <li><div><b>Create a Meta app</b><br /><span className="muted small">developers.facebook.com → My Apps → Create app → type “Business” → add the <b>WhatsApp</b> product.</span></div></li>
            <li><div><b>Testing first</b><br /><span className="muted small">Meta gives a free <b>test number</b> on API Setup. Add up to 5 of your own phones as recipients, copy the Phone number ID, and save it here with the temporary token to try things today.</span></div></li>
            <li><div><b>Webhook</b><br /><span className="muted small">Paste the Callback URL and verify token from the left, verify, and subscribe to <b>messages</b>.</span></div></li>
            <li><div><b>Go live with a real number</b><br /><span className="muted small">Add a new number (not in use on the WhatsApp app) under API Setup, verify it by SMS, and set its display name. Replace the Phone number ID here.</span></div></li>
            <li><div><b>Permanent token</b><br /><span className="muted small">Business settings → Users → System users → add one with Admin role → assign the app and WhatsApp account → Generate token with <code>whatsapp_business_messaging</code> and <code>whatsapp_business_management</code>. Paste it as the access token.</span></div></li>
            <li><div><b>Template</b><br /><span className="muted small">WhatsApp Manager → Message templates → Create: category Utility, name <code>{s.whatsapp.templateName || "document_ready"}</code>, header <b>Document</b>, body “Your {"{{1}}"} is ready. Please find it attached.” It's used only when a file arrives after 24 hours.</span></div></li>
          </ol>
        </div>
      </div>
    </>
  );
}
