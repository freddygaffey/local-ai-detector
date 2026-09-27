// UI-facing adapter over T1's real model registry (src/engine/models.ts,
// "a pure module... so the popup/options UI may import it too"). Keeps only
// the bits that are genuinely UI concerns: mode labels, which modes are
// experimental, and MB-rounding for display. Do not duplicate model data
// here — read it from src/engine/models.ts so there is exactly one source
// of truth for repos/revisions/sizes/licences.

import { estimatedDownloadBytes, type FusionSpec } from "../engine/models";
import type { Mode } from "../shared/settings";

export { DEFAULT_MODELS as MODEL_REGISTRY } from "../engine/models";

// "ensemble" is the stored Mode value for T7's Fusion (docs/plan.md "T7:
// Fusion mode") -- the value is kept for settings/type compatibility, but
// the UI always calls it "Fusion".
export const MODE_LABEL: Record<Mode, string> = {
  ensemble: "Fusion",
  classifier: "Classifier",
  classifierLite: "Classifier — lite",
  perplexity: "Perplexity",
  binoculars: "Binoculars",
};

/** Modes flagged in the UI as experimental (unproven accuracy at this model size). */
export const EXPERIMENTAL_MODES = new Set<Mode>(["binoculars"]);

/** Total estimated download size in MB for a mode's default model slots (WASM/q8 sizes). */
export function modeSizeMB(mode: Mode, fusion?: FusionSpec): number {
  const bytes = estimatedDownloadBytes(mode, "wasm", undefined, fusion);
  return bytes === null ? 0 : Math.round(bytes / (1024 * 1024));
}

/** "mit" -> "MIT", "apache-2.0" -> "Apache-2.0", for display. */
export function licenseLabel(license: string | null | undefined): string {
  if (!license) return "unknown";
  if (license.toLowerCase() === "mit") return "MIT";
  return license
    .split("-")
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)))
    .join("-");
}

