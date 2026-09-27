import { Link } from "react-router-dom";
import { Checklist } from "./Home";
import { fmtDate, Loading, PageHead, phoneFmt, useApi, useWs } from "../ui";
import { describeEvent } from "./Activity";

export function Overview({ data }: { data?: any }) {
  const { org, base } = useWs();
  const act = useApi<any>(`/api/orgs/${org.id}/docbot/activity?test=hide`);
  if (!data) return <Loading />;
  const c = data.counts;
  const max = Math.max(1, ...data.daily.map((d: any) => d.sent));
  const setupLeft = data.setup.filter((s: any) => !s.done).length;
  return (
    <>
      <PageHead title="WhatsApp Document Assistant"
        sub={org.settings.whatsapp.displayNumber ? `Live on ${org.settings.whatsapp.displayNumber}` : "Not connected to a WhatsApp number yet — use the test chat meanwhile."}
        actions={<><Link className="btn" to={`${base}/whatsapp/test-chat`}>Open test chat</Link><Link className="btn primary" to={`${base}/whatsapp/documents`}>Upload documents</Link></>} />
      <div className="stack">
        <div className="grid grid-4 stats">
          <div className="card stat"><div className="label">Documents sent (7 days)</div><div className="value">{c.sent_7d}</div><div className="hint">to {c.people_7d} people</div></div>
          <div className="card stat"><div className="label">Documents on file</div><div className="value">{c.documents}</div><div className="hint">{c.customers} customers · {c.numbers} numbers</div></div>
          <Link to={`${base}/whatsapp/documents?tab=review`} className={`card stat${c.review ? " warn" : ""}`} style={{ color: "inherit", textDecoration: "none" }}>
            <div className="label">Files to check</div><div className="value">{c.review}</div><div className="hint">couldn't be placed automatically</div></Link>
          <Link to={`${base}/whatsapp/requests`} className={`card stat${c.waiting + c.approvals ? " warn" : ""}`} style={{ color: "inherit", textDecoration: "none" }}>
            <div className="label">Waiting requests</div><div className="value">{c.waiting + c.approvals}</div><div className="hint">{c.waiting} missing · {c.approvals} to approve</div></Link>
        </div>

        <div className="grid grid-2">
          <div className="card">
            <div className="card-head"><h2>Documents sent</h2><span className="right muted small">last 14 days</span></div>
            <div className="card-pad">
              <div className={`bars${data.daily.some((d: any) => d.sent) ? "" : " chart-empty"}`} role="img" aria-label="Documents sent per day">
                {data.daily.map((d: any) => (
                  <div key={d.day} className={`bar${d.sent ? "" : " zero"}`} style={{ height: `${(d.sent / max) * 100}%` }} title={`${d.day}: ${d.sent} sent, ${d.messages} messages`} />
                ))}
              </div>
              <div className="bars-x">{data.daily.map((d: any, i: number) => <span key={d.day}>{i % 2 === 0 ? Number(d.day.slice(8)) : ""}</span>)}</div>
            </div>
          </div>
          {setupLeft > 0 ? (
            <div className="card">
              <div className="card-head"><h2>Setup</h2><span className="right muted small">{data.setup.length - setupLeft} of {data.setup.length} done</span></div>
              <div className="card-pad" style={{ paddingTop: 4, paddingBottom: 4 }}><Checklist items={data.setup} /></div>
            </div>
          ) : (
            <div className="card card-pad stack">
              <h2>All set up</h2>
              <p className="muted">Customers can message {org.settings.whatsapp.displayNumber || "your number"} any time. Missing documents are chased and sent as soon as they're uploaded.</p>
              {data.drive && <p className="small dim">Google Drive last checked {fmtDate(data.drive.at)} · {data.drive.indexed} new · {data.drive.remaining} waiting</p>}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head"><h2>Recent activity</h2><Link className="right small" to={`${base}/whatsapp/activity`}>See all</Link></div>
          {act.data?.activity.length ? (
            <table className="table"><tbody>
              {act.data.activity.slice(0, 8).map((a: any) => (
                <tr key={a.id}><td className="dim small" style={{ width: 130 }}>{fmtDate(a.at)}</td>
                  <td style={{ width: 200 }}>{a.contact ?? phoneFmt(a.phone) ?? "System"}</td><td>{describeEvent(a)}</td></tr>
              ))}
            </tbody></table>
          ) : <div className="empty small">No real WhatsApp activity yet.</div>}
        </div>
      </div>
    </>
  );
}
