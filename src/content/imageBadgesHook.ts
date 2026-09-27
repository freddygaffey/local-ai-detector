// Hook into T4's provenance/watermark module. src/provenance/index.ts is
// owned by T4 and is an empty `export {}` stub as of T0/T2's work -- this
// hook calls a `renderImageBadges(result)` export if/when T4 adds one,
// and is a clean no-op until then. If T4 instead wires image badges into its
// own content-script listener (e.g. its own `analyze`/`renderHighlights`
// hook), this file can simply be deleted; it makes no assumptions T4 has to
// honour.

import * as provenance from "../provenance";
import type { AnalyzeResult } from "../shared/messages";

interface ProvenanceModuleShape {
  renderImageBadges?: (result: AnalyzeResult) => void;
  clearImageBadges?: () => void;
}

export function renderImageBadgesIfAvailable(result: AnalyzeResult): void {
  try {
    const mod = provenance as unknown as ProvenanceModuleShape;
    if (typeof mod.renderImageBadges === "function") {
      mod.renderImageBadges(result);
    }
  } catch {
    // T4 not wired yet, or it threw internally -- never break the page over it.
  }
}

/**
 * Clears T4's image badges. Called from the same places we clear our own
 * highlights/markers (the pill's ✕ and SPA-navigation cleanup) so badges
 * never outlive the text they were shown alongside.
 */
export function clearImageBadgesIfAvailable(): void {
  try {
    const mod = provenance as unknown as ProvenanceModuleShape;
    if (typeof mod.clearImageBadges === "function") {
      mod.clearImageBadges();
    }
  } catch {
    // never break the page over it.
  }
}
