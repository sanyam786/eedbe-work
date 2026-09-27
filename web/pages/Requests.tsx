import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Empty, ErrorLine, fmtDate, Loading, PageHead, phoneFmt, useAction, useApi, useWs } from "../ui";

export function Requests() {
  const { org, base, reload, toast } = useWs();
  const [status, setStatus] = useState("open");
  const list = useApi<{ requests: any[] }>(`/api/orgs/${org.id}/docbot/requests?status=${status}`, [status]);
  const a = useAction();
  const act = async (id: number, what: "approve" | "reject") => {
    const r = await a.run(() => api.post(`/api/orgs/${org.id}/docbot/requests/${id}/${what}`, what === "reject" ? { message: "The office will contact you about this request." } : {}));
    if (r) { toast(what === "approve" ? (r.note ?? "Sent on WhatsApp") : "Request closed"); void list.reload(); void reload(); }
  };
  return (
    <>
      <PageHead title="Requests" sub="Documents customers asked for that weren't on file yet, and requests waiting for approval. Uploading the missing file sends it automatically." />
      <div className="tabs">
        {[["open", "Waiting"], ["fulfilled", "Sent"], ["rejected", "Closed"]].map(([k, l]) => <button key={k} className={status === k ? "active" : ""} onClick={() => setStatus(k)}>{l}</button>)}
      </div>
      <ErrorLine error={a.error} />
      <div className="card" style={{ marginTop: 8 }}>
        {!list.data ? <Loading /> : !list.data.requests.length ? <Empty title={status === "open" ? "Nothing waiting" : "Nothing here yet"} /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Asked</th><th>By</th><th>Customer</th><th>Document</th><th>Status</th><th></th></tr></thead>
            <tbody>{list.data.requests.map((r) => (
              <tr key={r.id}>
                <td className="small">{fmtDate(r.created_at)}{r.raw_message && <div className="dim">“{r.raw_message}”</div>}</td>
                <td>{r.contact ?? ""}<div className="small dim">{phoneFmt(r.phone)}</div></td>
                <td>{r.customer}{r.identifier && <div className="small dim mono">{r.identifier}</div>}</td>
                <td>{r.type_label ?? r.doc_type}<div className="small dim">{r.period}</div></td>
                <td>
                  {r.simulated && <span className="pill blue">test chat</span>}{" "}
                  {r.reason === "approval" ? <span className="pill amber">needs approval</span> : <span className="pill">missing</span>}
                  {status === "open" && !r.simulated && !r.window_open && <div className="small dim" style={{ marginTop: 4 }}>24h chat window closed{org.settings.whatsapp.templateName ? " — will use template" : ""}</div>}
                </td>
                <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                  {status === "open" && r.reason === "approval" && <button className="btn small primary" disabled={a.busy} onClick={() => act(r.id, "approve")}>Approve & send</button>}{" "}
                  {status === "open" && r.reason === "missing" && <Link className="btn small" to={`${base}/whatsapp/documents`}>Upload</Link>}{" "}
                  {status === "open" && <button className="btn small ghost" disabled={a.busy} onClick={() => act(r.id, "reject")}>Close</button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
