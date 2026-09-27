import { Field, PageHead, Seg, useWs } from "../ui";
import { SaveBar, useSettingsForm } from "./settingsKit";
import { MONTH_NAMES } from "../../server/docbot/periods";

export function AssistantSetup() {
  const { org } = useWs();
  const form = useSettingsForm();
  const { s, set } = form;
  const primary = s.identifierKinds.find((k) => k.primary);
  const fyExample = s.fyStartMonth === 1 ? "2024" : `2024-${String((2025) % 100).padStart(2, "0")}`;
  return (
    <>
      <PageHead title="Replies & rules" sub="How the assistant understands requests, protects files and talks to customers." />
      <div className="stack" style={{ maxWidth: 820 }}>
        <div className="card card-pad stack">
          <h2>Years</h2>
          <div className="form-grid">
            <Field label="Financial year starts in">
              <select value={s.fyStartMonth} onChange={(e) => set((d) => { d.fyStartMonth = Number(e.target.value); })}>
                {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}{i === 3 ? " (India)" : i === 0 ? " (calendar year)" : ""}</option>)}
              </select>
            </Field>
            <Field label="Assessment years" help="Indian income tax: AY = FY + 1">
              <label className="check" style={{ fontWeight: 400 }}><input type="checkbox" checked={s.showAssessmentYear} onChange={(e) => set((d) => { d.showAssessmentYear = e.target.checked; })} />Show and understand AY (e.g. “AY 2025-26”)</label>
            </Field>
            {s.showAssessmentYear && (
              <div className="full stack" style={{ gap: 6 }}>
                <b style={{ fontSize: 13 }}>When a customer writes just “{fyExample}” (without FY or AY), it means</b>
                <Seg value={s.bareYearMeans} onChange={(v) => set((d) => { d.bareYearMeans = v; })} options={[["fy", "Financial year"], ["ay", "Assessment year"]]} />
                <span className="small dim">
                  {s.bareYearMeans === "fy" ? `“ITR ${fyExample}” sends the return for income earned in FY 2024-25 (filed in AY 2025-26).` : `“ITR ${fyExample}” sends the return for AY 2024-25 (income of FY 2023-24).`}
                  {" "}Customers who say “AY” or “FY” explicitly always get exactly that.
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="card card-pad stack">
          <h2>File protection</h2>
          <Seg value={s.pdfPassword.mode} onChange={(v) => set((d) => { d.pdfPassword.mode = v; })}
            options={[["id_date", `${primary?.label ?? "ID"} + date`], ["id", `${primary?.label ?? "ID"} only`], ["none", "No password"]]} />
          <p className="small muted">
            {s.pdfPassword.mode === "id_date" && <>Password = {primary?.label ?? "main ID"} in small letters followed by {s.keyDateLabel.toLowerCase()} as DDMMYYYY (e.g. <code>abcde1234f15081975</code>) — the same pattern as an ITR-V. Customers without a date get the {primary?.label ?? "ID"} alone.</>}
            {s.pdfPassword.mode === "id" && <>Password = {primary?.label ?? "main ID"} in small letters.</>}
            {s.pdfPassword.mode === "none" && <>Files are sent without a password. Not recommended for financial documents.</>}
            {" "}Files already locked by a government portal are sent as they are.
          </p>
        </div>

        <div className="card card-pad stack">
          <h2>Messages</h2>
          <Field label="Greeting" help="First line of the reply to “hi”. Leave empty for the default.">
            <textarea value={s.welcomeMessage} placeholder={`Namaste 🙏 I'm the document assistant for *${s.businessName}*…`} onChange={(e) => set((d) => { d.welcomeMessage = e.target.value; })} />
          </Field>
          <Field label="Example requests shown to customers" help="One per line">
            <textarea value={s.examples.join("\n")} onChange={(e) => set((d) => { d.examples = e.target.value.split("\n").map((x) => x.trim()).filter(Boolean); })} />
          </Field>
          <Field label="Staff numbers to alert" help="Get a WhatsApp message when a document is missing or needs approval. Country code, digits only, comma-separated. (WhatsApp only delivers these if that person messaged the number in the last 24 hours.)">
            <input type="text" value={s.staffPhones.join(", ")} onChange={(e) => set((d) => { d.staffPhones = e.target.value.split(/[,\s]+/).map((x) => x.replace(/\D/g, "")).filter(Boolean); })} />
          </Field>
        </div>

        <div className="card card-pad stack">
          <h2>Limits</h2>
          <div className="form-grid">
            <Field label="Documents per number per hour"><input type="number" min={1} max={1000} value={s.limits.maxDocsPerHour} onChange={(e) => set((d) => { d.limits.maxDocsPerHour = Number(e.target.value); })} /></Field>
            <Field label="Documents per request"><input type="number" min={1} max={1000} value={s.limits.maxDocsPerRequest} onChange={(e) => set((d) => { d.limits.maxDocsPerRequest = Number(e.target.value); })} /></Field>
          </div>
        </div>

        <div className="card card-pad stack">
          <h2>AI</h2>
          <label className="check"><input type="checkbox" checked={s.ai.enabled} onChange={(e) => set((d) => { d.ai.enabled = e.target.checked; })} />
            <span>Use AI to understand messages<br /><span className="small dim">Handles Hindi, Hinglish, typos and unusual phrasing. Only the message and the customer's business names are sent — never ID numbers or documents. {org.aiAvailable ? "" : "Needs an AI key (Workspace → AI)."}</span></span></label>
          <label className="check"><input type="checkbox" checked={s.ai.classifyDocuments} onChange={(e) => set((d) => { d.ai.classifyDocuments = e.target.checked; })} />
            <span>Ask AI about files the rules can't place<br /><span className="small dim">Sends the text of those files to the AI. Leave off if that isn't acceptable for your customers' data.</span></span></label>
        </div>
        <SaveBar form={form} />
      </div>
    </>
  );
}
