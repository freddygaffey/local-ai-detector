// Popup stub. TODO(T3): gauge, mode/style selects, consent + download
// progress, model management (check updates, update, rollback, custom
// model + licence display, cache size/delete), About/licences. See
// src/ui/ for supporting modules, src/shared/settings.ts for the store,
// and src/shared/messages.ts for talking to the background/inference host.

import { getSettings } from "@/src/shared/settings";

async function main() {
  const settings = await getSettings();
  console.log("[Local AI Detector] popup loaded (stub, see T3)", settings);
}

void main();
