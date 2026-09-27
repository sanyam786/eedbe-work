import { useState } from "react";
import { api, type IdentifierKind } from "../api";
import { Copy, ErrorLine, Field, fmtDate, Loading, Notice, PageHead, useAction, useApi, useWs } from "../ui";
import { SaveBar, SecretField, saveSecrets, useSettingsForm } from "./settingsKit";

export function BusinessSettings() {
  const { isAdmin } = useWs();
  const form = useSettingsForm();
  const { s, set } = form;
  const setKind = (i: number, patch: Partial<IdentifierKind>) => set((d) => { d.identifierKinds[i] = { ...d.identifierKinds[i], ...patch }; });
  return (
    <>
      <PageHead title="Business profile" sub="Details shared by every feature in this workspace." />
      <fieldset disabled={!isAdmin} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="stack" style={{ maxWidth: 820 }}>
          {!isAdmin && <Notice kind="warn">Only admins can change these.</Notice>}
          <div className="card card-pad stack">
            <div className="form-grid">
              <Field label="Business name" help="Shown to customers"><input type="text" value={s.businessName} onChange={(e) => set((d) => { d.businessName = e.target.value; })} /></Field>
              <Field label="Office contact" help="Phone or email given to unknown numbers"><input type="text" value={s.officeContact} onChange={(e) => set((d) => { d.officeContact = e.target.value; })} /></Field>
              <Field label="Time zone"><select value={s.timezone} onChange={(e) => set((d) => { d.timezone = e.target.value; })}>
                {["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"].map((z) => <option key={z}>{z}</option>)}</select></Field>
            </div>
          </div>

          <div className="card card-pad stack">
            <div><h2>Customer ID types</h2><p className="muted small" style={{ marginTop: 4 }}>The numbers that identify customers on their documents (PAN, GSTIN, policy number, customer code…). The assistant looks for these inside every file.</p></div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Name</th><th>Key</th><th>Pattern (optional)</th><th>Main ID</th><th>Several per customer</th><th></th></tr></thead>
              <tbody>{s.identifierKinds.map((k, i) => (
                <tr key={i}>
                  <td><input type="text" value={k.label} onChange={(e) => setKind(i, { label: e.target.value })} /></td>
                  <td><input type="text" className="mono" value={k.key} onChange={(e) => setKind(i, { key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })} style={{ width: 120 }} /></td>
                  <td><input type="text" className="mono" value={k.pattern ?? ""} placeholder="e.g. [A-Z]{5}[0-9]{4}[A-Z]" onChange={(e) => setKind(i, { pattern: e.target.value || undefined })} /></td>
                  <td style={{ textAlign: "center" }}><input type="radio" name="primary" checked={!!k.primary} onChange={() => set((d) => { d.identifierKinds.forEach((x, j) => { x.primary = j === i; }); })} /></td>
                  <td style={{ textAlign: "center" }}><input type="checkbox" checked={!!k.selectable} onChange={(e) => setKind(i, { selectable: e.target.checked })} /></td>
                  <td><button className="btn small ghost" onClick={() => set((d) => { d.identifierKinds.splice(i, 1); })} aria-label="Remove">✕</button></td>
                </tr>
              ))}</tbody>
            </table></div>
            <button className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => set((d) => { d.identifierKinds.push({ key: "NEW_ID", label: "New ID" }); })}>+ Add ID type</button>
            <p className="small dim">Main ID: used in PDF passwords. “Several per customer”: e.g. one GSTIN per state — customers pick which one when asking. Without a pattern, the assistant searches for each customer's exact value.</p>
          </div>

          <div className="card card-pad stack">
            <div className="form-grid">
              <Field label="Customer types" help="Comma-separated, shown when adding customers">
                <input type="text" value={s.entityTypes.join(", ")} onChange={(e) => set((d) => { d.entityTypes = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); })} /></Field>
              <Field label="Name of the customer's key date" help="Used with the main ID for passwords">
                <input type="text" value={s.keyDateLabel} onChange={(e) => set((d) => { d.keyDateLabel = e.target.value; })} /></Field>
            </div>
          </div>
          <SaveBar form={form} />
        </div>
      </fieldset>
    </>
  );
}

export function TeamSettings() {
  const { org, isAdmin, toast } = useWs();
  const team = useApi<any>(`/api/orgs/${org.id}/members`);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("staff");
  const [link, setLink] = useState<string>();
  const a = useAction();
  const invite = async () => {
    const r = await a.run(() => api.post(`/api/orgs/${org.id}/invites`, { email, role }));
    if (r) { setLink(r.link); setEmail(""); void team.reload(); }
  };
  const act = async (fn: () => Promise<unknown>, msg: string) => { if (await a.run(fn)) { toast(msg); void team.reload(); } };
  return (
    <>
      <PageHead title="Team" sub="People who can use this workspace. Staff handle customers, documents and requests; admins can also change settings and connections." />
      <div className="stack" style={{ maxWidth: 820 }}>
        {isAdmin && (
          <div className="card card-pad stack">
            <h2>Invite someone</h2>
            <div className="row">
              <input type="email" placeholder="colleague@firm.in" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
              <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 120 }}><option value="staff">Staff</option><option value="admin">Admin</option></select>
              <button className="btn primary" onClick={invite} disabled={a.busy || !email}>Create invite link</button>
            </div>
            {link && <Notice kind="ok"><div className="row"><span>Send this link to them (valid 7 days):</span><code className="tag" style={{ wordBreak: "break-all" }}>{link}</code><Copy text={link} /></div></Notice>}
          </div>
        )}
        <ErrorLine error={a.error} />
        <div className="card">
          {!team.data ? <Loading /> : <table className="table">
            <thead><tr><th>Name</th><th>Role</th><th>Since</th><th></th></tr></thead>
            <tbody>
              {team.data.members.map((m: any) => (
                <tr key={m.id}><td><b>{m.name}</b><div className="small dim">{m.email}</div></td>
                  <td>{org.role === "owner" && m.role !== "owner" ? (
                    <select value={m.role} onChange={(e) => act(() => api.patch(`/api/orgs/${org.id}/members/${m.id}`, { role: e.target.value }), "Role changed")} style={{ width: 110 }}>
                      <option value="staff">staff</option><option value="admin">admin</option></select>) : m.role}</td>
                  <td className="small">{fmtDate(m.created_at)}</td>
                  <td style={{ textAlign: "right" }}>{isAdmin && m.role !== "owner" && <button className="btn small ghost danger" onClick={() => confirm(`Remove ${m.name}?`) && act(() => api.del(`/api/orgs/${org.id}/members/${m.id}`), "Removed")}>Remove</button>}</td></tr>
              ))}
              {team.data.invites.map((i: any) => (
                <tr key={i.id}><td>{i.email}<div className="small dim">invited</div></td><td>{i.role}</td><td className="small">expires {fmtDate(i.expires_at)}</td>
                  <td style={{ textAlign: "right" }}><button className="btn small ghost" onClick={() => act(() => api.del(`/api/orgs/${org.id}/invites/${i.id}`), "Invite cancelled")}>Cancel</button></td></tr>
              ))}
            </tbody>
          </table>}
        </div>
      </div>
    </>
  );
}

export function AiSettings() {
  const { org, reload, toast } = useWs();
  const [key, setKey] = useState<string | undefined>();
  const a = useAction();
  const save = async () => { if (await a.run(() => saveSecrets(org.id, { anthropicApiKey: key }).then(() => true))) { setKey(undefined); await reload(); toast("Saved"); } };
  return (
    <>
      <PageHead title="AI" sub="Features use Claude (by Anthropic) to understand messages written in everyday language." />
      <div className="stack" style={{ maxWidth: 720 }}>
        <div className="card card-pad stack">
          {org.platformAiKey
            ? <Notice kind="ok">AI is included with eedbe Work. You can use your own Anthropic key instead if you prefer.</Notice>
            : <Notice kind="warn">No AI key is set up for this platform yet. Add your own below, or the assistant uses its built-in rules (English and common Hinglish).</Notice>}
          <SecretField name="anthropicApiKey" label="Your Anthropic API key (optional)" value={key} onChange={setKey}
            help="From console.anthropic.com → API keys. Usage is billed to your Anthropic account." />
          <div className="row"><button className="btn primary" onClick={save} disabled={a.busy || key === undefined}>Save</button></div>
          <ErrorLine error={a.error} />
        </div>
        <p className="small muted">What is sent: the customer's message and the names of their own businesses. Never ID numbers, dates of birth or documents — unless you turn on “Ask AI about files the rules can't place” under Replies & rules.</p>
      </div>
    </>
  );
}
