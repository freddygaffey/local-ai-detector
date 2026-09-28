// Page-world helpers for YouTube: the only code this extension runs in a
// page's own JavaScript world, and only on youtube.com. It reads the current
// video's captions through the player's API (see
// src/content/youtube/pageCaptions.ts for why) when the isolated content
// script asks, and passes a read-only copy of the audio segments the player
// downloads to the voice check (src/content/youtube/audioTap.ts). No
// extension APIs are available or used here.

import { startAudioTap } from "@/src/content/youtube/audioTap";
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
    try {
      startAudioTap();
    } catch {
      // never break the page
    }
  },
});
