import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { ErrorLine, Field, useAction, useApi } from "../ui";
import type { Me } from "../App";

function AuthFrame({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand"><span className="brand-mark">e</span> eedbe Work</div>
        <div className="card card-pad stack">
          <div><h1>{title}</h1>{sub && <p className="muted" style={{ marginTop: 4 }}>{sub}</p>}</div>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const a = useAction();
  const nav = useNavigate();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await a.run(() => api.post("/api/auth/login", { email, password }))) { await onDone(); nav("/"); }
  };
  return (
    <AuthFrame title="Sign in" sub="Automation for your office, starting with WhatsApp.">
      <form className="stack" onSubmit={submit}>
        <Field label="Email"><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <ErrorLine error={a.error} />
        <button className="btn primary" disabled={a.busy}>{a.busy ? "Signing in…" : "Sign in"}</button>
        <p className="muted small">New here? <Link to="/signup">Create an account</Link></p>
      </form>
    </AuthFrame>
  );
}

export function Signup({ onDone }: { onDone: () => Promise<void> }) {
  const cfg = useApi<any>("/api/config");
  const [f, setF] = useState({ name: "", email: "", password: "", code: "" });
  const a = useAction();
  const nav = useNavigate();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await a.run(() => api.post("/api/auth/signup", f))) { await onDone(); nav("/new"); }
  };
  if (cfg.data?.signupsClosed) return <AuthFrame title="Sign-ups are closed" sub="Ask your workspace admin for an invite link."><Link to="/login">Sign in</Link></AuthFrame>;
  return (
    <AuthFrame title="Create your account" sub="Then set up a workspace for your business.">
      <form className="stack" onSubmit={submit}>
        <Field label="Your name"><input type="text" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="Email"><input type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
        <Field label="Password" help="At least 10 characters"><input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={10} /></Field>
        {cfg.data?.signupNeedsCode && <Field label="Sign-up code" help="Given to you by eedbe"><input type="text" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required /></Field>}
        <ErrorLine error={a.error} />
        <button className="btn primary" disabled={a.busy}>{a.busy ? "Creating…" : "Create account"}</button>
        <p className="muted small">Already have an account? <Link to="/login">Sign in</Link></p>
      </form>
    </AuthFrame>
  );
}

export function InviteAccept({ me, onDone }: { me?: Me; onDone: () => Promise<void> }) {
  const { token } = useParams();
  const inv = useApi<any>(`/api/invites/${token}`);
  const [f, setF] = useState({ name: "", password: "" });
  const a = useAction();
  const nav = useNavigate();
  if (inv.error) return <AuthFrame title="Invite not found" sub={inv.error}><Link to="/login">Sign in</Link></AuthFrame>;
  if (!inv.data) return <AuthFrame title="Loading invite…">{null}</AuthFrame>;
  const i = inv.data;
  if (i.used || i.expired) return <AuthFrame title="This invite can't be used" sub={i.used ? "It was already accepted." : "It has expired. Ask for a new one."}><Link to="/login">Sign in</Link></AuthFrame>;
  const signedInAsOther = me?.user && me.user.email !== i.email;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await a.run(() => api.post(`/api/invites/${token}/accept`, f));
    if (r) { await onDone(); nav(`/w/${r.orgId}`); }
  };
  return (
    <AuthFrame title={`Join ${i.org_name}`} sub={`You've been invited as ${i.role} (${i.email}).`}>
      {signedInAsOther ? <p className="muted">You're signed in as {me!.user!.email}. Sign out, then open this link again.</p> : (
        <form className="stack" onSubmit={submit}>
          {!me?.user && !i.has_account && <Field label="Your name"><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>}
          {!me?.user && <Field label={i.has_account ? "Your password" : "Choose a password"} help={i.has_account ? undefined : "At least 10 characters"}>
            <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></Field>}
          <ErrorLine error={a.error} />
          <button className="btn primary" disabled={a.busy}>Join workspace</button>
        </form>
      )}
    </AuthFrame>
  );
}

export function NewWorkspace({ onDone, hasOrgs }: { onDone: () => Promise<void>; hasOrgs: boolean }) {
  const cfg = useApi<any>("/api/config");
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("tax_accounting_in");
  const [features, setFeatures] = useState<Record<string, boolean>>({ whatsapp_docbot: true });
  const a = useAction();
  const nav = useNavigate();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await a.run(async () => {
      const o = await api.post<{ id: string }>("/api/orgs", { name, industry });
      for (const [k, on] of Object.entries(features)) if (on) await api.post(`/api/orgs/${o.id}/features/${k}`, { enabled: true });
      return o;
    });
    if (r) { await onDone(); nav(`/w/${r.id}`); }
  };
  return (
    <div className="auth">
      <div style={{ width: "min(680px, 100%)" }}>
        <div className="brand" style={{ color: "var(--ink)" }}><span className="brand-mark">e</span> eedbe Work</div>
        <form className="card card-pad stack" onSubmit={submit}>
          <div><h1>Set up your business</h1><p className="muted" style={{ marginTop: 4 }}>A workspace holds your customers, documents, team and settings. You can change everything later.</p></div>
          <Field label="Business name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jain & Associates" required /></Field>
          <div className="stack" style={{ gap: 8 }}>
            <b>Type of business</b>
            <div className="grid grid-2">
              {cfg.data?.presets.map((p: any) => (
                <button type="button" key={p.key} className={`preset${industry === p.key ? " on" : ""}`} onClick={() => setIndustry(p.key)}>
                  <h3>{p.label}</h3><p className="muted small">{p.description}</p>
                </button>
              ))}
            </div>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <b>Features</b>
            {cfg.data?.features.map((f: any) => (
              <label key={f.key} className="check">
                <input type="checkbox" checked={!!features[f.key]} disabled={f.status !== "available"} onChange={(e) => setFeatures({ ...features, [f.key]: e.target.checked })} />
                <span><b>{f.name}</b><br /><span className="muted small">{f.summary}</span></span>
              </label>
            ))}
          </div>
          <ErrorLine error={a.error} />
          <div className="row">
            <button className="btn primary" disabled={a.busy}>{a.busy ? "Creating…" : "Create workspace"}</button>
            {hasOrgs && <Link to="/" className="btn ghost">Cancel</Link>}
          </div>
        </form>
      </div>
    </div>
  );
}
