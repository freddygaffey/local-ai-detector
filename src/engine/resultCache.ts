// Remembered results: a page whose text hasn't changed isn't re-scored on
// every visit. Keyed by a hash of the extracted text plus everything that
// changes the score (tier, detector set, model overrides, token cap), so an
// edited page or a settings/model change is simply a miss. A Deep result
// also answers a Quick request for the same text. IndexedDB in the
// background context, capped (oldest dropped first); local only.

import type { AnalyzeResult, TextBlock } from "../shared/messages";

const DB_NAME = "local-ai-detector-results";
const STORE = "results";
const MAX_ENTRIES = 300;

interface Entry {
  key: string;
  at: number;
  result: AnalyzeResult;
  /** Block ids the result was computed on, in order (ids are per-visit; see `remapBlocks`). */
  blockIds?: string[];
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("at", "at");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash of the text being scored (block boundaries included: items are scored apart). */
export function textKey(blocks: TextBlock[], itemBlocks?: boolean): Promise<string> {
  return sha256Hex(JSON.stringify([itemBlocks ? 1 : 0, blocks.map((b) => b.text)]));
}

/** Everything besides the text that changes a score. */
export function scoreSignature(parts: Record<string, unknown>): string {
  return JSON.stringify(parts, Object.keys(parts).sort());
}

/**
 * The cached result for this text + setup, with its block ids moved onto
 * `blockIds` (this visit's). Block ids are made fresh on every extraction;
 * the key is the exact same text in the same block order, so position maps.
 */
export async function getCached(text: string, signature: string, blockIds: string[]): Promise<AnalyzeResult | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const d = await db();
    const entry = (await done(d.transaction(STORE).objectStore(STORE).get(`${text}|${signature}`))) as Entry | undefined;
    if (!entry?.blockIds || entry.blockIds.length !== blockIds.length) return null;
    return remapBlocks(entry.result, entry.blockIds, blockIds);
  } catch {
    return null;
  }
}

export function remapBlocks(result: AnalyzeResult, from: string[], to: string[]): AnalyzeResult {
  const map = new Map(from.map((id, i) => [id, to[i]!]));
  return { ...result, sentences: result.sentences.map((s) => ({ ...s, blockId: map.get(s.blockId) ?? s.blockId })) };
}

export async function putCached(text: string, signature: string, result: AnalyzeResult, blockIds: string[]): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const d = await db();
    const { images: _images, refining: _refining, ...kept } = result;
    const tx = d.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.put({ key: `${text}|${signature}`, at: Date.now(), result: kept, blockIds } satisfies Entry);
    const count = await done(store.count());
    if (count > MAX_ENTRIES) {
      let drop = count - MAX_ENTRIES;
      const cursorReq = store.index("at").openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || drop-- <= 0) return;
        cursor.delete();
        cursor.continue();
      };
    }
  } catch {
    // best-effort
  }
}

/** Options page "Clear remembered results". */
export async function clearCached(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const d = await db();
  await done(d.transaction(STORE, "readwrite").objectStore(STORE).clear());
}
