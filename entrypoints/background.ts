// Background: Chrome service worker / Firefox event page (WXT picks the
// right manifest field per browser). Routes typed messages and owns the
// toolbar badge.
//
// The engine router (src/engine/router.ts) handles `analyze` and the model
// management messages: it creates/re-creates the inference host (Chrome
// offscreen document / Firefox dedicated Worker), forwards work to it,
// relays progress to the requesting popup/tab, and drives the badge via
// src/engine/badge-hook.ts (-> src/ui/badge.ts).
//
// Other features register their handlers below with one import + one call.

import { registerHandlers } from "@/src/shared/messages";
import { startEngineRouter } from "@/src/engine/router";
import { getSettings, watchSettings } from "@/src/shared/settings";
import { clearBadge } from "@/src/ui/badge";
import { registerProvenanceBackground } from "@/src/provenance/background";

export default defineBackground(() => {
  console.log("[Local AI Detector] background started", browser.runtime.id);

  // Badge starts clear; T1 calls setBadgeProgress/setBadgeScore/setBadgeError
  // from src/ui/badge.ts as real analyze progress/results/errors come in,
  // and clearBadge(tabId) on navigation.
  clearBadge();

  registerHandlers({
    ping: () => ({ ok: true, ts: Date.now() }),
  });

  startEngineRouter();

  // E2E builds only (`--mode e2e`, never shipped): see src/e2e/bridge.ts.
  if (import.meta.env.MODE === "e2e") {
    void import("@/src/e2e/bridge").then(({ installBackgroundBridge }) =>
      installBackgroundBridge({
        contextMenuSelection: (tabId) =>
          (globalThis as unknown as { __ladContextMenuSelection: (id: number) => Promise<void> }).__ladContextMenuSelection(tabId),
      }),
    );
  }
  registerProvenanceBackground();

  void getSettings().then((settings) => {
    console.log("[Local AI Detector] settings loaded", settings);
  });
  watchSettings((settings) => {
    console.log("[Local AI Detector] settings changed", settings);
  });
});
