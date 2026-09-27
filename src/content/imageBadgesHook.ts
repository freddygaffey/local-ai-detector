// Image provenance from the content script's side: after each analysis (and
// on the popup's "scanImages" request) scan the page's images, render badges,
// and report a page-level summary to the background, which merges it into
// the tab's status (AnalyzeResult.images) for the popup.

import { resetImageProvenance, scanPageImages } from "../provenance/content";
import { clearImageBadges } from "../provenance/badges";
import { summarizeImageResults } from "../provenance/summary";
import { sendMessage, type ImageProvenanceSummary } from "../shared/messages";

export async function scanImagesAndReport(): Promise<ImageProvenanceSummary> {
  const scan = await scanPageImages();
  const summary = summarizeImageResults(scan.results, {
    permissionNeeded: scan.permissionNeeded,
    disabled: scan.disabled,
  });
  // Images still awaiting permission aren't in `results` (not cached).
  summary.total += scan.awaitingPermission;
  await sendMessage("reportImageSummary", { summary }).catch(() => {});
  return summary;
}

/** Fire-and-forget variant for after an analysis; never throws. */
export function renderImageBadgesIfAvailable(): void {
  void scanImagesAndReport().catch(() => {});
}

/** Hides badges (page content changed); keeps cached results. */
export function clearImageBadgesIfAvailable(): void {
  try {
    clearImageBadges();
  } catch {
    // never break the page over it.
  }
}

/** Hides badges and forgets results (user cleared, or SPA navigation). */
export function resetImageBadges(): void {
  try {
    resetImageProvenance();
  } catch {
    // ignore
  }
}
