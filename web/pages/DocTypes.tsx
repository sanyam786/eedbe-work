import { useState } from "react";
import { api, type DocType } from "../api";
import { Drawer, Empty, ErrorLine, Field, Loading, PageHead, useAction, useApi, useWs } from "../ui";

const PERIOD_LABEL = { none: "No period", month: "Monthly", fy: "Yearly" } as const;

export function DocTypes() {
  const { org, isAdmin } = useWs();
  const list = useApi<{ docTypes: DocType[] }>(`/api/orgs/${org.id}/docbot/doc-types`);
  const [edit, setEdit] = useState<Partial<DocType> | null>(null);
  const files = list.data?.docTypes.filter((t) => !t.bundle) ?? [];
  const groups = list.data?.docTypes.filter((t) => t.bundle) ?? [];
  const row = (t: DocType) => (
    <tr key={t.key} className={isAdmin ? "click" : ""} onClick={() => isAdmin && setEdit(t)} style={t.active ? undefined : { opacity: 0.5 }}>
      <td><b>{t.label}</b><div className="small dim mono">{t.key}</div></td>
      <td>{t.bundle ? t.bundle.map((b) => <span key={b} className="tag" style={{ marginRight: 4 }}>{b}</span>) : PERIOD_LABEL[t.period_kind]}{t.identifier_kind && !t.bundle ? <div className="small dim">per {t.identifier_kind}</div> : null}</td>
      <td className="small">{t.aliases.slice(0, 6).join(", ")}{t.aliases.length > 6 ? "…" : ""}</td>
      <td>{t.bundle ? "" : t.documents}</td>
    </tr>
  );
  return (
    <>
      <PageHead title="Document types" sub="What customers can ask for, the words they use, and how files are recognised. Changes apply immediately."
        actions={isAdmin && <><button className="btn" onClick={() => setEdit({ bundle: [], period_kind: "fy" })}>Add request group</button><button className="btn primary" onClick={() => setEdit({ period_kind: "none" })}>Add document type</button></>} />
      {!list.data ? <Loading /> : (
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Document types</h2></div>
            {!files.length ? <Empty title="No document types" /> : <div className="table-wrap"><table className="table">
              <thead><tr><th>Name</th><th>Period</th><th>Customers may say</th><th>On file</th></tr></thead><tbody>{files.map(row)}</tbody></table></div>}
          </div>
          <div className="card">
            <div className="card-head"><h2>Request groups</h2><span className="right small muted">One word that sends several types, e.g. “ITR” → acknowledgement + computation</span></div>
            {!groups.length ? <Empty title="No groups" /> : <div className="table-wrap"><table className="table">
              <thead><tr><th>Name</th><th>Sends</th><th>Customers may say</th><th></th></tr></thead><tbody>{groups.map(row)}</tbody></table></div>}
          </div>
        </div>
      )}
      {edit && <DocTypeEditor t={edit} all={files} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void list.reload(); }} />}
    </>
  );
}

function DocTypeEditor({ t, all, onClose, onSaved }: { t: Partial<DocType>; all: DocType[]; onClose: () => void; onSaved: () => void }) {
  const { org, toast } = useWs();
  const isNew = !t.key;
  const isGroup = Boolean(t.bundle);
  const [f, setF] = useState({
    key: t.key ?? "", label: t.label ?? "", periodKind: t.period_kind ?? "none", identifierKind: t.identifier_kind ?? "",
    aliases: (t.aliases ?? []).join(", "), textPatterns: (t.text_patterns ?? []).join("\n"), pathPatterns: (t.path_patterns ?? []).join("\n"),
    bundle: t.bundle ?? [], bundleOptional: t.bundle_optional ?? [], priority: t.priority ?? 100, active: t.active ?? true,
  });
  const a = useAction();
  const selectable = org.settings.identifierKinds.filter((k) => k.selectable);
  const save = async () => {
    const payload = { ...f, bundle: isGroup ? f.bundle : null, identifierKind: f.identifierKind || null };
    const ok = await a.run(() => isNew ? api.post(`/api/orgs/${org.id}/docbot/doc-types`, payload) : api.put(`/api/orgs/${org.id}/docbot/doc-types/${t.key}`, payload));
    if (ok) { toast("Saved"); onSaved(); }
  };
  const remove = async () => {
    if (!confirm(`Delete ${f.label}?`)) return;
    if (await a.run(() => api.del(`/api/orgs/${org.id}/docbot/doc-types/${t.key}`))) { toast("Deleted"); onSaved(); }
  };
  const toggle = (list: string[], k: string) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);
  return (
    <Drawer title={isNew ? (isGroup ? "New request group" : "New document type") : f.label} onClose={onClose}
      footer={<>{!isNew && <button className="btn danger" onClick={remove} disabled={a.busy}>Delete</button>}<span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={a.busy}>Save</button></>}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Name"><input type="text" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="e.g. Policy document" /></Field>
          <Field label="Key" help={isNew ? "CAPITALS, used in file names" : "Can't be changed"}>
            <input type="text" className="mono" value={f.key} disabled={!isNew} onChange={(e) => setF({ ...f, key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })} placeholder="POLICY" /></Field>
        </div>
        {!isGroup && (
          <div className="form-grid">
            <Field label="Period" help="Yearly = financial year">
              <select value={f.periodKind} onChange={(e) => setF({ ...f, periodKind: e.target.value as any })}>
                <option value="none">No period (e.g. certificate)</option><option value="month">Monthly / quarterly</option><option value="fy">Yearly</option>
              </select></Field>
            {selectable.length > 0 && <Field label="Belongs to" help="For documents filed per registration">
              <select value={f.identifierKind} onChange={(e) => setF({ ...f, identifierKind: e.target.value })}>
                <option value="">The customer</option>{selectable.map((k) => <option key={k.key} value={k.key}>One {k.label}</option>)}
              </select></Field>}
          </div>
        )}
        <Field label="Words customers use" help="Comma-separated. Spaces, hyphens and dots are treated alike, so “gstr 3b” also matches “GSTR-3B”.">
          <textarea value={f.aliases} onChange={(e) => setF({ ...f, aliases: e.target.value })} placeholder="policy, policy copy, bima" /></Field>
        {isGroup ? (
          <div className="stack" style={{ gap: 6 }}>
            <b style={{ fontSize: 13 }}>Sends</b>
            {all.map((x) => (
              <div key={x.key} className="row">
                <label className="check" style={{ flex: 1 }}><input type="checkbox" checked={f.bundle.includes(x.key)} onChange={() => setF({ ...f, bundle: toggle(f.bundle, x.key) })} />{x.label}</label>
                {f.bundle.includes(x.key) && <label className="check small"><input type="checkbox" checked={f.bundleOptional.includes(x.key)} onChange={() => setF({ ...f, bundleOptional: toggle(f.bundleOptional, x.key) })} />only if on file</label>}
              </div>
            ))}
          </div>
        ) : (
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Recognising files (advanced)</summary>
            <div className="stack" style={{ marginTop: 12 }}>
              <Field label="Text in the PDF" help="Regular expressions, one per line, case-insensitive. e.g. POLICY\s+SCHEDULE">
                <textarea className="mono" value={f.textPatterns} onChange={(e) => setF({ ...f, textPatterns: e.target.value })} /></Field>
              <Field label="File or folder name" help="Used for scans without text. e.g. policy">
                <textarea className="mono" value={f.pathPatterns} onChange={(e) => setF({ ...f, pathPatterns: e.target.value })} /></Field>
              <Field label="Check order" help="Lower numbers are tried first — put specific types before general ones">
                <input type="number" value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })} /></Field>
            </div>
          </details>
        )}
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Active</label>
        <ErrorLine error={a.error} />
      </div>
    </Drawer>
  );
}
