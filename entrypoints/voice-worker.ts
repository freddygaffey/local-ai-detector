// Voice-check host (T11): a dedicated module Worker. Firefox spawns it from
// the background event page (src/voice/background.ts); Chrome from the
// offscreen document (src/engine/offscreenRelay.ts). Firefox extension pages can't be
// cross-origin isolated, so ORT runs single-threaded here.

import { startVoiceWorkerHost } from "@/src/engine/voiceHost";

export default defineUnlistedScript({
  main() {
    startVoiceWorkerHost(self as unknown as Parameters<typeof startVoiceWorkerHost>[0], new URL("/ort/", self.location.href).href, import.meta.env.FIREFOX);
  },
});
