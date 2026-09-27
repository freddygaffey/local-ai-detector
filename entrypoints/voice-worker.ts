// Firefox voice-check host (T11): a dedicated module Worker spawned by the
// background event page (src/voice/background.ts). Chrome runs the same host
// in the offscreen document instead. Firefox extension pages can't be
// cross-origin isolated, so ORT runs single-threaded here.

import { startVoiceWorkerHost } from "@/src/engine/voiceHost";

export default defineUnlistedScript({
  include: ["firefox"],
  main() {
    startVoiceWorkerHost(self as unknown as Parameters<typeof startVoiceWorkerHost>[0], new URL("/ort/", self.location.href).href);
  },
});
