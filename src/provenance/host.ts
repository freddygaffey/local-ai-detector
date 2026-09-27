// Provenance host: registers the handlers that do the actual work.
//  - Chrome: call `registerProvenanceHost()` from the offscreen document
//    (entrypoints/offscreen/main.ts). The background relays to it.
//  - Firefox: the background event page calls the same functions in-process
//    (see ./background.ts), so no registration is needed there.

import { registerHandlers } from "../shared/messages";
import { analyzeCandidates } from "./analyze";
import { readC2pa } from "./c2pa";
import { base64ToBytes } from "./text";
import type { C2paSummary, ImageCandidate, ImageProvenanceResult, TextProvenanceResult } from "./types";

export async function hostAnalyzeImages(images: ImageCandidate[]): Promise<ImageProvenanceResult[]> {
  return analyzeCandidates(images);
}

/**
 * Best-effort signature check of a C2PA text manifest: the JUMBF is read as a
 * detached manifest store ("application/c2pa"). This validates the claim
 * signature and signer trust, but NOT the hard binding to the text (c2pa-web
 * has no text-asset reader), so binding-related failures are ignored and the
 * result says so.
 */
export async function hostVerifyTextManifest(manifestB64: string): Promise<TextProvenanceResult> {
  const bytes = base64ToBytes(manifestB64);
  const base: TextProvenanceResult = {
    found: true,
    manifestBytes: bytes.length,
    issues: [],
    verification: "unverified",
    detail: "C2PA text manifest present (signature not verified).",
  };
  let summary: C2paSummary | null;
  try {
    summary = await readC2pa(new Blob([bytes as BlobPart], { type: "application/c2pa" }), "application/c2pa");
  } catch (err) {
    return { ...base, detail: `${base.detail} The manifest could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!summary) return base;
  return { ...base, ...interpretTextManifest(summary) };
}

/** Codes that only concern the binding between a manifest and its asset. */
const BINDING_CODES =
  /^(assertion\.(dataHash|boxesHash|bmffHash|collectionHash)\.|assertion\.hashedURI\.|manifest\.(missing|inaccessible))/;

/**
 * Interprets a detached (text) manifest's validation: binding failures are
 * expected (the text itself is not hashed here), so the validation state is
 * always "Invalid"; judge the signature and signer from the other codes.
 */
export function interpretTextManifest(
  summary: C2paSummary,
): Pick<TextProvenanceResult, "verification" | "detail" | "c2pa"> {
  const nonBinding = summary.failures.filter((c) => !BINDING_CODES.test(c));
  const untrusted = nonBinding.some((c) => c.startsWith("signingCredential."));
  const sigFailures = nonBinding.filter((c) => !c.startsWith("signingCredential.untrusted"));
  const trusted = !untrusted && !sigFailures.length;
  const c2pa: C2paSummary = { ...summary, trusted };
  const signer = summary.signer ?? "an unknown signer";
  if (sigFailures.length) {
    return {
      c2pa,
      verification: "failed",
      detail: `C2PA text manifest signed by ${signer}, but signature validation failed (${sigFailures.slice(0, 3).join(", ")}).`,
    };
  }
  return {
    c2pa,
    verification: "verified",
    detail:
      `C2PA text manifest signature by ${signer} is valid${trusted ? " and the signer is on the C2PA Trust List" : " (signer not on the bundled C2PA Trust List)"}. ` +
      "Whether the manifest still matches this exact text was not checked.",
  };
}

let registered = false;

/** Chrome offscreen document: answer the background's relayed requests. */
export function registerProvenanceHost(): void {
  if (registered) return;
  registered = true;
  registerHandlers({
    provenanceHostAnalyze: async (req, meta) => {
      // Only the background may drive the host: content scripts' messages
      // reach this document too, and must not bypass the permission checks.
      if (meta.senderTabId !== undefined) throw new Error("not allowed");
      return { results: await hostAnalyzeImages(req.images) };
    },
    provenanceHostVerifyText: async (req, meta) => {
      if (meta.senderTabId !== undefined) throw new Error("not allowed");
      return hostVerifyTextManifest(req.manifestB64);
    },
  });
}
