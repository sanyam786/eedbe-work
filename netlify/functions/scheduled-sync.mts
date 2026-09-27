// Every 5 minutes: pick up new/changed PDFs from each workspace's Google Drive, and tidy old records.
// Scheduled functions may run for 30 seconds; the sync resumes where it stopped on the next run.
import { query } from "../../server/db.js";
import { loadOrg } from "../../server/orgs.js";
import { syncDrive } from "../../server/docbot/indexer.js";

export default async () => {
  const started = Date.now();
  const orgs = await query<{ id: string }>(
    `SELECT o.id FROM orgs o JOIN org_features f ON f.org_id=o.id AND f.feature='whatsapp_docbot' AND f.enabled
      WHERE o.settings->'storage'->>'driver' = 'google_drive' ORDER BY random()`);
  for (const { id } of orgs) {
    const left = 24_000 - (Date.now() - started);
    if (left < 3_000) break;
    const org = await loadOrg(id);
    if (!org?.settings.storage.driveId || !org.secrets.googleServiceAccount) continue;
    try {
      const r = await syncDrive(org, { budgetMs: Math.min(left - 2_000, 15_000) });
      if (r.indexed || r.review || r.failed) console.log(`[sync] ${org.name}`, r);
    } catch (e) {
      console.error(`[sync] ${org.name}:`, (e as Error).message);
    }
  }
  await query(`DELETE FROM processed_messages WHERE received_at < now() - interval '14 days'`);
  await query(`DELETE FROM chat_sessions WHERE expires_at < now() - interval '1 day'`);
  await query(`DELETE FROM login_attempts WHERE at < now() - interval '2 days'`);
};

export const config = { schedule: "*/5 * * * *" };
