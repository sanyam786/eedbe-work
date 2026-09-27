import { Link } from "react-router-dom";
import { api } from "../api";
import { Icon, PageHead, useAction, useApi, useWs, ErrorLine } from "../ui";

export function Checklist({ items }: { items: { key: string; label: string; done: boolean; to: string }[] }) {
  const { base } = useWs();
  const next = items.find((i) => !i.done);
  return (
    <ul className="checklist">
      {items.map((i) => (
        <li key={i.key} className={i.done ? "done" : ""}>
          <span className={`tick${i.done ? " done" : ""}`}>{i.done ? "✓" : ""}</span>
          <span className="what">{i.label}</span>
          <span className="spacer" />
          {!i.done && <Link className={`btn small${i === next ? " primary" : ""}`} to={`${base}/${i.to}`}>{i === next ? "Start" : "Open"}</Link>}
        </li>
      ))}
    </ul>
  );
}

export function Home({ overview }: { overview?: any }) {
  const { org, base, isAdmin, reload, toast } = useWs();
  const cfg = useApi<any>("/api/config");
  const a = useAction();
  const toggle = async (key: string, enabled: boolean) => {
    if (await a.run(() => api.post(`/api/orgs/${org.id}/features/${key}`, { enabled }))) {
      await reload();
      toast(enabled ? "Feature turned on" : "Feature turned off");
    }
  };
  const setup = overview?.setup as any[] | undefined;
  const done = setup?.filter((s) => s.done).length ?? 0;
  return (
    <>
      <PageHead title={org.name} sub="Your workspace. Turn on the features you want; each one appears in the menu with its own dashboard and settings." />
      <div className="stack">
        {setup && done < setup.length && (
          <div className="card">
            <div className="card-head"><h2>Get the WhatsApp assistant live</h2><span className="right muted small">{done} of {setup.length} done</span></div>
            <div className="card-pad" style={{ paddingTop: 4, paddingBottom: 4 }}><Checklist items={setup} /></div>
          </div>
        )}
        <div>
          <h2 style={{ marginBottom: 10 }}>Features</h2>
          <ErrorLine error={a.error} />
          <div className="grid grid-3" style={{ marginTop: 8 }}>
            {cfg.data?.features.map((f: any) => {
              const on = Boolean(org.features[f.key]);
              return (
                <div className="card feature" key={f.key}>
                  <div className="row"><span className="icon"><Icon.chat /></span>{on ? <span className="pill green">On</span> : <span className="pill">Off</span>}</div>
                  <h3>{f.name}</h3>
                  <p className="muted small">{f.summary}</p>
                  <div className="row" style={{ marginTop: "auto" }}>
                    {on && <Link className="btn small primary" to={`${base}/whatsapp`}>Open</Link>}
                    {isAdmin && <button className="btn small" disabled={a.busy} onClick={() => toggle(f.key, !on)}>{on ? "Turn off" : "Turn on"}</button>}
                  </div>
                </div>
              );
            })}
            <div className="card feature soon">
              <span className="icon" style={{ background: "var(--line-2)", color: "var(--ink-3)" }}><Icon.spark /></span>
              <h3>More on the way</h3>
              <p className="muted small">Compliance calendar, document collection from customers, reminders and more will appear here as they're released.</p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
