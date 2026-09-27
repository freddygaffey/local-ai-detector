// Tiny indirection between the engine router and the toolbar badge. By
// default it drives T3's src/ui/badge.ts; `setBadgeHooks` lets the UI side
// replace or extend it without the router knowing the details.

import { clearBadge, setBadgeError, setBadgeProgress, setBadgeScore } from "../ui/badge";

export interface BadgeHooks {
  /** pct 0..100, or undefined for indeterminate. */
  progress(tabId: number, pct?: number): void;
  score(tabId: number, score: number): void;
  error(tabId: number): void;
  clear(tabId?: number): void;
}

let hooks: BadgeHooks = {
  progress: setBadgeProgress,
  score: setBadgeScore,
  error: setBadgeError,
  clear: clearBadge,
};

export function setBadgeHooks(h: Partial<BadgeHooks>): void {
  hooks = { ...hooks, ...h };
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn("[engine] badge update failed", e);
  }
}

export const badge = {
  progress: (tabId: number, pct?: number) => safe(() => hooks.progress(tabId, pct)),
  score: (tabId: number, score: number) => safe(() => hooks.score(tabId, score)),
  error: (tabId: number) => safe(() => hooks.error(tabId)),
  clear: (tabId?: number) => safe(() => hooks.clear(tabId)),
};
