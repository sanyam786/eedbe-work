import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { ErrorLine, Notice, PageHead, phoneFmt, useAction, useApi, useWs } from "../ui";

interface Msg { from: "me" | "bot"; text?: string; rows?: { id: string; title: string; description?: string }[]; doc?: { filename: string; caption: string; size: number; url?: string } }

function b64ToUrl(b64: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
}

const wa = (s: string) => s.split(/(\*[^*\n]+\*)/g).map((part, i) => part.startsWith("*") && part.endsWith("*") ? <b key={i}>{part.slice(1, -1)}</b> : part);

export function TestChat() {
  const { org } = useWs();
  const customers = useApi<{ customers: any[] }>(`/api/orgs/${org.id}/docbot/customers`);
  const numbers: [string, string][] = [...new Map<string, string>((customers.data?.customers ?? []).flatMap((c) => c.contacts.map((p: any): [string, string] => [p.phone, p.name || c.name]))).entries()];
  const [phone, setPhone] = useState("");
  const [custom, setCustom] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const a = useAction();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!phone && numbers.length) setPhone(numbers[0][0]); }, [numbers.length]); // eslint-disable-line
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);
  const as = phone === "other" ? custom : phone;

  const send = async (t: string, replyId?: string, label?: string) => {
    if (!as) return;
    setMsgs((m) => [...m, { from: "me", text: label ?? t }]);
    const r = await a.run(() => api.post(`/api/orgs/${org.id}/docbot/simulator`, { phone: as, text: t, replyId }));
    if (!r) return;
    setMsgs((m) => [...m, ...r.replies.map((x: any): Msg => x.kind === "document"
      ? { from: "bot", doc: { filename: x.filename, caption: x.caption, size: x.size, url: x.data ? b64ToUrl(x.data) : undefined } }
      : { from: "bot", text: x.text, rows: x.rows })]);
  };
  const submit = (e: FormEvent) => { e.preventDefault(); if (text.trim()) { void send(text.trim()); setText(""); } };
  const examples = org.settings.examples.length ? org.settings.examples : ["hi", "what documents do you have"];

  return (
    <>
      <PageHead title="Test chat" sub="Chat exactly as a customer would on WhatsApp — using your real customers and documents — without a WhatsApp number. Nothing is sent to anyone." />
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) 280px", alignItems: "start" }}>
        <div className="card chat">
          <div className="chat-head">
            <b>Chat as</b>
            <select value={phone} onChange={(e) => { setPhone(e.target.value); setMsgs([]); }} style={{ maxWidth: 300 }}>
              {numbers.map(([p, n]) => <option key={p} value={p}>{n} · {phoneFmt(p)}</option>)}
              <option value="other">Another number…</option>
            </select>
            {phone === "other" && <input type="text" placeholder="98123 45678" value={custom} onChange={(e) => setCustom(e.target.value)} style={{ maxWidth: 160 }} />}
            <span className="spacer" />
            <button className="btn small ghost" onClick={() => setMsgs([])}>Clear</button>
          </div>
          <div className="chat-body" aria-live="polite">
            {!msgs.length && <div className="dim small" style={{ textAlign: "center", marginTop: 40 }}>Say “hi”, or try one of the examples on the right.</div>}
            {msgs.map((m, i) => (
              <div key={i} className={`bubble ${m.from}`}>
                {m.doc ? (
                  <>
                    <div className="doc"><span className="ext">PDF</span><div><b className="small">{m.doc.filename}</b><div className="small dim">{Math.max(1, Math.round(m.doc.size / 1024))} KB · locked</div></div></div>
                    <div>{wa(m.doc.caption)}</div>
                    {m.doc.url && <a className="small" href={m.doc.url} download={m.doc.filename}>Download to check</a>}
                  </>
                ) : wa(m.text ?? "")}
                {m.rows && (
                  <div className="options">
                    {m.rows.map((r) => <button key={r.id} onClick={() => send(r.title, r.id, r.title)}>{r.title}{r.description ? <span className="dim small" style={{ fontWeight: 400 }}> · {r.description}</span> : null}</button>)}
                  </div>
                )}
              </div>
            ))}
            {a.busy && <div className="bubble bot dim">typing…</div>}
            <div ref={end} />
          </div>
          <form className="chat-foot" onSubmit={submit}>
            <input type="text" placeholder="Type a message" value={text} onChange={(e) => setText(e.target.value)} aria-label="Message" />
            <button className="btn primary" disabled={a.busy || !as}>Send</button>
          </form>
        </div>
        <div className="stack">
          <div className="card card-pad stack" style={{ gap: 8 }}>
            <h3>Try</h3>
            {examples.map((e) => <button key={e} className="btn small" style={{ justifyContent: "flex-start" }} onClick={() => send(e)} disabled={a.busy || !as}>{e}</button>)}
            <button className="btn small" style={{ justifyContent: "flex-start" }} onClick={() => send("what documents do you have")} disabled={a.busy || !as}>what documents do you have</button>
          </div>
          <Notice>Requests made here are marked <b>test</b> and are never delivered on WhatsApp. Files open with the customer's password.</Notice>
          <ErrorLine error={a.error} />
        </div>
      </div>
    </>
  );
}
