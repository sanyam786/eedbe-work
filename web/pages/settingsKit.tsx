import { useState, type ReactNode } from "react";
import { api, type Settings } from "../api";
import { ErrorLine, useAction, useWs } from "../ui";

/** Local, editable copy of workspace settings with a save button. */
export function useSettingsForm() {
  const { org, reload, toast } = useWs();
  const [s, setS] = useState<Settings>(() => structuredClone(org.settings));
  const [dirty, setDirty] = useState(false);
  const a = useAction();
  const set = (patch: (draft: Settings) => void) => {
    setS((prev) => { const next = structuredClone(prev); patch(next); return next; });
    setDirty(true);
  };
  const save = async (pick?: (s: Settings) => Partial<Settings>) => {
    const ok = await a.run(() => api.patch(`/api/orgs/${org.id}/settings`, pick ? pick(s) : s));
    if (ok) { setDirty(false); await reload(); toast("Saved"); }
    return Boolean(ok);
  };
  return { s, set, save, dirty, busy: a.busy, error: a.error };
}

export function SaveBar({ form, pick }: { form: ReturnType<typeof useSettingsForm>; pick?: (s: Settings) => Partial<Settings> }) {
  return (
    <div className="row" style={{ marginTop: 4 }}>
      <button className="btn primary" disabled={!form.dirty || form.busy} onClick={() => form.save(pick)}>{form.busy ? "Saving…" : "Save changes"}</button>
      {form.dirty && <span className="small dim">Unsaved changes</span>}
      <div style={{ flexBasis: "100%" }}><ErrorLine error={form.error} /></div>
    </div>
  );
}

/** A secret field: shows whether it's set (masked), and lets admins replace or clear it. */
export function SecretField({ name, label, help, multiline, value, onChange }: {
  name: string; label: string; help?: ReactNode; multiline?: boolean; value: string | undefined; onChange: (v: string | undefined) => void;
}) {
  const { org } = useWs();
  const info = org.secrets[name];
  const editing = value !== undefined;
  return (
    <div className="field" style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <b style={{ fontSize: 13 }}>{label}</b>
      {!editing ? (
        <div className="row">
          {info?.set ? <><span className="pill green">Set</span><span className="mono small">{info.preview}</span></> : <span className="pill amber">Not set</span>}
          <button type="button" className="btn small" onClick={() => onChange("")}>{info?.set ? "Replace" : "Add"}</button>
        </div>
      ) : (
        <div className="secret-row">
          {multiline
            ? <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder="Paste here" style={{ fontFamily: "var(--mono)", fontSize: 12 }} />
            : <input type="password" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Paste here" />}
          <button type="button" className="btn small ghost" onClick={() => onChange(undefined)}>Cancel</button>
        </div>
      )}
      {help && <span className="help" style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{help}</span>}
    </div>
  );
}

export async function saveSecrets(orgId: string, values: Record<string, string | undefined>) {
  const patch = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
  if (!Object.keys(patch).length) return;
  await api.put(`/api/orgs/${orgId}/secrets`, patch);
}
