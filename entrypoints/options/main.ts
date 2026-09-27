// Options page stub. TODO(T3): all settings controls, model cache
// management (check updates, update, rollback, custom model with licence
// display and warnings, cache size/delete), About + third-party licences.

import { getSettings } from "@/src/shared/settings";

async function main() {
  const settings = await getSettings();
  console.log("[Local AI Detector] options loaded (stub, see T3)", settings);
}

void main();
