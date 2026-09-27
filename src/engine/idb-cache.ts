// IndexedDB-backed implementation of the tiny Cache-API subset transformers.js
// needs (`match`, `put`, `delete`), used as `env.customCache` when the Cache
// API is unavailable or unusable (e.g. some Firefox private-browsing
// contexts). Also exposes `keys()`/`size()` for the model-cache UI.
//
// Records are {url, blob, headers}. Blobs keep large weights out of the JS
// heap until they're read.

const DB_NAME = "local-ai-detector-model-cache";
const STORE = "files";

interface CacheRecord {
  url: string;
  blob: Blob;
  headers: [string, string][];
  size: number;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbCache {
  private dbPromise: Promise<IDBDatabase> | null = null;

  static isAvailable(): boolean {
    return typeof indexedDB !== "undefined";
  }

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) {
            req.result.createObjectStore(STORE, { keyPath: "url" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      this.dbPromise.catch(() => {
        this.dbPromise = null;
      });
    }
    return this.dbPromise;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.db();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async match(url: string): Promise<Response | undefined> {
    const rec = (await promisify((await this.store("readonly")).get(url))) as CacheRecord | undefined;
    if (!rec) return undefined;
    const headers = new Headers(rec.headers);
    if (!headers.has("content-length")) headers.set("content-length", String(rec.size));
    return new Response(rec.blob, { status: 200, headers });
  }

  async put(url: string, response: Response): Promise<void> {
    const blob = await response.blob();
    const headers: [string, string][] = [];
    response.headers.forEach((v, k) => headers.push([k, v]));
    const rec: CacheRecord = { url, blob, headers, size: blob.size };
    await promisify((await this.store("readwrite")).put(rec));
  }

  async delete(url: string): Promise<boolean> {
    const s = await this.store("readwrite");
    const existing = await promisify(s.getKey(url));
    if (existing === undefined) return false;
    await promisify((await this.store("readwrite")).delete(url));
    return true;
  }

  async keys(): Promise<string[]> {
    const keys = await promisify((await this.store("readonly")).getAllKeys());
    return keys.map(String);
  }

  async size(url: string): Promise<number> {
    const rec = (await promisify((await this.store("readonly")).get(url))) as CacheRecord | undefined;
    return rec?.size ?? 0;
  }
}
