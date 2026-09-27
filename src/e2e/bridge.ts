// E2E-only test bridge. Compiled in only for `wxt build --mode e2e`
// (npm run build:e2e[:firefox]); production builds drop it (the call sites
// are behind `import.meta.env.MODE === "e2e"`).
//
// Why: Firefox's WebDriver (Marionette and BiDi) refuses to navigate to or
// run scripts in moz-extension:// pages, so scripts/e2e/firefox.mjs can't
// drive the popup/options pages the way the Chrome suite does. Instead a
// test page posts `{__ladE2E: "req", id, op, ...}` to itself; the content
// script forwards it to the background, and replies with
// `{__ladE2E: "res", id, ok, result|error}`. Page -> content -> background
// is exactly the path the in-page pill uses, so nothing is bypassed.

import { browser } from "wxt/browser";
import { getSettings, setSettings, type Settings } from "../shared/settings";

interface BridgeReq {
  __ladE2E: "req";
  id: string;
  op: "send" | "settings" | "getSettings" | "bg";
  type?: string;
  payload?: unknown;
  partial?: Partial<Settings>;
}

/** Content-script side. */
export function installContentBridge(): void {
  window.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as BridgeReq;
    if (e.source !== window || !m || m.__ladE2E !== "req") return;
    const reply = (ok: boolean, value: unknown) =>
      window.postMessage({ __ladE2E: "res", id: m.id, ok, [ok ? "result" : "error"]: value }, "*");
    (async () => {
      switch (m.op) {
        case "send": {
          // Same envelope as src/shared/messages.ts sendMessage().
          const res = (await browser.runtime.sendMessage({ kind: "request", id: m.id, type: m.type, payload: m.payload })) as
            | { ok: boolean; payload?: unknown; error?: string }
            | undefined;
          if (!res) throw new Error(`no response to ${m.type}`);
          if (!res.ok) throw new Error(res.error);
          return res.payload;
        }
        case "settings":
          return setSettings(m.partial ?? {});
        case "getSettings":
          return getSettings();
        case "bg":
          return browser.runtime.sendMessage({ __ladE2E: "bg", type: m.type, payload: m.payload });
      }
    })().then(
      (r) => reply(true, r),
      (err) => reply(false, err instanceof Error ? err.message : String(err)),
    );
  });
}

/** Background side: a few helpers only tests need. */
export function installBackgroundBridge(hooks: { contextMenuSelection(tabId: number): Promise<void> }): void {
  browser.runtime.onMessage.addListener((m: unknown, sender: { tab?: { id?: number } }) => {
    const msg = m as { __ladE2E?: string; type?: string; payload?: { path?: string } };
    if (msg?.__ladE2E !== "bg") return undefined;
    const tabId = sender.tab?.id ?? -1;
    switch (msg.type) {
      case "tabId":
        return Promise.resolve(tabId);
      case "contextMenuSelection":
        return hooks.contextMenuSelection(tabId).then(() => true);
      case "openPage":
        return browser.tabs
          .create({ url: browser.runtime.getURL((msg.payload?.path ?? "/popup.html") as "/popup.html") })
          .then((t) => t.id);
      default:
        return Promise.resolve(null);
    }
  });
}
