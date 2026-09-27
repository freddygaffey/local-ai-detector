// Content-script side: find the images on the page worth checking.
//  - visible <img> (incl. <picture>, preferring the largest srcset candidate,
//    which is the most likely to still carry metadata/watermarks)
//  - optionally CSS background images of large elements
//  - skips icons/thumbnails below a size threshold, SVG, and duplicates
//  - data:/blob: images are read here (the background can't see them) and
//    sent as base64; http(s) images are fetched by the background/host.

import { bytesToBase64 } from "./text";
import type { ImageCandidate } from "./types";

export interface DiscoverOptions {
  /** Max images returned (per call). */
  max?: number;
  /** Minimum displayed size in CSS px (both dimensions). */
  minDisplay?: number;
  /** Minimum intrinsic size in px (both dimensions). */
  minNatural?: number;
  includeBackgrounds?: boolean;
  /** Max bytes read for data:/blob: images. */
  maxInlineBytes?: number;
  /** URLs to skip (already scanned). */
  skip?: Set<string>;
}

export interface DiscoveredImage {
  element: Element;
  candidate: ImageCandidate;
}

export const DEFAULTS = {
  max: 30,
  minDisplay: 96,
  minNatural: 128,
  maxInlineBytes: 8 * 1024 * 1024,
};

function parseSrcset(srcset: string, base: string): Array<{ url: string; score: number }> {
  const out: Array<{ url: string; score: number }> = [];
  // Candidates are separated by commas followed by whitespace (URLs may
  // themselves contain commas, e.g. CDN transform parameters).
  for (const part of srcset.split(/,\s+(?=\S)/)) {
    const m = /^\s*(\S+?),?(?:\s+(\d+(?:\.\d+)?)([wx]))?\s*,?\s*$/.exec(part);
    if (!m) continue;
    try {
      out.push({
        url: new URL(m[1]!, base).href,
        score: m[2] ? parseFloat(m[2]) * (m[3] === "x" ? 1000 : 1) : 1000,
      });
    } catch {
      // bad URL
    }
  }
  return out;
}

/** Picks the largest candidate of a srcset attribute (by w, or x descriptor). */
export function largestSrcsetCandidate(srcset: string, base: string): string | undefined {
  let best: { url: string; score: number } | undefined;
  for (const c of parseSrcset(srcset, base)) if (!best || c.score > best.score) best = c;
  return best?.url;
}

function bestImgUrl(img: HTMLImageElement): string | undefined {
  const base = document.baseURI;
  const current = img.currentSrc || img.src;
  // In a <picture>, use the <source> the browser actually picked.
  if (img.parentElement?.tagName === "PICTURE") {
    for (const s of Array.from(img.parentElement.querySelectorAll("source"))) {
      const cands = parseSrcset(s.srcset, base);
      if (cands.some((c) => c.url === current)) return largestSrcsetCandidate(s.srcset, base) ?? current;
    }
  }
  if (img.srcset) {
    const cands = parseSrcset(img.srcset, base);
    if (!current || cands.some((c) => c.url === current)) return largestSrcsetCandidate(img.srcset, base) ?? current;
  }
  return current || undefined;
}

function isVisible(el: Element, minDisplay: number): DOMRect | null {
  const r = el.getBoundingClientRect();
  if (r.width < minDisplay || r.height < minDisplay) return null;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity || "1") === 0) return null;
  return r;
}

function isSvgUrl(url: string): boolean {
  return /^data:image\/svg/i.test(url) || /\.svgz?(\?|#|$)/i.test(url);
}

function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += Math.max(1, Math.floor(s.length / 4096))) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Stable, short cache key for a data: URL (so we don't ship megabytes as ids). */
export function dataUrlKey(url: string): string {
  const mime = /^data:([^;,]*)/.exec(url)?.[1] ?? "";
  return `data:${mime};len=${url.length};h=${hashString(url)}`;
}

export function decodeDataUrl(url: string, maxBytes: number): { bytes: Uint8Array; mime?: string } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (!m) return null;
  const isB64 = /;base64/i.test(m[2] ?? "");
  const payload = m[3] ?? "";
  if ((isB64 ? payload.length * 0.75 : payload.length) > maxBytes) return null;
  try {
    if (isB64) {
      const bin = atob(payload.replace(/\s+/g, ""));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return { bytes: out, mime: m[1] || undefined };
    }
    return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mime: m[1] || undefined };
  } catch {
    return null;
  }
}

async function readBlobUrl(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; mime?: string } | null> {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    if (blob.size > maxBytes) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || undefined };
  } catch {
    return null;
  }
}

function cssBackgroundUrl(el: Element): string | undefined {
  const bg = getComputedStyle(el).backgroundImage;
  if (!bg || bg === "none") return undefined;
  const m = /url\((['"]?)(.*?)\1\)/.exec(bg);
  if (!m?.[2]) return undefined;
  try {
    return new URL(m[2], document.baseURI).href;
  } catch {
    return undefined;
  }
}

/** Finds candidate images, in-viewport first then by displayed area. */
export async function discoverImages(opts: DiscoverOptions = {}): Promise<DiscoveredImage[]> {
  const max = opts.max ?? DEFAULTS.max;
  const minDisplay = opts.minDisplay ?? DEFAULTS.minDisplay;
  const minNatural = opts.minNatural ?? DEFAULTS.minNatural;
  const maxInline = opts.maxInlineBytes ?? DEFAULTS.maxInlineBytes;
  const skip = opts.skip ?? new Set<string>();

  interface Raw {
    element: Element;
    url: string;
    rect: DOMRect;
  }
  const raws: Raw[] = [];
  for (const img of Array.from(document.images)) {
    if (!img.complete || img.naturalWidth < minNatural || img.naturalHeight < minNatural) continue;
    const rect = isVisible(img, minDisplay);
    if (!rect) continue;
    const url = bestImgUrl(img);
    if (!url || isSvgUrl(url)) continue;
    raws.push({ element: img, url, rect });
  }
  if (opts.includeBackgrounds) {
    const els = document.body ? document.body.querySelectorAll("*") : [];
    let n = 0;
    for (const el of Array.from(els)) {
      if (++n > 5000) break;
      if (el instanceof HTMLImageElement) continue;
      const rect = isVisible(el, Math.max(minDisplay, 200));
      if (!rect) continue;
      const url = cssBackgroundUrl(el);
      if (!url || isSvgUrl(url) || url.startsWith("data:image/svg")) continue;
      raws.push({ element: el, url, rect });
    }
  }

  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const inView = (r: DOMRect) => r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  raws.sort((a, b) => {
    const va = inView(a.rect) ? 1 : 0;
    const vb = inView(b.rect) ? 1 : 0;
    if (va !== vb) return vb - va;
    return b.rect.width * b.rect.height - a.rect.width * a.rect.height;
  });

  const out: DiscoveredImage[] = [];
  const byKey = new Map<string, DiscoveredImage>();
  for (const r of raws) {
    const key = r.url.startsWith("data:") ? dataUrlKey(r.url) : r.url;
    const existing = byKey.get(key);
    if (existing) {
      // Same image shown twice: badge both, analyse once.
      out.push({ element: r.element, candidate: existing.candidate });
      continue;
    }
    if (skip.has(key)) continue;
    if (byKey.size >= max) break;
    let candidate: ImageCandidate | undefined;
    if (/^https?:/i.test(r.url)) {
      candidate = { src: key, displayWidth: Math.round(r.rect.width), displayHeight: Math.round(r.rect.height) };
    } else if (r.url.startsWith("data:")) {
      const d = decodeDataUrl(r.url, maxInline);
      if (d) candidate = { src: key, bytesB64: bytesToBase64(d.bytes), mime: d.mime };
    } else if (r.url.startsWith("blob:")) {
      const d = await readBlobUrl(r.url, maxInline);
      if (d) candidate = { src: key, bytesB64: bytesToBase64(d.bytes), mime: d.mime };
    }
    if (!candidate) continue;
    const item = { element: r.element, candidate };
    byKey.set(key, item);
    out.push(item);
  }
  return out;
}
