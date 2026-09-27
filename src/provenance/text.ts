// C2PA text manifests (C2PA 2.x Appendix A.8, "C2PATextManifestWrapper"):
// a JUMBF manifest store encoded as Unicode variation selectors after a
// U+FEFF, appended to the text. Detected with `c2pa-text` (MIT, Encypher).
//
// Detection is pure and safe to run in the content script (page text or the
// user's selection). Signature verification needs c2pa-web, so it is a
// separate background round-trip (`provenanceVerifyText`), and it is
// best-effort: the text hard-binding is not checked (see host.ts).

import { extractManifest, validateText } from "c2pa-text";
import type { TextProvenanceResult } from "./types";

// U+FEFF followed by at least 8 variation selectors (the 8-byte magic alone).
const QUICK = /﻿[︀-️\u{E0100}-\u{E01EF}]{8,}/u;

/** Cheap pre-filter: could `text` contain a C2PA text wrapper? */
export function mayContainTextManifest(text: string): boolean {
  return text.includes("﻿") && QUICK.test(text);
}

export interface TextManifestDetection extends TextProvenanceResult {
  /** Raw manifest bytes (JUMBF) for verification; not sent to the UI. */
  manifest?: Uint8Array;
}

export function detectTextProvenance(text: string): TextManifestDetection {
  if (!mayContainTextManifest(text)) {
    return { found: false, issues: [], verification: "unverified", detail: "No C2PA text manifest found." };
  }
  let extracted: ReturnType<typeof extractManifest> = null;
  try {
    extracted = extractManifest(text);
  } catch {
    extracted = null;
  }
  let issues: string[] = [];
  try {
    issues = validateText(text).issues.map((i) => `${i.code}: ${i.message}`);
  } catch {
    // ignore validator failures
  }
  if (!extracted) {
    return {
      found: false,
      issues,
      verification: "unverified",
      detail: issues.length
        ? "Something that looks like a C2PA text manifest is present, but it is malformed."
        : "No C2PA text manifest found.",
    };
  }
  return {
    found: true,
    offset: extracted.offset,
    length: extracted.length,
    manifestBytes: extracted.manifest.length,
    manifest: extracted.manifest,
    issues,
    verification: "unverified",
    detail: "C2PA text manifest present (signature not verified).",
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Finds C2PA text manifests in the page's text nodes (content script only).
 * Returns one detection per element whose text carries a wrapper.
 */
export function scanDocumentTextProvenance(
  root: Node = document.body,
  maxNodes = 20000,
): Array<{ element: Element | null; result: TextManifestDetection }> {
  const out: Array<{ element: Element | null; result: TextManifestDetection }> = [];
  if (!root) return out;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = 0;
  const seen = new Set<Element | null>();
  for (let node = walker.nextNode(); node && n < maxNodes; node = walker.nextNode(), n++) {
    const t = node.nodeValue ?? "";
    if (!t.includes("﻿")) continue;
    // Wrappers are appended to the end of the text asset, so check the
    // containing block's full text (wrappers may be split across nodes).
    const el = node.parentElement?.closest("p, article, section, div, li, td, pre, blockquote, body") ?? node.parentElement;
    if (seen.has(el)) continue;
    seen.add(el);
    const full = el?.textContent ?? t;
    const result = detectTextProvenance(full);
    if (result.found || result.issues.length) out.push({ element: el, result });
  }
  return out;
}
