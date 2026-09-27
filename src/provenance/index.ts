// T4: image/text provenance and watermark checks (docs/watermarks.md).
//
// This barrel is imported by the content script (src/content/imageBadgesHook.ts
// uses `import * as provenance`), so it must only re-export content-safe,
// lightweight code. Host/background code is imported by path:
//   - entrypoints/background.ts:     import { registerProvenanceBackground } from "@/src/provenance/background";
//   - entrypoints/offscreen/main.ts: import { registerProvenanceHost } from "@/src/provenance/host";
// The popup/options can import "./schemes" (UNCHECKABLE_SCHEMES) and
// "./permissions" (requestImagePermission) directly.

import type { AnalyzeResult } from "../shared/messages";
import { renderImageBadgeResults } from "./badges";
import { scanPageImages, type ImageScanSummary } from "./content";
import type { ImageProvenanceResult } from "./types";

export type * from "./types";
export { UNCHECKABLE_SCHEMES, NO_SIGNALS_WORDING, WATERMARK_MISS_WORDING } from "./schemes";
export { clearImageBadges, primarySignal, signalHeading } from "./badges";
export { scanPageImages, resetImageProvenance, checkTextProvenance, scanPageTextProvenance } from "./content";
export type { ImageScanSummary } from "./content";
export { detectTextProvenance } from "./text";

/**
 * Renders image badges.
 *  - With `ImageProvenanceResult[]`: renders those results (matching <img>
 *    elements by src).
 *  - With anything else (T2's hook passes the text `AnalyzeResult` after an
 *    analysis) or nothing: scans the page's images (if settings.checkImages
 *    is on) and renders badges as results arrive.
 * Never throws.
 */
export function renderImageBadges(
  arg?: ImageProvenanceResult[] | AnalyzeResult,
): Promise<ImageScanSummary | undefined> {
  try {
    if (Array.isArray(arg)) {
      renderImageBadgeResults(arg);
      return Promise.resolve(undefined);
    }
    return scanPageImages().catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}
