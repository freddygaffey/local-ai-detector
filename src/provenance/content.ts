// Content-script entry for image provenance: discover -> ask the background
// (which checks settings + host permissions and runs the host pipeline) ->
// render badges progressively. Also text-manifest helpers for selections.

import { sendMessage } from "../shared/messages";
import { clearImageBadges, renderImageBadgeResults } from "./badges";
import { DEFAULTS, discoverImages, type DiscoverOptions } from "./discover";
import { bytesToBase64, detectTextProvenance, scanDocumentTextProvenance } from "./text";
import type { ImageProvenanceResult, TextProvenanceResult } from "./types";

/** Images sent per background round-trip (badges appear batch by batch). */
const BATCH = 6;

// Per-page state: results by src, the elements showing each src, and the
// per-page cap on images analysed.
const resultsBySrc = new Map<string, ImageProvenanceResult>();
const elementsBySrc = new Map<string, Element[]>();
let scanning: Promise<ImageScanSummary> | null = null;

export interface ImageScanSummary {
  results: ImageProvenanceResult[];
  /** settings.checkImages is off. */
  disabled: boolean;
  /** Origin patterns needing the optional host permission (for a "Grant access" button). */
  permissionNeeded: string[];
}

/**
 * Scans the page's images (at most `DEFAULTS.max` per page, new ones only),
 * renders badges, and returns everything found so far on this page. Safe to
 * call repeatedly; concurrent calls share one scan.
 */
export function scanPageImages(opts: DiscoverOptions & { badges?: boolean } = {}): Promise<ImageScanSummary> {
  scanning ??= doScan(opts).finally(() => {
    scanning = null;
  });
  return scanning;
}

async function doScan(opts: DiscoverOptions & { badges?: boolean }): Promise<ImageScanSummary> {
  const badges = opts.badges ?? true;
  const remaining = Math.max(0, (opts.max ?? DEFAULTS.max) - resultsBySrc.size);
  const found = await discoverImages({ ...opts, max: remaining, skip: new Set(resultsBySrc.keys()) });
  // Remember every element per src (including already-analysed srcs shown again).
  for (const { element, candidate } of found) {
    const list = elementsBySrc.get(candidate.src) ?? [];
    if (!list.includes(element)) list.push(element);
    elementsBySrc.set(candidate.src, list);
  }
  const todo = [...new Map(found.map((f) => [f.candidate.src, f.candidate])).values()].filter(
    (c) => !resultsBySrc.has(c.src),
  );
  let disabled = false;
  const permissionNeeded = new Set<string>();
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const res = await sendMessage("provenanceScanImages", { images: batch });
    if (res.disabled) {
      disabled = true;
      break;
    }
    res.permissionNeeded.forEach((p) => permissionNeeded.add(p));
    for (const r of res.results) {
      // Don't cache permission failures: the user may grant access later.
      if (r.status !== "permission-needed") resultsBySrc.set(r.src, r);
    }
    if (badges) renderImageBadgeResults(res.results, elementsBySrc);
  }
  if (badges && !disabled) renderImageBadgeResults([...resultsBySrc.values()], elementsBySrc);
  return { results: [...resultsBySrc.values()], disabled, permissionNeeded: [...permissionNeeded] };
}

/** Removes badges and forgets this page's results. */
export function resetImageProvenance(): void {
  clearImageBadges();
  resultsBySrc.clear();
  elementsBySrc.clear();
}

/**
 * Checks a text (e.g. the user's selection) for a C2PA text manifest and, if
 * one is present, asks the background to try verifying its signature.
 */
export async function checkTextProvenance(text: string, verify = true): Promise<TextProvenanceResult> {
  const det = detectTextProvenance(text);
  const { manifest, ...result } = det;
  if (!det.found || !manifest || !verify) return result;
  try {
    const v = await sendMessage("provenanceVerifyText", { manifestB64: bytesToBase64(manifest) });
    return { ...result, verification: v.verification, c2pa: v.c2pa, detail: v.detail };
  } catch (err) {
    return { ...result, detail: `${result.detail} Verification unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Finds C2PA text manifests in the page (no verification). */
export function scanPageTextProvenance(): TextProvenanceResult[] {
  return scanDocumentTextProvenance().map(({ result }) => {
    const { manifest: _manifest, ...rest } = result;
    return rest;
  });
}
