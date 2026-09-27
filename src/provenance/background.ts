// Background side of image/text provenance. Registered from
// entrypoints/background.ts with one call: `registerProvenanceBackground()`.
//
//  - Gates on settings.checkImages and on the optional host permission for
//    each image's origin (no fetch without it: "permission-needed").
//  - Chrome: the service worker can't spawn the c2pa worker, so work is
//    relayed to the offscreen document (created on demand, shared with the
//    inference engine; see src/engine/host-client.ts), where
//    registerProvenanceHost() answers.
//  - Firefox: the event page can spawn workers, so the host code runs
//    in-process (loaded lazily).

import { browser } from "wxt/browser";
import { registerHandlers, sendMessage } from "../shared/messages";
import { getSettings } from "../shared/settings";
import { originPattern } from "./permissions";
import type {
  ImageCandidate,
  ImageProvenanceResult,
  ProvenanceScanImagesResponse,
  TextProvenanceResult,
} from "./types";

/** Hard cap on images per request (the content script also caps per page). */
const MAX_PER_REQUEST = 30;
/** Base64 cap for data:/blob: images sent by the content script (~8 MB). */
const MAX_INLINE_B64 = Math.ceil((8 * 1024 * 1024 * 4) / 3) + 4;

// ---- Chrome offscreen relay ----

const OFFSCREEN_URL = "offscreen.html";
let creating: Promise<void> | null = null;

interface OffscreenApi {
  createDocument(p: { url: string; reasons: string[]; justification: string }): Promise<void>;
}

async function ensureOffscreen(): Promise<void> {
  const api = (browser as unknown as { offscreen?: OffscreenApi }).offscreen;
  if (!api) throw new Error("offscreen API unavailable");
  const url = (browser.runtime.getURL as (p: string) => string)(`/${OFFSCREEN_URL}`);
  const rt = browser.runtime as unknown as {
    getContexts?: (f: { contextTypes: string[]; documentUrls?: string[] }) => Promise<unknown[]>;
  };
  if (rt.getContexts) {
    const ctx = await rt.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
    if (ctx.length) return;
  }
  creating ??= api
    .createDocument({
      url,
      reasons: ["WORKERS"],
      justification:
        "Runs local AI-detection models and the Content Credentials (C2PA) validator in workers, outside the service worker.",
    })
    .catch((e: unknown) => {
      // The engine may have created it concurrently; only one may exist.
      if (!/single offscreen|only a single|already/i.test(String(e))) throw e;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

async function relay<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await ensureOffscreen();
    try {
      return await call();
    } catch (e) {
      const msg = String(e);
      // Document just created and its listener isn't registered yet.
      if (attempt < 30 && /Receiving end does not exist|Could not establish connection|No response for message|message port closed/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      throw e;
    }
  }
}

async function runHostAnalyze(images: ImageCandidate[]): Promise<ImageProvenanceResult[]> {
  if (import.meta.env.FIREFOX) {
    const { hostAnalyzeImages } = await import("./host");
    return hostAnalyzeImages(images);
  }
  return (await relay(() => sendMessage("provenanceHostAnalyze", { images }))).results;
}

async function runHostVerifyText(manifestB64: string): Promise<TextProvenanceResult> {
  if (import.meta.env.FIREFOX) {
    const { hostVerifyTextManifest } = await import("./host");
    return hostVerifyTextManifest(manifestB64);
  }
  return relay(() => sendMessage("provenanceHostVerifyText", { manifestB64 }));
}

// ---- Handlers ----

function permissionResult(src: string, pattern: string): ImageProvenanceResult {
  return {
    src,
    status: "permission-needed",
    signals: [],
    checks: { c2pa: "skipped", metadata: "skipped", invisibleWatermark: "skipped", novelaiAlpha: "skipped" },
    notes: [`Permission needed: allow the extension to read images from ${pattern} to check them.`],
    errors: [],
  };
}

export async function handleScanImages(images: ImageCandidate[]): Promise<ProvenanceScanImagesResponse> {
  const settings = await getSettings();
  if (!settings.checkImages) return { results: [], disabled: true, permissionNeeded: [] };

  const list = images.slice(0, MAX_PER_REQUEST);
  const out = new Array<ImageProvenanceResult>(list.length);
  const allowed: Array<{ i: number; c: ImageCandidate }> = [];
  const permCache = new Map<string, boolean>();
  const needed = new Set<string>();

  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (c.bytesB64 !== undefined) {
      if (c.bytesB64.length > MAX_INLINE_B64) {
        out[i] = { ...permissionResult(c.src, ""), status: "error", notes: [], errors: ["image too large"] };
      } else {
        allowed.push({ i, c });
      }
      continue;
    }
    const pattern = originPattern(c.src);
    if (!pattern) {
      out[i] = { ...permissionResult(c.src, ""), status: "error", notes: [], errors: ["unsupported URL"] };
      continue;
    }
    let ok = permCache.get(pattern);
    if (ok === undefined) {
      try {
        ok = await browser.permissions.contains({ origins: [pattern] });
      } catch {
        ok = false;
      }
      permCache.set(pattern, ok);
    }
    if (ok) allowed.push({ i, c: { src: c.src, mime: c.mime } });
    else {
      needed.add(pattern);
      out[i] = permissionResult(c.src, pattern);
    }
  }

  if (allowed.length) {
    let results: ImageProvenanceResult[];
    try {
      results = await runHostAnalyze(allowed.map((a) => a.c));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results = allowed.map((a) => ({ ...permissionResult(a.c.src, ""), status: "error" as const, notes: [], errors: [msg] }));
    }
    allowed.forEach((a, k) => {
      out[a.i] = results[k]!;
    });
  }
  return { results: out, permissionNeeded: [...needed] };
}

let registered = false;

export function registerProvenanceBackground(): void {
  if (registered) return;
  registered = true;
  registerHandlers({
    provenanceScanImages: (req) => handleScanImages(req.images ?? []),
    provenanceVerifyText: (req) => runHostVerifyText(req.manifestB64),
  });
}
