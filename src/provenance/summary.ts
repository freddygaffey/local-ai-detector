// Page-level summary of image provenance results, for the popup
// (AnalyzeResult.images). Pure, so it's unit-testable.

import type { ImageProvenanceSummary } from "../shared/messages";
import type { ImageProvenanceResult } from "./types";

export function summarizeImageResults(
  results: ImageProvenanceResult[],
  extra: { permissionNeeded?: string[]; disabled?: boolean } = {},
): ImageProvenanceSummary {
  const summary: ImageProvenanceSummary = {
    total: results.length,
    checked: 0,
    withCredentials: 0,
    trustedCredentials: 0,
    aiSignals: 0,
    withUnsignedClaim: 0,
    withWatermark: 0,
    permissionNeeded: [...new Set(extra.permissionNeeded ?? [])],
  };
  if (extra.disabled) summary.disabled = true;
  for (const r of results) {
    if (r.status === "ok") summary.checked++;
    const signals = r.signals ?? [];
    const c2pa = signals.filter((s) => s.kind === "c2pa");
    if (c2pa.length || r.c2pa) summary.withCredentials++;
    if (c2pa.some((s) => s.trusted) || r.c2pa?.trusted) summary.trustedCredentials++;
    if (signals.some((s) => s.verdict === "ai" || s.verdict === "edited")) summary.aiSignals++;
    if (signals.some((s) => s.kind === "metadata" && !s.signed && (s.verdict === "ai" || s.verdict === "edited"))) {
      summary.withUnsignedClaim++;
    }
    if (signals.some((s) => s.kind === "invisible-watermark" || s.kind === "novelai-alpha")) summary.withWatermark++;
  }
  return summary;
}
