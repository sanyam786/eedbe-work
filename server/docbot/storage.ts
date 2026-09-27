// Where document files live.
//   upload       -> files uploaded in the dashboard, kept in Netlify Blobs (a local folder in development)
//   google_drive -> a Google Shared Drive, read-only through a service account

import fs from "node:fs/promises";
import path from "node:path";
import { google, type drive_v3 } from "googleapis";

// ---------------------------------------------------------------- uploads

interface BlobBackend {
  set(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

class FolderBackend implements BlobBackend {
  constructor(private root: string) {}
  private file(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error("bad key");
    return p;
  }
  async set(key: string, data: Uint8Array) {
    await fs.mkdir(path.dirname(this.file(key)), { recursive: true });
    await fs.writeFile(this.file(key), data);
  }
  async get(key: string) {
    try { return new Uint8Array(await fs.readFile(this.file(key))); } catch { return null; }
  }
  async delete(key: string) { await fs.rm(this.file(key), { force: true }); }
}

let backend: BlobBackend | undefined;
async function blobs(): Promise<BlobBackend> {
  if (backend) return backend;
  if (process.env.BLOBS_LOCAL_DIR) return (backend = new FolderBackend(process.env.BLOBS_LOCAL_DIR));
  let store;
  try {
    const { getStore } = await import("@netlify/blobs");
    store = getStore({ name: "documents", consistency: "strong" });
  } catch {
    // Not running on Netlify: keep uploads in a local folder.
    return (backend = new FolderBackend(".data/uploads"));
  }
  backend = {
    set: async (k, d) => { await store.set(k, new Uint8Array(d).buffer as ArrayBuffer); },
    get: async (k) => { const b = await store.get(k, { type: "arrayBuffer" }); return b ? new Uint8Array(b) : null; },
    delete: async (k) => { await store.delete(k); },
  };
  return backend;
}

export const uploads = {
  async put(orgId: string, data: Uint8Array) {
    const key = `${orgId}/${crypto.randomUUID()}.pdf`;
    await (await blobs()).set(key, data);
    return key;
  },
  async get(key: string) {
    const b = await (await blobs()).get(key);
    if (!b) throw new Error("File not found in uploads");
    return b;
  },
  async delete(key: string) { await (await blobs()).delete(key); },
};

// ---------------------------------------------------------------- Google Drive

export interface DriveFile { id: string; path: string; name: string; modifiedAt: Date; size?: number }

export class DriveStorage {
  private drive: drive_v3.Drive;
  constructor(private driveId: string, serviceAccountJson: string) {
    const creds = JSON.parse(serviceAccountJson);
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
    this.drive = google.drive({ version: "v3", auth });
  }

  private common() {
    return { corpora: "drive", driveId: this.driveId, includeItemsFromAllDrives: true, supportsAllDrives: true, pageSize: 1000 } as const;
  }

  async test() {
    const d = await this.drive.drives.get({ driveId: this.driveId });
    const res = await this.drive.files.list({ ...this.common(), pageSize: 5, q: "mimeType='application/pdf' and trashed=false", fields: "files(name)" });
    return { driveName: d.data.name ?? "", samplePdfs: (res.data.files ?? []).map((f) => f.name ?? "") };
  }

  private async folders() {
    const map = new Map<string, { name: string; parent?: string }>();
    let pageToken: string | undefined;
    do {
      const r = await this.drive.files.list({ ...this.common(), q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields: "nextPageToken, files(id, name, parents)", pageToken });
      for (const f of r.data.files ?? []) map.set(f.id!, { name: f.name!, parent: f.parents?.[0] });
      pageToken = r.data.nextPageToken ?? undefined;
    } while (pageToken);
    return map;
  }

  /** PDFs changed after `since` (all when null), oldest first so a partial run can resume. */
  async listPdfs(since: Date | null): Promise<DriveFile[]> {
    const folders = await this.folders();
    const pathOf = (id?: string) => {
      const parts: string[] = [];
      for (let g = 0; id && id !== this.driveId && g < 50; g++) {
        const f = folders.get(id);
        if (!f) break;
        parts.unshift(f.name);
        id = f.parent;
      }
      return parts;
    };
    let q = "mimeType='application/pdf' and trashed=false";
    if (since) q += ` and modifiedTime > '${since.toISOString()}'`;
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.drive.files.list({ ...this.common(), q, orderBy: "modifiedTime",
        fields: "nextPageToken, files(id, name, parents, modifiedTime, size)", pageToken });
      for (const f of r.data.files ?? []) {
        out.push({ id: f.id!, name: f.name!, path: [...pathOf(f.parents?.[0]), f.name!].join("/"),
          modifiedAt: new Date(f.modifiedTime!), size: f.size ? Number(f.size) : undefined });
      }
      pageToken = r.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  async download(id: string) {
    const r = await this.drive.files.get({ fileId: id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
    return new Uint8Array(r.data as ArrayBuffer);
  }
}
