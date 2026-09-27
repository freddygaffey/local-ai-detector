// Shared bits for the Deep check ↻ button (docs/plan.md "Two tiers: Quick
// (default) and Deep (on demand)"), used by the popup, the pill (expanded
// chip) and the side panel -- each wires its own DOM/state, but the tooltip
// text, the request shape and the "are the deep models downloaded" check are
// one place so the three surfaces can't drift.

import { modeDownloadStatus, type CacheKnown } from "./modelChecklist";
import { fusionForTier } from "../engine/models";
import type { AnalyzeResult } from "../shared/messages";
import type { FusionDetector, Settings } from "../shared/settings";

/** Exact copy required by docs/plan.md "Two tiers". */
export const DEEP_CHECK_TOOLTIP = "Deep check: all models, slower, more battery";

/** The extra `analyzeTab`/`analyze` request fields for a Deep run. */
export function deepCheckRequestFields(settings: Settings): { mode: "ensemble"; tier: "deep"; fusionOverride: FusionDetector[] } {
  return { mode: "ensemble", tier: "deep", fusionOverride: fusionForTier("deep", settings.tiers).detectors };
}

/**
 * Whether the Deep detector set is fully downloaded yet, and how much is
 * left to fetch if not -- reuses the popup's first-run checklist logic
 * (src/ui/modelChecklist.ts) so the inline "download (N MB)" prompt matches
 * it exactly, per docs/plan.md "If needed models aren't downloaded, show an
 * inline 'download (N MB)' prompt, reusing the checklist."
 */
export function deepDownloadStatus(
  settings: Settings,
  device: "wasm" | "webgpu",
  cache: CacheKnown | undefined,
): { cached: boolean; missingBytes: number | null } {
  const deep = fusionForTier("deep", settings.tiers);
  return modeDownloadStatus("ensemble", deep, settings.modelOverrides, device, cache);
}

/** True once a result is in and it was a Deep run -- shows the tiny "Deep" label. */
export function isDeepResult(result: AnalyzeResult | null): boolean {
  return result?.tier === "deep";
}
