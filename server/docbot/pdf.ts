// PDF reading (pdf.js) and locking (pdf-lib, AES-256). Pure JavaScript, so it runs in serverless functions.

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "@cantoo/pdf-lib";

export interface ExtractResult {
  text: string;
  locked: boolean;
  passwordUsed?: string;
  opened: boolean; // false if locked and none of the candidate passwords worked
}

const MAX_PASSWORD_TRIES = 400;

// Load pdf.js's worker in-process. Importing it by name also makes the serverless bundler ship it.
let workerReady: Promise<unknown> | undefined;
const loadWorker = () => (workerReady ??= import("pdfjs-dist/legacy/build/pdf.worker.mjs" as string));

/** Extracts text; if the PDF is locked, tries candidate passwords in order. */
export async function extractText(buf: Uint8Array, candidates: () => Iterable<string> = () => []): Promise<ExtractResult> {
  await loadWorker();
  const task = getDocument({ data: new Uint8Array(buf), verbosity: 0, stopAtErrors: false });
  let locked = false;
  let lastTried: string | undefined;
  const it = candidates()[Symbol.iterator]();
  let tries = 0;
  task.onPassword = (update: (pw: string) => void) => {
    locked = true;
    const next = tries++ < MAX_PASSWORD_TRIES ? it.next() : { done: true, value: undefined };
    if (next.done) {
      lastTried = undefined;
      task.destroy();
      return;
    }
    lastTried = next.value as string;
    update(lastTried);
  };
  let doc;
  try {
    doc = await task.promise;
  } catch (e: any) {
    if (locked) return { text: "", locked: true, opened: false };
    throw e;
  }
  try {
    let text = "";
    for (let i = 1; i <= Math.min(doc.numPages, 8); i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      text += content.items.map((x: any) => (x.str ?? "") + (x.hasEOL ? "\n" : " ")).join("") + "\n";
    }
    return { text, locked, passwordUsed: locked ? lastTried : undefined, opened: true };
  } finally {
    await task.destroy();
  }
}

/** Locks a PDF with AES-256. The owner password is random so recipients can't remove the lock. */
export async function protectPdf(buf: Uint8Array, userPassword: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(buf, { updateMetadata: false });
  doc.encrypt({ userPassword, ownerPassword: crypto.randomUUID() });
  return doc.save();
}

export function looksLikePdf(buf: Uint8Array) {
  return buf.length > 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
}
