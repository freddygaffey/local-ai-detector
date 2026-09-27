// Page-world helper for the YouTube transcript check: the only code this
// extension runs in a page's own JavaScript world, and only on youtube.com.
// It reads the current video's captions through the player's API (see
// src/content/youtube/pageCaptions.ts for why) when the isolated content
// script asks. No extension APIs are available or used here.

import { startPageCaptions } from "@/src/content/youtube/pageCaptions";

export default defineContentScript({
  matches: ["*://www.youtube.com/*", "*://m.youtube.com/*"],
  world: "MAIN",
  runAt: "document_start",
  main() {
    try {
      startPageCaptions();
    } catch {
      // never break the page
    }
  },
});
