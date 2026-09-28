// One live content-script instance per page. Reloading or updating the
// extension leaves the old instance's UI on already-open pages while its
// extension context is gone ("Extension context invalidated"); the next check
// injects a fresh instance next to it, so the page showed two cards. The new
// instance announces itself on the shared DOM and the old one takes all its UI
// down; an orphan with no successor offers a page reload instead of erroring.

import { browser } from "wxt/browser";

const TAKEOVER = "ai-detector:takeover";
const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let retired = false;

/** This instance was replaced by a newer one: do nothing further on the page. */
export const isRetired = (): boolean => retired;

/** The extension was reloaded/updated/removed under this (old) instance. */
export function extensionGone(): boolean {
  try {
    if (!browser.runtime?.id) return true;
    // An orphaned context can keep a stale id; getURL throws "Extension context invalidated".
    browser.runtime.getURL("/");
    return false;
  } catch {
    return true;
  }
}

export function isContextInvalidated(err: unknown): boolean {
  return /Extension context invalidated/i.test(err instanceof Error ? err.message : String(err)) || extensionGone();
}

/**
 * Tells any older instance on this page to retire, then listens for newer
 * ones. `teardown` removes everything this instance drew.
 */
export function claimPage(teardown: () => void): void {
  try {
    document.addEventListener(TAKEOVER, (e) => {
      if ((e as CustomEvent<string>).detail === token || retired) return;
      retired = true;
      try {
        teardown();
      } catch {
        // best-effort
      }
    });
    document.dispatchEvent(new CustomEvent(TAKEOVER, { detail: token }));
  } catch {
    // never break the page
  }
}
