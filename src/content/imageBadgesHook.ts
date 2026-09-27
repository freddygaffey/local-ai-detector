// Image provenance from the content script's side: after each analysis (and
// on the popup's "scanImages" request) scan the page's images, render badges,
// and report a page-level summary to the background, which merges it into
// the tab's status (AnalyzeResult.images) for the popup.

import { resetImageProvenance, scanPageImages } from "../provenance/content";
import { clearImageBadges } from "../provenance/badges";
import { summarizeImageResults } from "../provenance/summary";
import { sendMessage, type ImageProvenanceSummary } from "../shared/messages";
import { isYouTubeHost } from "./youtube/acquire";

/**
 * YouTube's own thumbnails are everywhere (home, sidebar, search, the watch
 * page's own "up next" rail) and every one would otherwise get a quiet "?"
 * badge for lack of host permission -- noise on every page, not a result
 * about anything. Restrict to the one place an image is actually content:
 * the video description. `null` (no description on this page, e.g. the
 * homepage) means nothing gets scanned at all.
 */
function badgeRoot(): ParentNode | null | undefined {
  try {
    if (!isYouTubeHost(location.hostname)) return undefined; // no restriction off YouTube
    return document.querySelector("#description") ?? null;
  } catch {
    return undefined;
  }
}

export async function scanImagesAndReport(): Promise<ImageProvenanceSummary> {
  const scan = await scanPageImages({ root: badgeRoot() });
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
