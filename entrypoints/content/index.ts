// Content script entrypoint. All actual logic lives in src/content/** (T2);
// this just wires WXT's entrypoint to it. See src/content/main.ts for the
// idempotent boot guard, extraction, highlight rendering, the floating
// pill, tooltips and hidden-Unicode markers.

import { bootContentScript } from "@/src/content";

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    try {
      bootContentScript();
    } catch {
      // A content script must never throw and break the host page.
      console.warn("[Local AI Detector] content script failed to start");
    }
  },
});
