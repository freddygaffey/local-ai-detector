// SPA navigation / DOM mutation handling: detects when the backing DOM for
// active highlights has gone away (removed nodes) and when the page has
// navigated client-side (pushState/replaceState/popstate), so main.ts can
// clear stale highlights and offer a re-run instead of leaving dangling
// state.

import { isBlockStale } from "./extract";
import type { BlockRecord } from "./types";

export interface ObserveCallbacks {
  onStale(): void;
  onNavigate(): void;
}

const STALE_CHECK_DEBOUNCE_MS = 400;

export function startObserving(getBlocks: () => BlockRecord[], callbacks: ObserveCallbacks): () => void {
  let lastUrl = location.href;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  let reported = false;

  function checkStale(): void {
    staleTimer = null;
    if (reported) return;
    const blocks = getBlocks();
    if (blocks.length === 0) return;
    if (blocks.some((b) => isBlockStale(b))) {
      reported = true;
      try {
        callbacks.onStale();
      } catch {
        // ignore
      }
    }
  }

  function checkUrl(): void {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    reported = false;
    try {
      callbacks.onNavigate();
    } catch {
      // ignore
    }
  }

  let mo: MutationObserver | null = null;
  try {
    mo = new MutationObserver(() => {
      checkUrl();
      if (!staleTimer) staleTimer = setTimeout(checkStale, STALE_CHECK_DEBOUNCE_MS);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    mo = null;
  }

  const popHandler = () => checkUrl();
  window.addEventListener("popstate", popHandler);

  // Many SPAs navigate via history.pushState/replaceState without any
  // MutationObserver-visible DOM change at the moment of the call.
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  function wrap<T extends (...args: never[]) => unknown>(fn: T): T {
    return function (this: History, ...args: Parameters<T>) {
      const ret = fn.apply(this, args);
      queueMicrotask(checkUrl);
      return ret;
    } as T;
  }
  let patched = false;
  try {
    history.pushState = wrap(origPush);
    history.replaceState = wrap(origReplace);
    patched = true;
  } catch {
    patched = false;
  }

  return () => {
    try {
      mo?.disconnect();
    } catch {
      // ignore
    }
    if (staleTimer) clearTimeout(staleTimer);
    window.removeEventListener("popstate", popHandler);
    if (patched) {
      try {
        history.pushState = origPush;
        history.replaceState = origReplace;
      } catch {
        // ignore
      }
    }
  };
}
