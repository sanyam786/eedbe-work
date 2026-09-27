import { useState } from "react";
import { Empty, fmtDate, Loading, PageHead, phoneFmt, Seg, useApi, useWs } from "../ui";

export function describeEvent(a: any): string {
  const d = a.detail ?? {};
  switch (a.event) {
    case "message": return a.direction === "in" ? `“${d.text ?? d.replyId ?? `(${d.type})`}”` : `Replied: ${String(d.text ?? "").split("\n")[0].slice(0, 90)}`;
    case "document_sent": return `Sent ${d.filename ?? "a document"}${d.template ? " (template)" : ""}`;
    case "unknown_number": return `Unregistered number wrote: “${d.text ?? ""}”`;
    case "asked_which": return "Asked which business/registration";
    case "delivery_blocked_24h": return "Couldn't deliver: 24-hour window closed and no template";
    case "lock_failed": return "Couldn't password-protect a file (not sent)";
    default: return a.event.replace(/_/g, " ");
  }
}

export function Activity() {
  const { org } = useWs();
  const [mode, setMode] = useState<"hide" | "only" | "all">("hide");
  const [phone, setPhone] = useState("");
  const digits = phone.replace(/\D/g, "");
  const q = `test=${mode === "all" ? "" : mode}${digits.length >= 10 ? `&phone=${digits.length === 10 ? "91" + digits : digits}` : ""}`;
  const list = useApi<{ activity: any[] }>(`/api/orgs/${org.id}/docbot/activity?${q}`, [q]);
  return (
    <>
      <PageHead title="Activity" sub="Every message received and every document sent — the audit trail for your WhatsApp number." />
      <div className="row" style={{ marginBottom: 12 }}>
        <Seg value={mode} onChange={setMode} options={[["hide", "Real WhatsApp"], ["only", "Test chat"], ["all", "Both"]]} />
        <input type="search" placeholder="Filter by phone" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ maxWidth: 220 }} />
      </div>
      <div className="card">
        {!list.data ? <Loading /> : !list.data.activity.length ? <Empty title="No activity yet" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
            <tbody>{list.data.activity.map((a) => (
              <tr key={a.id}>
                <td className="small dim" style={{ whiteSpace: "nowrap" }}>{fmtDate(a.at)}</td>
                <td style={{ whiteSpace: "nowrap" }}>{a.contact ?? (a.phone ? phoneFmt(a.phone) : "System")}{a.contact && <div className="small dim">{phoneFmt(a.phone)}</div>}</td>
                <td>
                  <span className={`pill ${a.direction === "in" ? "blue" : a.event === "document_sent" ? "green" : ""}`} style={{ marginRight: 6 }}>{a.direction === "in" ? "in" : a.direction === "out" ? "out" : "system"}</span>
                  {a.simulated && <span className="pill" style={{ marginRight: 6 }}>test</span>}
                  {describeEvent(a)}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
