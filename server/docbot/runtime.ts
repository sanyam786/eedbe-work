// Everything the bot and indexer need for one workspace, bundled together.

import { query } from "../db.js";
import type { Org } from "../orgs.js";
import { loadDocTypes, yearStyle, type DocType } from "./types.js";
import { DriveStorage, uploads } from "./storage.js";
import { WhatsAppMessenger, type Messenger } from "./messenger.js";
import type { YearStyle } from "./periods.js";

export interface Runtime {
  org: Org;
  types: DocType[];
  style: YearStyle;
  messenger: Messenger;
  now: Date;
  simulated: boolean;
  audit(e: { phone?: string; contactId?: number; direction: "in" | "out" | "system"; event: string; documentId?: number; detail?: unknown }): Promise<void>;
  readFile(doc: { storage: string; file_id: string }): Promise<Uint8Array>;
}

export function driveFor(org: Org) {
  const { driveId } = org.settings.storage;
  const key = org.secrets.googleServiceAccount;
  if (!driveId || !key) throw new Error("Google Drive isn't connected yet (Settings → Document storage)");
  return new DriveStorage(driveId, key);
}

// Tests and local development can swap the real WhatsApp sender for a recorder.
let messengerFactory: ((org: Org) => Messenger) | undefined;
export function setMessengerFactory(f: ((org: Org) => Messenger) | undefined) {
  messengerFactory = f;
}

export async function makeRuntime(org: Org, messenger?: Messenger, now = new Date()): Promise<Runtime> {
  const m = messenger ?? messengerFactory?.(org) ?? new WhatsAppMessenger(org.settings, org.secrets);
  let drive: DriveStorage | undefined;
  return {
    org,
    types: await loadDocTypes(org.id),
    style: yearStyle(org.settings),
    messenger: m,
    now,
    simulated: m.simulated,
    async audit(e) {
      await query(
        `INSERT INTO audit_log (org_id, phone, contact_id, direction, event, document_id, simulated, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [org.id, e.phone ?? null, e.contactId ?? null, e.direction, e.event, e.documentId ?? null, m.simulated,
         e.detail === undefined ? null : JSON.stringify(e.detail)]);
    },
    async readFile(doc) {
      if (doc.storage === "upload") return uploads.get(doc.file_id);
      drive ??= driveFor(org);
      return drive.download(doc.file_id);
    },
  };
}
