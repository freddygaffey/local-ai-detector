// Site memory (docs/plan.md "Site memory", off by default, local only): a
// per-domain tally of the last few pages' verdicts ("7 of the last 10 pages
// scored high"), shown in the chip/popup. Stores domain + a bare high/low
// flag + date only -- never any text -- and is fully clearable from
// Options. See PRIVACY.md.

import { browser } from "wxt/browser";

const STORAGE_KEY = "siteMemoryV1";
const RING_SIZE = 10;

export interface SiteMemoryEntry {
  /** Most recent last (chronological order), capped at RING_SIZE. */
  entries: { high: boolean; date: string }[];
}

export type SiteMemoryStore = Record<string, SiteMemoryEntry>;

/** Pure: appends one score to a domain's ring buffer, capped at RING_SIZE. Exported for testing. */
export function pushScore(entry: SiteMemoryEntry | undefined, high: boolean, date: string): SiteMemoryEntry {
  const entries = [...(entry?.entries ?? []), { high, date }];
  return { entries: entries.slice(-RING_SIZE) };
}

/** Pure: "N of the last M pages scored high" -- null when there's no history yet. */
export function tallyOf(entry: SiteMemoryEntry | undefined): { high: number; total: number } | null {
  if (!entry || entry.entries.length === 0) return null;
  return { high: entry.entries.filter((e) => e.high).length, total: entry.entries.length };
}

async function readStore(): Promise<SiteMemoryStore> {
  try {
    const res = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
    return (res[STORAGE_KEY] as SiteMemoryStore) ?? {};
  } catch {
    return {};
  }
}

async function writeStore(store: SiteMemoryStore): Promise<void> {
  try {
    await browser.storage.local.set({ [STORAGE_KEY]: store });
  } catch {
    // Best-effort: site memory is a convenience, never load-bearing.
  }
}

/** Records one page's verdict for `hostname`. `high` = the page's band was "ai" (see src/ui/verdict.ts). */
export async function recordSiteScore(hostname: string, high: boolean, date: string = new Date().toISOString()): Promise<void> {
  if (!hostname) return;
  const store = await readStore();
  store[hostname] = pushScore(store[hostname], high, date);
  await writeStore(store);
}

/** "N of the last M pages scored high" for `hostname`, or null with no history. */
export async function getSiteTally(hostname: string): Promise<{ high: number; total: number } | null> {
  if (!hostname) return null;
  const store = await readStore();
  return tallyOf(store[hostname]);
}

/** Options "Clear" button: erases every domain's history. */
export async function clearSiteMemory(): Promise<void> {
  await writeStore({});
}
