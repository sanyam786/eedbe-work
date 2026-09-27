import { useState } from "react";
import { api } from "../api";
import { Drawer, Empty, ErrorLine, Field, Loading, Notice, PageHead, phoneFmt, useAction, useApi, useWs } from "../ui";

interface Customer {
  id?: number; name: string; entity_type: string; key_date: string | null; requires_approval: boolean;
  identifiers: { kind: string; value: string; label: string | null }[]; contacts: { phone: string; name: string | null }[]; documents?: number;
}

export function Customers() {
  const { org } = useWs();
  const [q, setQ] = useState("");
  const list = useApi<{ customers: Customer[] }>(`/api/orgs/${org.id}/docbot/customers?q=${encodeURIComponent(q)}`, [q]);
  const [edit, setEdit] = useState<Customer | null>(null);
  const [importing, setImporting] = useState(false);
  const kinds = org.settings.identifierKinds;
  const blank = (): Customer => ({ name: "", entity_type: org.settings.entityTypes[0] ?? "individual", key_date: null, requires_approval: false, identifiers: [], contacts: [{ phone: "", name: "" }] });

  return (
    <>
      <PageHead title="Customers" sub="Who can ask for documents, and which WhatsApp numbers may receive them. A number only ever gets documents of the customers linked to it."
        actions={<><button className="btn" onClick={() => setImporting(true)}>Import CSV</button><button className="btn primary" onClick={() => setEdit(blank())}>Add customer</button></>} />
      <div className="card">
        <div className="card-head"><input type="search" placeholder={`Search name, ${kinds.map((k) => k.label).join(", ")} or phone`} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 380 }} /></div>
        {list.error && <div className="card-pad"><ErrorLine error={list.error} /></div>}
        {!list.data ? <Loading /> : !list.data.customers.length ? (
          <Empty title={q ? "No matches" : "No customers yet"}>{!q && <p>Add them one by one, or import a CSV exported from Excel.</p>}</Empty>
        ) : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Customer</th>{kinds.map((k) => <th key={k.key}>{k.label}</th>)}<th>WhatsApp numbers</th><th>Docs</th></tr></thead>
            <tbody>{list.data.customers.map((c) => (
              <tr key={c.id} className="click" onClick={() => setEdit(c)}>
                <td><b>{c.name}</b><div className="small dim">{c.entity_type}{c.requires_approval ? " · needs approval" : ""}</div></td>
                {kinds.map((k) => <td key={k.key}>{c.identifiers.filter((i) => i.kind === k.key).map((i) => <div key={i.value}><span className="tag">{i.value}</span>{i.label && i.label !== c.name ? <span className="small dim"> {i.label}</span> : null}</div>)}</td>)}
                <td>{c.contacts.map((p) => <div key={p.phone} className="small">{phoneFmt(p.phone)}{p.name ? <span className="dim"> · {p.name}</span> : null}</div>)}</td>
                <td>{c.documents}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {edit && <CustomerEditor customer={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void list.reload(); }} />}
      {importing && <ImportCsv onClose={() => setImporting(false)} onDone={() => void list.reload()} />}
    </>
  );
}

function CustomerEditor({ customer, onClose, onSaved }: { customer: Customer; onClose: () => void; onSaved: () => void }) {
  const { org, toast } = useWs();
  const s = org.settings;
  const [c, setC] = useState<Customer>(() => ({ ...customer, contacts: customer.contacts.length ? customer.contacts : [{ phone: "", name: "" }] }));
  const [keyDate, setKeyDate] = useState(customer.key_date ? customer.key_date.split("-").reverse().join("-") : "");
  const a = useAction();
  const setIds = (kind: string, list: { value: string; label: string | null }[]) =>
    setC({ ...c, identifiers: [...c.identifiers.filter((i) => i.kind !== kind), ...list.map((x) => ({ kind, ...x }))] });

  const save = async () => {
    const payload = {
      name: c.name, entityType: c.entity_type, keyDate: keyDate || null, requiresApproval: c.requires_approval,
      identifiers: c.identifiers.filter((i) => i.value.trim()), contacts: c.contacts.filter((x) => x.phone.trim()),
    };
    const ok = await a.run(() => customer.id ? api.put(`/api/orgs/${org.id}/docbot/customers/${customer.id}`, payload) : api.post(`/api/orgs/${org.id}/docbot/customers`, payload));
    if (ok) { toast("Customer saved"); onSaved(); }
  };
  const remove = async () => {
    if (!confirm(`Remove ${c.name}? Their numbers will stop receiving documents. Documents stay on file.`)) return;
    if (await a.run(() => api.del(`/api/orgs/${org.id}/docbot/customers/${customer.id}`))) { toast("Customer removed"); onSaved(); }
  };

  return (
    <Drawer title={customer.id ? c.name || "Customer" : "New customer"} onClose={onClose}
      footer={<>{customer.id && <button className="btn danger" onClick={remove} disabled={a.busy}>Remove</button>}<span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={a.busy}>{a.busy ? "Saving…" : "Save"}</button></>}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Name" full><input type="text" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} autoFocus /></Field>
          <Field label="Type"><select value={c.entity_type} onChange={(e) => setC({ ...c, entity_type: e.target.value })}>
            {[...new Set([...s.entityTypes, c.entity_type])].map((t) => <option key={t} value={t}>{t}</option>)}</select></Field>
          <Field label={s.keyDateLabel} help={s.pdfPassword.mode === "id_date" ? "DD-MM-YYYY · part of the PDF password" : "DD-MM-YYYY"}>
            <input type="text" placeholder="DD-MM-YYYY" value={keyDate} onChange={(e) => setKeyDate(e.target.value)} /></Field>
        </div>
        {s.identifierKinds.map((k) => {
          const mine = c.identifiers.filter((i) => i.kind === k.key);
          const rows = k.selectable ? [...mine, ...(mine.length ? [] : [{ kind: k.key, value: "", label: null }])] : [mine[0] ?? { kind: k.key, value: "", label: null }];
          return (
            <div key={k.key} className="stack" style={{ gap: 6 }}>
              <b>{k.label}{k.primary ? <span className="dim small"> · main ID</span> : null}</b>
              {rows.map((r, i) => (
                <div className="row" key={i}>
                  <input type="text" style={{ flex: 2, fontFamily: "var(--mono)" }} value={r.value} placeholder={k.label}
                    onChange={(e) => { const next = [...rows]; next[i] = { ...r, value: e.target.value.toUpperCase() }; setIds(k.key, next); }} />
                  {k.selectable && <input type="text" style={{ flex: 2 }} value={r.label ?? ""} placeholder="Name shown to the customer (e.g. trade name)"
                    onChange={(e) => { const next = [...rows]; next[i] = { ...r, label: e.target.value }; setIds(k.key, next); }} />}
                  {k.selectable && rows.length > 1 && <button className="btn small ghost" onClick={() => setIds(k.key, rows.filter((_, j) => j !== i))} aria-label="Remove">✕</button>}
                </div>
              ))}
              {k.selectable && <button className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => setIds(k.key, [...rows, { value: "", label: null }])}>+ Add another {k.label}</button>}
            </div>
          );
        })}
        <div className="stack" style={{ gap: 6 }}>
          <b>WhatsApp numbers that may receive this customer's documents</b>
          {c.contacts.map((p, i) => (
            <div className="row" key={i}>
              <input type="text" style={{ flex: 1 }} value={p.phone} placeholder="98123 45678" onChange={(e) => { const n = [...c.contacts]; n[i] = { ...p, phone: e.target.value }; setC({ ...c, contacts: n }); }} />
              <input type="text" style={{ flex: 1 }} value={p.name ?? ""} placeholder="Person's name" onChange={(e) => { const n = [...c.contacts]; n[i] = { ...p, name: e.target.value }; setC({ ...c, contacts: n }); }} />
              <button className="btn small ghost" onClick={() => setC({ ...c, contacts: c.contacts.filter((_, j) => j !== i) })} aria-label="Remove">✕</button>
            </div>
          ))}
          <button className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => setC({ ...c, contacts: [...c.contacts, { phone: "", name: "" }] })}>+ Add number</button>
          <p className="small dim">10-digit Indian numbers get +91 automatically. One number can be linked to several customers (e.g. a person and their firm).</p>
        </div>
        <label className="check"><input type="checkbox" checked={c.requires_approval} onChange={(e) => setC({ ...c, requires_approval: e.target.checked })} />
          <span>Staff must approve every document before it's sent<br /><span className="small dim">The customer is told the request is with the office.</span></span></label>
        <ErrorLine error={a.error} />
      </div>
    </Drawer>
  );
}

function ImportCsv({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { org } = useWs();
  const kinds = org.settings.identifierKinds;
  const [result, setResult] = useState<any>();
  const a = useAction();
  const header = ["phone", "contact_name", "customer_name", "customer_type", "key_date", ...kinds.map((k) => k.key.toLowerCase()),
    ...(kinds.some((k) => k.selectable) ? ["trade_name"] : []), "requires_approval"];
  const template = header.join(",") + "\n" + ["9812345678", "Ramesh Sharma", "Ramesh Sharma", org.settings.entityTypes[0] ?? "individual", "15-08-1975",
    ...kinds.map(() => ""), ...(kinds.some((k) => k.selectable) ? [""] : []), ""].join(",") + "\n";
  const onFile = async (f?: File) => {
    if (!f) return;
    const r = await a.run(async () => api.post(`/api/orgs/${org.id}/docbot/customers/import`, { csv: await f.text() }));
    if (r) { setResult(r); onDone(); }
  };
  return (
    <Drawer title="Import customers" onClose={onClose} footer={<button className="btn" onClick={onClose}>Done</button>}>
      <div className="stack">
        <p className="muted">One row per WhatsApp number and customer it may receive. Importing again updates existing customers instead of duplicating them.</p>
        <div className="card card-pad" style={{ overflowX: "auto" }}><code style={{ whiteSpace: "pre" }}>{header.join(", ")}</code></div>
        <a className="btn small" style={{ alignSelf: "flex-start" }} download="customers-template.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(template)}`}>Download template</a>
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Dates as DD-MM-YYYY.</li>
          {kinds.some((k) => k.selectable) && <li>A customer with several {kinds.find((k) => k.selectable)!.label}s: repeat the row, one per {kinds.find((k) => k.selectable)!.label}, with its trade_name.</li>}
          <li>requires_approval: yes for customers whose documents staff must approve.</li>
        </ul>
        <label className="upload-zone" style={{ cursor: "pointer" }}>
          <input type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => onFile(e.target.files?.[0])} />
          <b>{a.busy ? "Importing…" : "Choose CSV file"}</b><div className="small dim">Save from Excel as “CSV UTF-8”</div>
        </label>
        <ErrorLine error={a.error} />
        {result && <Notice kind={result.errors.length ? "warn" : "ok"}>
          Imported {result.rows} rows: {result.customers} customers, {result.numbers} numbers.
          {result.errors.length > 0 && <><br /><b>{result.errors.length} rows skipped:</b><ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{result.errors.slice(0, 20).map((e: string) => <li key={e}>{e}</li>)}</ul></>}
        </Notice>}
      </div>
    </Drawer>
  );
}

