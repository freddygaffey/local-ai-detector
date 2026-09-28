// Per-site corner-card positions (dragged by the user). Kept in
// storage.local under their own key, not in the synced settings: a few
// hundred sites would overflow storage.sync's 8 KB-per-item quota.

import { browser } from "wxt/browser";
import type { CardPosition } from "../shared/settings";

const KEY = "cardPositions";
const MAX_SITES = 500;

type Positions = Record<string, CardPosition>;

async function readAll(): Promise<Positions> {
  try {
    return ((await browser.storage.local.get(KEY))[KEY] as Positions | undefined) ?? {};
  } catch {
    return {};
  }
}

export async function getCardPosition(host: string): Promise<CardPosition | null> {
  return (await readAll())[host] ?? null;
}

/** Saves (or with `null`, forgets) this site's position; newest last, capped. */
export async function setCardPosition(host: string, pos: CardPosition | null): Promise<void> {
  const { [host]: _old, ...rest } = await readAll();
  const kept = Object.entries(rest).slice(-(MAX_SITES - 1));
  const next: Positions = Object.fromEntries(pos ? [...kept, [host, pos]] : kept);
  await browser.storage.local.set({ [KEY]: next }).catch(() => {});
}

/** Calls `fn` when this site's position changes (another tab of the same site moved it). */
export function watchCardPosition(host: string, fn: (pos: CardPosition | null) => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[KEY]) return;
    const next = (changes[KEY].newValue as Positions | undefined)?.[host] ?? null;
    const prev = (changes[KEY].oldValue as Positions | undefined)?.[host] ?? null;
    if (JSON.stringify(next) !== JSON.stringify(prev)) fn(next);
  });
}
