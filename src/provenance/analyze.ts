// Provenance host pipeline: bytes -> C2PA + metadata + invisible watermark +
// NovelAI stealth metadata -> ImageProvenanceResult.
//
// Runs in the Chrome offscreen document or the Firefox event page (both are
// extension pages: they can fetch cross-origin with host permissions, spawn
// the c2pa worker, and use createImageBitmap + OffscreenCanvas). Never runs
// in the content script: page images would taint a canvas and page CORS
// would block the fetch.

import { c2paSignal, mayContainC2pa, readC2pa } from "./c2pa";
import { detectInvisibleWatermark, type RgbaImage } from "./dwtdct";
import { extractMetadataSignals } from "./metadata";
import { decodeStealthMetadata } from "./novelai";
import { parsePng } from "./png";
import { WATERMARK_MISS_WORDING } from "./schemes";
import { base64ToBytes } from "./text";
import type { ImageCandidate, ImageChecks, ImageProvenanceResult, ImageSignal } from "./types";

/** Max bytes fetched per image (docs/watermarks.md: ~25 MB). */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** Images analysed at once. */
export const CONCURRENCY = 3;
const CACHE_MAX = 300;

export type ImageFormat = "jpeg" | "png" | "webp" | "gif" | "avif" | "heic" | "bmp" | "svg" | "tiff" | "unknown";

export function sniffFormat(b: Uint8Array): ImageFormat {
  if (b.length < 12) return "unknown";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp";
  if (ascii(0, 4) === "GIF8") return "gif";
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand === "avif" || brand === "avis") return "avif";
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return "heic";
  }
  if (ascii(0, 2) === "BM") return "bmp";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return "tiff";
  const head = ascii(0, Math.min(256, b.length)).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return "unknown";
}

const MIME: Record<ImageFormat, string | undefined> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  heic: "image/heic",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  tiff: "image/tiff",
  unknown: undefined,
};

function emptyChecks(): ImageChecks {
  return { c2pa: "skipped", metadata: "skipped", invisibleWatermark: "skipped", novelaiAlpha: "skipped" };
}

export function errorResult(src: string, status: ImageProvenanceResult["status"], error: string): ImageProvenanceResult {
  return { src, status, signals: [], checks: emptyChecks(), notes: [], errors: [error] };
}

// ---- Fetching ----

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > cap) throw new Error(`image too large (${Math.round(len / 1e6)} MB)`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw new Error(`image too large (> ${Math.round(cap / 1e6)} MB)`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export async function fetchImageBytes(src: string, cap = MAX_IMAGE_BYTES): Promise<{ bytes: Uint8Array; mime?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    // credentials: omit -> no cookies (privacy); we get what a CDN serves anyone.
    const res = await fetch(src, { credentials: "omit", cache: "force-cache", redirect: "follow", signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
    return { bytes: await readCapped(res, cap), mime };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Pixel decoding ----

/** Decoded pixels exactly as stored (no colour management, no premultiplication). */
export async function decodePixels(bytes: Uint8Array, mime: string | undefined): Promise<RgbaImage> {
  const blob = new Blob([bytes as BlobPart], mime ? { type: mime } : undefined);
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  try {
    const { width, height } = bmp;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: true });
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, width, height).data;
    return { data, width, height };
  } finally {
    bmp.close();
  }
}

// ---- Analysis ----

export interface AnalyzeDeps {
  readC2pa: typeof readC2pa;
  decodePixels: typeof decodePixels;
}

const defaultDeps: AnalyzeDeps = { readC2pa, decodePixels };

/** Analyses one image's bytes. Never throws: failures land in `errors`. */
export async function analyzeImageBytes(
  src: string,
  bytes: Uint8Array,
  mimeHint?: string,
  deps: AnalyzeDeps = defaultDeps,
): Promise<ImageProvenanceResult> {
  const format = sniffFormat(bytes);
  const mime = MIME[format] ?? mimeHint;
  const result: ImageProvenanceResult = {
    src,
    status: "ok",
    signals: [],
    checks: emptyChecks(),
    format,
    bytes: bytes.length,
    notes: [],
    errors: [],
  };
  const signals: ImageSignal[] = [];

  // 1. C2PA (signed). Only start the WASM worker if the bytes may carry it.
  if (mayContainC2pa(bytes)) {
    try {
      const summary = await deps.readC2pa(new Blob([bytes as BlobPart], mime ? { type: mime } : undefined), mime);
      if (summary) {
        result.c2pa = summary;
        signals.push(c2paSignal(summary));
        result.checks.c2pa = "found";
      } else {
        result.checks.c2pa = "not-found";
      }
    } catch (err) {
      result.checks.c2pa = "error";
      result.errors.push(`C2PA: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    result.checks.c2pa = "not-found";
  }

  // 2. Metadata (unsigned claims).
  let png = null;
  try {
    png = format === "png" ? await parsePng(bytes) : null;
    if (png) {
      result.width = png.width;
      result.height = png.height;
    }
    const meta = extractMetadataSignals(bytes, png);
    signals.push(...meta);
    result.checks.metadata = meta.length ? "found" : "not-found";
  } catch (err) {
    result.checks.metadata = "error";
    result.errors.push(`metadata: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3 + 4. Pixel-based checks (invisible watermark, NovelAI stealth).
  const pixelFormats: ImageFormat[] = ["jpeg", "png", "webp", "bmp", "avif", "tiff"];
  if (pixelFormats.includes(format)) {
    let img: RgbaImage | undefined;
    try {
      img = await deps.decodePixels(bytes, mime);
      result.width = img.width;
      result.height = img.height;
    } catch (err) {
      result.errors.push(`decode: ${err instanceof Error ? err.message : String(err)}`);
      result.checks.invisibleWatermark = "error";
    }
    if (img) {
      try {
        const det = detectInvisibleWatermark(img);
        if (det.status === "found" && det.payload && det.best) {
          result.checks.invisibleWatermark = "found";
          signals.push({
            kind: "invisible-watermark",
            verdict: "ai",
            trusted: false,
            signed: false,
            label: det.payload.id === "flux" ? "FLUX watermark" : "SD watermark",
            detail:
              `Open-source invisible watermark of ${det.payload.provider} detected ` +
              `(${det.best.wmLen}-bit payload, ${det.best.hamming} bit errors, ` +
              `${Math.round(det.best.agreement * 100)}% of ${det.best.blocks} blocks agree). ` +
              "It is public and unkeyed, so it can also be added to any image on purpose.",
            provider: det.payload.provider,
          });
        } else if (det.status === "not-found") {
          result.checks.invisibleWatermark = "not-found";
          result.notes.push(WATERMARK_MISS_WORDING);
        } else {
          result.checks.invisibleWatermark = "skipped";
          if (det.reason) result.notes.push(`Invisible watermark check skipped: ${det.reason}.`);
        }
      } catch (err) {
        result.checks.invisibleWatermark = "error";
        result.errors.push(`watermark: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (format === "png") {
        try {
          const stealth = await decodeStealthMetadata(img);
          if (stealth) {
            result.checks.novelaiAlpha = "found";
            const md = stealth.metadata;
            const source = typeof md?.Source === "string" ? md.Source : undefined;
            const software = typeof md?.Software === "string" ? md.Software : undefined;
            const isNai = /novel\s*ai/i.test(`${software ?? ""} ${source ?? ""}`);
            signals.push({
              kind: "novelai-alpha",
              verdict: "ai",
              trusted: false,
              signed: false,
              label: "AI claim",
              detail:
                `Unsigned claim: generation metadata hidden in the image's ${stealth.mode.includes("rgb") ? "colour" : "alpha"}-channel ` +
                `least significant bits (${stealth.mode})` +
                (source ? `: ${source.slice(0, 80)}` : "") +
                (isNai ? ". NovelAI signs this metadata, but the signature is not checked here." : "."),
              provider: isNai ? "NovelAI" : (software ?? "Stable Diffusion WebUI (stealth pnginfo)"),
            });
          } else {
            result.checks.novelaiAlpha = "not-found";
          }
        } catch (err) {
          result.checks.novelaiAlpha = "error";
          result.errors.push(`stealth metadata: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  result.signals = signals;
  return result;
}

// ---- Batch with cache + concurrency limit ----

const cache = new Map<string, ImageProvenanceResult>();

function cacheGet(key: string): ImageProvenanceResult | undefined {
  const v = cache.get(key);
  if (v) {
    cache.delete(key);
    cache.set(key, v); // LRU refresh
  }
  return v;
}

function cacheSet(key: string, v: ImageProvenanceResult): void {
  cache.set(key, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

export function clearProvenanceCache(): void {
  cache.clear();
}

async function analyzeCandidate(c: ImageCandidate, deps: AnalyzeDeps): Promise<ImageProvenanceResult> {
  const cached = cacheGet(c.src);
  if (cached) return cached;
  let bytes: Uint8Array;
  let mime = c.mime;
  try {
    if (c.bytesB64) {
      bytes = base64ToBytes(c.bytesB64);
    } else if (/^https?:/i.test(c.src)) {
      const r = await fetchImageBytes(c.src);
      bytes = r.bytes;
      mime = mime ?? r.mime;
    } else {
      return errorResult(c.src, "error", "unsupported URL scheme");
    }
  } catch (err) {
    return errorResult(c.src, "error", `fetch: ${err instanceof Error ? err.message : String(err)}`);
  }
  const res = await analyzeImageBytes(c.src, bytes, mime, deps);
  cacheSet(c.src, res);
  return res;
}

/** Analyses candidates with a small concurrency limit, in input order. */
export async function analyzeCandidates(
  candidates: ImageCandidate[],
  deps: AnalyzeDeps = defaultDeps,
  concurrency = CONCURRENCY,
): Promise<ImageProvenanceResult[]> {
  const out = new Array<ImageProvenanceResult>(candidates.length);
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const i = next++;
      out[i] = await analyzeCandidate(candidates[i]!, deps);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return out;
}
