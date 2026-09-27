import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type DocType } from "../api";
import { Drawer, Empty, ErrorLine, Field, fmtDate, Icon, Loading, Notice, PageHead, useAction, useApi, useWs } from "../ui";
import { ayLabel, fyLabel, fyRange, monthRange, fyStartOf } from "../../server/docbot/periods";

const TABS: [string, string][] = [["indexed", "On file"], ["review", "Needs checking"], ["missing", "Missing from storage"]];

export function Documents() {
  const { org, reload: reloadWs, isAdmin, toast } = useWs();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "indexed";
  const [q, setQ] = useState("");
  const list = useApi<{ documents: any[] }>(`/api/orgs/${org.id}/docbot/documents?status=${tab}&q=${encodeURIComponent(q)}`, [tab, q]);
  const [open, setOpen] = useState<any>(null);
  const a = useAction();
  const drive = org.settings.storage.driver === "google_drive";

  const recheck = async () => {
    const r = await a.run(() => api.post(`/api/orgs/${org.id}/docbot/documents/recheck`));
    if (r) { toast(`Checked ${r.checked}, placed ${r.fixed}`); void list.reload(); void reloadWs(); }
  };
  const sync = async (full: boolean) => {
    const r = await a.run(() => api.post(`/api/orgs/${org.id}/docbot/drive/sync`, { full }));
    if (r) { toast(`Drive: ${r.indexed} recognised, ${r.review} to check${r.remaining ? `, ${r.remaining} still to go` : ""}`); void list.reload(); void reloadWs(); }
  };

  return (
    <>
      <PageHead title="Documents"
        sub={drive ? "Files come from your Google Drive automatically every few minutes. Uploads here work too." : "Upload PDFs (or a whole folder). Each one is read and filed under the right customer, type and period."}
        actions={<>{drive && isAdmin && <button className="btn" disabled={a.busy} onClick={() => sync(false)}>{a.busy ? "Working…" : "Check Drive now"}</button>}</>} />
      <div className="stack">
        <Uploader onDone={() => { void list.reload(); void reloadWs(); }} />
        <ErrorLine error={a.error} />
        <div className="card">
          <div className="card-head" style={{ paddingBottom: 0, borderBottom: 0, flexWrap: "wrap" }}>
            <div className="tabs" style={{ marginBottom: 0 }}>
              {TABS.map(([k, l]) => <button key={k} className={tab === k ? "active" : ""} onClick={() => setParams(k === "indexed" ? {} : { tab: k })}>{l}</button>)}
            </div>
            <span className="spacer" />
            <input type="search" placeholder="Search file, customer or type" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
          </div>
          {tab === "review" && (list.data?.documents.length ?? 0) > 0 && (
            <div className="card-pad" style={{ borderTop: "1px solid var(--line-2)" }}>
              <div className="row"><span className="muted">These files couldn't be placed automatically. Open one to tell the assistant what it is — or add the missing customer and re-check.</span>
                <span className="spacer" /><button className="btn small" onClick={recheck} disabled={a.busy}>Re-check all</button></div>
            </div>
          )}
          {!list.data ? <Loading /> : !list.data.documents.length ? (
            <Empty title={tab === "review" ? "Nothing to check" : tab === "missing" ? "Nothing missing" : "No documents yet"}>
              {tab === "indexed" && <p>Upload PDFs above{drive ? " or wait for the next Drive check" : ""}.</p>}
            </Empty>
          ) : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Customer</th><th>Document</th><th>Period</th><th>File</th><th>{tab === "review" ? "Why" : "How"}</th></tr></thead>
              <tbody>{list.data.documents.map((d) => (
                <tr key={d.id} className="click" onClick={() => setOpen(d)}>
                  <td>{d.customer ?? <span className="dim">—</span>}{d.identifier && d.identifier_label ? <div className="small dim">{d.identifier_label}</div> : null}</td>
                  <td>{d.type_label ?? d.doc_type ?? <span className="dim">—</span>}</td>
                  <td>{d.period || <span className="dim">—</span>}</td>
                  <td className="small" style={{ maxWidth: 280, wordBreak: "break-word" }}>{d.file_path}{d.password_rule ? " 🔒" : ""}</td>
                  <td className="small">{tab === "review" ? <span style={{ color: "var(--amber)" }}>{d.review_reason}</span> : <span className="pill">{{ rules: "read", path: "folder name", ai: "AI", staff: "staff" }[d.classified_by as string] ?? d.classified_by}</span>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </div>
      {open && <DocumentDrawer doc={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); void list.reload(); void reloadWs(); }} />}
    </>
  );
}

function Uploader({ onDone }: { onDone: () => void }) {
  const { org } = useWs();
  const [drag, setDrag] = useState(false);
  const [state, setState] = useState<{ total: number; done: number; indexed: number; review: number; failed: string[] } | null>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const upload = async (files: { file: File; path: string }[]) => {
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.file.name));
    if (!pdfs.length) return;
    const s = { total: pdfs.length, done: 0, indexed: 0, review: 0, failed: [] as string[] };
    setState({ ...s });
    for (const f of pdfs) {
      const form = new FormData();
      form.append("file", f.file);
      form.append("path", f.path);
      try {
        const r = await api.post(`/api/orgs/${org.id}/docbot/documents/upload`, form);
        r.status === "indexed" ? s.indexed++ : s.review++;
      } catch (e) {
        s.failed.push(`${f.path}: ${(e as Error).message}`);
      }
      s.done++;
      setState({ ...s });
    }
    onDone();
  };

  const fromInput = (list: FileList | null) => upload([...(list ?? [])].map((f) => ({ file: f, path: (f as any).webkitRelativePath || f.name })));
  const fromDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDrag(false);
    const out: { file: File; path: string }[] = [];
    const walk = async (entry: any, prefix: string): Promise<void> => {
      if (entry.isFile) out.push({ file: await new Promise<File>((res, rej) => entry.file(res, rej)), path: prefix + entry.name });
      else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch: any[];
        do {
          batch = await new Promise<any[]>((res, rej) => reader.readEntries(res, rej));
          for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
        } while (batch.length);
      }
    };
    const items = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (items.length) for (const it of items) await walk(it, "");
    else [...e.dataTransfer.files].forEach((f) => out.push({ file: f, path: f.name }));
    await upload(out);
  };

  const busy = state && state.done < state.total;
  return (
    <div className={`upload-zone${drag ? " drag" : ""}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={fromDrop}>
      <div className="row" style={{ justifyContent: "center" }}>
        <Icon.upload />
        <b>Drop PDFs or a folder here</b>
        <span className="dim">or</span>
        <label className="btn small">Choose files<input type="file" accept="application/pdf" multiple hidden onChange={(e) => fromInput(e.target.files)} /></label>
        <button className="btn small" onClick={() => folderRef.current?.click()}>Choose folder</button>
        <input ref={folderRef} type="file" hidden {...({ webkitdirectory: "", directory: "" } as any)} onChange={(e) => fromInput(e.target.files)} />
      </div>
      <p className="small dim" style={{ marginTop: 6 }}>Folder names help: e.g. <code>Ramesh Sharma/ITR/AY 2025-26/ITR-V.pdf</code>. Up to 4 MB per file.</p>
      {state && (
        <div className="stack" style={{ gap: 6, marginTop: 12, textAlign: "left" }}>
          <div className="progress"><div style={{ width: `${(state.done / state.total) * 100}%` }} /></div>
          <div className="small">{busy ? `Uploading ${state.done + 1} of ${state.total}…` : `Done: ${state.indexed} filed, ${state.review} to check${state.failed.length ? `, ${state.failed.length} failed` : ""}.`}</div>
          {state.failed.slice(0, 5).map((f) => <div key={f} className="small" style={{ color: "var(--red)" }}>{f}</div>)}
        </div>
      )}
    </div>
  );
}

function DocumentDrawer({ doc, onClose, onChanged }: { doc: any; onClose: () => void; onChanged: () => void }) {
  const { org, toast } = useWs();
  const types = useApi<{ docTypes: DocType[] }>(`/api/orgs/${org.id}/docbot/doc-types`);
  const customers = useApi<{ customers: any[] }>(`/api/orgs/${org.id}/docbot/customers`);
  const style = { fyStartMonth: org.settings.fyStartMonth, showAssessmentYear: org.settings.showAssessmentYear };
  const [f, setF] = useState({
    entityId: doc.entity_id ? String(doc.entity_id) : "", identifierId: doc.identifier_id ? String(doc.identifier_id) : "",
    docType: doc.doc_type ?? "", fy: doc.period_start ? String(fyStartOf(new Date(doc.period_start + "T00:00:00"), style)) : "",
    month: doc.period_start ? doc.period_start.slice(0, 7) : "",
  });
  const a = useAction();
  const t = types.data?.docTypes.find((x) => x.key === f.docType);
  const cust = customers.data?.customers.find((c) => String(c.id) === f.entityId);
  const idsOfKind = cust && t?.identifier_kind ? cust.identifiers.filter((i: any) => i.kind === t.identifier_kind) : [];
  const thisFy = fyStartOf(new Date(), style);
  const years = Array.from({ length: 12 }, (_, i) => thisFy - i);

  const save = async () => {
    let periodStart: string | null = null, periodEnd: string | null = null;
    if (t?.period_kind === "fy" && f.fy) ({ start: periodStart, end: periodEnd } = fyRange(Number(f.fy), style));
    if (t?.period_kind === "month" && f.month) ({ start: periodStart, end: periodEnd } = monthRange(Number(f.month.slice(0, 4)), Number(f.month.slice(5, 7))));
    const ok = await a.run(() => api.patch(`/api/orgs/${org.id}/docbot/documents/${doc.id}`, {
      entityId: Number(f.entityId), identifierId: f.identifierId ? Number(f.identifierId) : null, docType: f.docType, periodStart, periodEnd,
    }));
    if (ok) { toast("Document filed"); onChanged(); }
  };
  const remove = async () => {
    if (!confirm(doc.storage === "upload" ? "Delete this uploaded file?" : "Remove this file from the list? (It stays in Google Drive and will come back if changed.)")) return;
    if (await a.run(() => api.del(`/api/orgs/${org.id}/docbot/documents/${doc.id}`))) { toast("Removed"); onChanged(); }
  };

  return (
    <Drawer title={doc.file_name} onClose={onClose}
      footer={<><button className="btn danger" onClick={remove} disabled={a.busy}>Delete</button><span className="spacer" />
        <a className="btn" href={`/api/orgs/${org.id}/docbot/documents/${doc.id}/file`} target="_blank" rel="noreferrer">View PDF</a>
        <button className="btn primary" onClick={save} disabled={a.busy || !f.entityId || !f.docType}>{doc.status === "indexed" ? "Save changes" : "File it"}</button></>}>
      <div className="stack">
        <div className="small muted">{doc.file_path} · {doc.storage === "upload" ? "uploaded" : "Google Drive"} · updated {fmtDate(doc.updated_at)}</div>
        {doc.review_reason && <Notice kind="warn">{doc.review_reason}</Notice>}
        {doc.password_rule && <Notice>This PDF was already password-locked (by the portal). It's sent as it is.</Notice>}
        <Field label="Customer">
          <select value={f.entityId} onChange={(e) => setF({ ...f, entityId: e.target.value, identifierId: "" })}>
            <option value="">Choose…</option>
            {customers.data?.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Document type">
          <select value={f.docType} onChange={(e) => setF({ ...f, docType: e.target.value })}>
            <option value="">Choose…</option>
            {types.data?.docTypes.filter((x) => !x.bundle && x.active).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        </Field>
        {t?.identifier_kind && cust && (
          <Field label={`Which ${t.identifier_kind}`}>
            <select value={f.identifierId} onChange={(e) => setF({ ...f, identifierId: e.target.value })}>
              <option value="">{idsOfKind.length === 1 ? idsOfKind[0].value : "Choose…"}</option>
              {idsOfKind.map((i: any) => <option key={i.id} value={String(i.id)}>{i.value}{i.label ? ` · ${i.label}` : ""}</option>)}
            </select>
          </Field>
        )}
        {t?.period_kind === "fy" && (
          <Field label="Year"><select value={f.fy} onChange={(e) => setF({ ...f, fy: e.target.value })}>
            <option value="">Choose…</option>
            {years.map((y) => <option key={y} value={y}>{style.showAssessmentYear ? `${ayLabel(y)} (${fyLabel(y, style)})` : fyLabel(y, style)}</option>)}
          </select></Field>
        )}
        {t?.period_kind === "month" && <Field label="Month"><input type="month" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} /></Field>}
        <ErrorLine error={a.error} />
      </div>
    </Drawer>
  );
}
