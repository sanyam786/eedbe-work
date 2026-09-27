import { useState } from "react";
import { api } from "../api";
import { ErrorLine, Field, fmtDate, Notice, PageHead, Seg, useAction, useApi, useWs } from "../ui";
import { SecretField, saveSecrets, useSettingsForm } from "./settingsKit";

export function StorageSetup() {
  const { org, reload, toast } = useWs();
  const form = useSettingsForm();
  const { s, set } = form;
  const [key, setKey] = useState<string | undefined>();
  const [test, setTest] = useState<any>();
  const a = useAction();
  const overview = useApi<any>(`/api/orgs/${org.id}/docbot/overview`);
  const saEmail = org.secrets.googleServiceAccount?.set ? org.secrets.googleServiceAccount.preview : "";

  const save = async () => {
    const ok = await a.run(async () => {
      await saveSecrets(org.id, { googleServiceAccount: key });
      await api.patch(`/api/orgs/${org.id}/settings`, { storage: s.storage });
      return true;
    });
    if (ok) { setKey(undefined); await reload(); toast("Storage settings saved"); }
  };
  const check = async () => { setTest(undefined); const r = await a.run(() => api.post(`/api/orgs/${org.id}/docbot/storage/test`)); if (r) setTest(r); };
  const sync = async () => {
    const r = await a.run(() => api.post(`/api/orgs/${org.id}/docbot/drive/sync`, { full: true }));
    if (r) { toast(`${r.indexed} recognised, ${r.review} to check, ${r.skipped} unchanged${r.remaining ? `, ${r.remaining} more next run` : ""}`); void overview.reload(); await reload(); }
  };
  const onKeyFile = async (f?: File) => { if (f) setKey(await f.text()); };
  const driveIdFrom = (v: string) => (/folders\/([\w-]+)/.exec(v)?.[1] ?? v.trim());

  return (
    <>
      <PageHead title="Document storage" sub="Where the assistant finds your documents." />
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr)", alignItems: "start" }}>
        <div className="stack">
          <div className="card card-pad stack">
            <Seg value={s.storage.driver} onChange={(v) => set((d) => { d.storage.driver = v; })} options={[["upload", "Upload in the dashboard"], ["google_drive", "Google Drive"]]} />
            {s.storage.driver === "upload" ? (
              <p className="muted">Staff upload PDFs (or whole folders) on the Documents page. Good for trying things out and for small offices. Files are stored securely with the dashboard.</p>
            ) : (
              <>
                <p className="muted">The assistant checks a Google <b>Shared Drive</b> every 5 minutes, read-only. Staff keep saving files as usual (e.g. with Google Drive for desktop).</p>
                <Field label="Shared Drive ID or link" help="Open the Shared Drive in the browser and paste the address">
                  <input type="text" className="mono" value={s.storage.driveId} onChange={(e) => set((d) => { d.storage.driveId = driveIdFrom(e.target.value); })} />
                </Field>
                <SecretField name="googleServiceAccount" label="Service account key (JSON)" multiline value={key} onChange={setKey}
                  help={<>Paste the key file's contents, or <label style={{ color: "var(--brand)", cursor: "pointer" }}>choose the file<input type="file" accept=".json,application/json" hidden onChange={(e) => onKeyFile(e.target.files?.[0])} /></label>.</>} />
                {saEmail && <Notice>Share the Shared Drive with <b className="mono">{saEmail}</b> as <b>Viewer</b>.</Notice>}
              </>
            )}
            <div className="row">
              <button className="btn primary" onClick={save} disabled={a.busy}>{a.busy ? "Saving…" : "Save"}</button>
              {org.settings.storage.driver === "google_drive" && <>
                <button className="btn" onClick={check} disabled={a.busy}>Test connection</button>
                <button className="btn" onClick={sync} disabled={a.busy}>Scan whole Drive now</button>
              </>}
            </div>
            {test && <Notice kind="ok">Connected to <b>{test.driveName}</b>.{test.samplePdfs?.length ? <> Found PDFs such as {test.samplePdfs.slice(0, 3).join(", ")}.</> : " No PDFs found yet."}</Notice>}
            {overview.data?.drive && <p className="small dim">Last check {fmtDate(overview.data.drive.at)}: {overview.data.drive.indexed} new, {overview.data.drive.review} to check, {overview.data.drive.failed} failed{overview.data.drive.remaining ? `, ${overview.data.drive.remaining} waiting for the next run` : ""}.</p>}
            <ErrorLine error={a.error} />
          </div>
        </div>
        <div className="card card-pad stack">
          <h2>Setting up Google Drive (one time)</h2>
          <ol className="steps">
            <li><div><b>Google Workspace</b><br /><span className="muted small">Use a Google Workspace account for the business (a plan that includes Shared Drives), not a personal Gmail, so files belong to the business.</span></div></li>
            <li><div><b>Create a Shared Drive</b><br /><span className="muted small">drive.google.com → Shared drives → New, e.g. “Customer Documents”. Add staff as members.</span></div></li>
            <li><div><b>Move the office folders in</b><br /><span className="muted small">Install Google Drive for desktop on the office PC and move the existing customer folders into the Shared Drive. Staff keep saving there; the PC can be off.</span></div></li>
            <li><div><b>Service account</b><br /><span className="muted small">console.cloud.google.com → new project → enable <b>Google Drive API</b> → IAM & Admin → Service accounts → Create → Keys → Add key → JSON. Upload that file here.</span></div></li>
            <li><div><b>Share read-only</b><br /><span className="muted small">Add the service account's email to the Shared Drive as <b>Viewer</b>. The assistant can read, never change or delete.</span></div></li>
            <li><div><b>Keep a backup</b><br /><span className="muted small">Syncing isn't a backup: a deleted folder is deleted everywhere. Keep a separate periodic backup.</span></div></li>
          </ol>
        </div>
      </div>
    </>
  );
}
