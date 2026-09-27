// Background: Chrome service worker / Firefox event page (WXT picks the
// right manifest field per browser). Routes typed messages and owns the
// toolbar badge. Real routing to the inference host is T1's job.
//
// TODO(T1): create the Chrome offscreen document (see entrypoints/offscreen)
// / Firefox inference worker (see entrypoints/inference-worker.ts), forward
// `analyze` (and model-management messages) to it, and relay `progress`
// events back to the requesting tab. Replace the stub handlers below.
// TODO(T3): update the badge text/spinner from real analysis state.

import { registerHandlers } from "@/src/shared/messages";
import { getSettings, watchSettings } from "@/src/shared/settings";

export default defineBackground(() => {
  console.log("[Local AI Detector] background started", browser.runtime.id);

  // Placeholder badge state; T3 drives this from real progress/results.
  void browser.action?.setBadgeText?.({ text: "" });

  registerHandlers({
    ping: () => ({ ok: true, ts: Date.now() }),

    analyze: async () => {
      throw new Error("analyze: not implemented yet (T1 wires up the inference host)");
    },
    checkModelUpdates: async () => {
      throw new Error("checkModelUpdates: not implemented yet (T1)");
    },
    updateModel: async () => ({
      ok: false,
      error: "updateModel: not implemented yet (T1)",
    }),
    rollbackModel: async () => ({
      ok: false,
      error: "rollbackModel: not implemented yet (T1)",
    }),
    setCustomModel: async () => ({
      ok: false,
      error: "setCustomModel: not implemented yet (T1)",
    }),
    deleteCachedModel: async () => ({
      ok: false,
      error: "deleteCachedModel: not implemented yet (T1)",
    }),
  });

  void getSettings().then((settings) => {
    console.log("[Local AI Detector] settings loaded", settings);
  });
  watchSettings((settings) => {
    console.log("[Local AI Detector] settings changed", settings);
  });
});
