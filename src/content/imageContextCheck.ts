// "Check image for Content Credentials & watermarks" context menu (docs/plan.md
// "More entry points"): checks the one right-clicked image regardless of its
// displayed size (the normal whole-page scan skips small images), reusing
// T4's discovery/badge-rendering pipeline so the result shows the same way
// an automatic scan's badge does.

import { discoverImages } from "../provenance/discover";
import { renderImageBadgeResults } from "../provenance/badges";
import { sendMessage, type ActionResult } from "../shared/messages";

/** Finds the clicked image by its resolved src, checks it, and renders its badge. Never throws. */
export async function checkImageAtUrl(srcUrl: string): Promise<ActionResult> {
  try {
    const found = await discoverImages({ minDisplay: 0, minNatural: 0, max: 400, excludeThumbnails: false });
    const match = found.find(
      (f) => f.candidate.src === srcUrl || (f.element as HTMLImageElement).currentSrc === srcUrl,
    );
    if (!match) return { ok: false, error: "Couldn't find that image on the page." };
    const res = await sendMessage("provenanceScanImages", { images: [match.candidate] });
    if (res.disabled) return { ok: false, error: "Image checks are off in Settings." };
    if (res.permissionNeeded.length > 0) {
      return { ok: false, error: `Needs permission for ${res.permissionNeeded[0]} -- allow it from the popup first.` };
    }
    renderImageBadgeResults(res.results, new Map([[match.candidate.src, [match.element]]]));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
