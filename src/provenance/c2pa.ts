// C2PA / Content Credentials via @contentauth/c2pa-web (MIT).
//
// Runs only where Web Workers are allowed: the Chrome offscreen document or
// the Firefox event page (docs/feasibility.md §1). c2pa-web spawns its own
// worker; under MV3's CSP that must be the packaged file
// public/c2pa/c2pa_worker.js (blob:/data: workers are blocked), which
// scripts/copy-vendor-assets.mjs vendors from node_modules.
//
// Offline by construction: remote manifest fetching and OCSP are disabled,
// and the trust anchors are the bundled C2PA Trust List
// (public/provenance/C2PA-TRUST-LIST.pem, CC-BY-4.0, see its NOTICE).

import { Context, Reader, createC2pa } from "@contentauth/c2pa-web";
import type { C2pa, ManifestStore, Manifest, Settings } from "@contentauth/c2pa-web";
import { browser } from "wxt/browser";
import type { C2paSummary, ImageSignal, Verdict } from "./types";
import { digitalSourceTypeVerdict, matchGenerator, shortDigitalSourceType } from "./metadata";

// ---- Pure mapping (unit-tested) ----

interface ActionLike {
  action?: string;
  digitalSourceType?: string;
  softwareAgent?: string | { name?: string } | null;
  description?: string;
}

function actionsOf(m: Manifest | undefined): ActionLike[] {
  const out: ActionLike[] = [];
  for (const a of m?.assertions ?? []) {
    if (typeof a.label === "string" && a.label.startsWith("c2pa.actions")) {
      const data = a.data as { actions?: ActionLike[] } | undefined;
      if (Array.isArray(data?.actions)) out.push(...data.actions);
    }
  }
  return out;
}

function agentName(a: ActionLike): string | undefined {
  if (!a.softwareAgent) return undefined;
  return typeof a.softwareAgent === "string" ? a.softwareAgent : a.softwareAgent.name ?? undefined;
}

function claimGeneratorOf(m: Manifest | undefined): string | undefined {
  const info = m?.claim_generator_info?.[0];
  if (info?.name) return info.version ? `${info.name} ${info.version}` : info.name;
  return m?.claim_generator ?? undefined;
}

export function summarizeManifestStore(store: ManifestStore): C2paSummary {
  const manifests = (store.manifests ?? {}) as Record<string, Manifest>;
  const active = store.active_manifest ? manifests[store.active_manifest] : undefined;
  const sig = active?.signature_info ?? undefined;

  const digitalSourceTypes = new Set<string>();
  const actions = new Set<string>();
  const softwareAgents = new Set<string>();
  // Look at every manifest in the store: an AI-generated ingredient that was
  // later cropped/edited is still AI-generated.
  for (const m of Object.values(manifests)) {
    for (const a of actionsOf(m)) {
      if (a.action) actions.add(a.action);
      if (a.digitalSourceType) digitalSourceTypes.add(shortDigitalSourceType(a.digitalSourceType));
      const agent = agentName(a);
      if (agent) softwareAgents.add(agent);
    }
  }

  const failures = new Set<string>();
  for (const f of store.validation_results?.activeManifest?.failure ?? []) {
    if (f?.code) failures.add(f.code);
  }
  for (const s of store.validation_status ?? []) {
    if (s?.code && s.success !== true) failures.add(s.code);
  }

  const validationState = store.validation_state ?? undefined;
  const trusted = validationState === "Trusted";
  return {
    signer: sig?.common_name ?? sig?.issuer ?? undefined,
    issuer: sig?.issuer ?? undefined,
    signedAt: sig?.time ?? undefined,
    trusted,
    validationState: validationState ?? undefined,
    claimGenerator: claimGeneratorOf(active),
    digitalSourceTypes: [...digitalSourceTypes],
    actions: [...actions],
    softwareAgents: [...softwareAgents],
    ingredientCount: active?.ingredients?.length ?? 0,
    failures: [...failures],
  };
}

const VERDICT_RANK: Record<Verdict, number> = { ai: 3, edited: 2, camera: 1, unknown: 0 };

export function c2paVerdict(s: C2paSummary): { verdict: Verdict; reason: string } {
  let best: { verdict: Verdict; reason: string } = {
    verdict: "unknown",
    reason: "no AI-related actions recorded",
  };
  for (const dst of s.digitalSourceTypes) {
    const v = digitalSourceTypeVerdict(dst);
    if (v && VERDICT_RANK[v.verdict] > VERDICT_RANK[best.verdict]) best = { verdict: v.verdict, reason: `${v.text} (${dst})` };
  }
  if (best.verdict === "unknown") {
    // Some generators only name themselves in softwareAgent / claim generator.
    const agent = s.softwareAgents.map((a) => matchGenerator(a)).find(Boolean);
    if (agent) best = { verdict: "ai", reason: `created by AI software (${agent})` };
  }
  return best;
}

export function c2paSignal(s: C2paSummary): ImageSignal {
  const { verdict, reason } = c2paVerdict(s);
  const who = s.signer ?? "unknown signer";
  let trustText: string;
  if (s.validationState === "Invalid") {
    trustText = `The Content Credentials signed by ${who} failed validation (${s.failures.slice(0, 3).join(", ") || "invalid"}): the file was modified after signing or the manifest is corrupt.`;
  } else if (s.trusted) {
    trustText = `Content Credentials signed by ${who}, a signer on the C2PA Trust List.`;
  } else {
    trustText = `Content Credentials with a valid signature by ${who}, but the signer is not on the bundled C2PA Trust List.`;
  }
  const gen = s.claimGenerator ? ` Made with: ${s.claimGenerator}.` : "";
  return {
    kind: "c2pa",
    verdict,
    trusted: s.trusted && s.validationState !== "Invalid",
    signed: true,
    label: "CR",
    detail: `${trustText} It says: ${reason}.${gen}`,
    provider: s.signer ?? matchGenerator(s.claimGenerator),
  };
}

/** Cheap pre-check so we only start the WASM worker for files that may carry C2PA. */
export function mayContainC2pa(bytes: Uint8Array): boolean {
  // JUMBF superbox with the "c2pa" label, or a PNG caBX chunk.
  const needles = [
    [0x63, 0x32, 0x70, 0x61], // "c2pa"
    [0x63, 0x61, 0x42, 0x58], // "caBX"
  ];
  for (const n of needles) {
    for (let i = bytes.indexOf(n[0]!); i !== -1 && i + 3 < bytes.length; i = bytes.indexOf(n[0]!, i + 1)) {
      if (bytes[i + 1] === n[1] && bytes[i + 2] === n[2] && bytes[i + 3] === n[3]) return true;
    }
  }
  return false;
}

// ---- Runtime (host only) ----

let c2paPromise: Promise<C2pa> | undefined;
let contextPromise: Promise<Context> | undefined;

function assetUrl(path: string): string {
  return (browser.runtime.getURL as (p: string) => string)(path);
}

/**
 * c2pa-web 0.15.2 only accepts an `https:` workerSrc (it checks
 * `url.protocol` and then calls `toString()`), but extension pages live at
 * chrome-extension:// / moz-extension://, which are just as same-origin and
 * CSP-allowed. Hand it an object that satisfies that check while pointing at
 * the packaged worker.
 */
function packagedWorkerSrc(): URL {
  const href = assetUrl("/c2pa/c2pa_worker.js");
  return { protocol: "https:", href, toString: () => href } as unknown as URL;
}

async function compileWasm(): Promise<WebAssembly.Module> {
  const url = assetUrl("/c2pa/c2pa_bg.wasm");
  try {
    return await WebAssembly.compileStreaming(fetch(url));
  } catch {
    const buf = await (await fetch(url)).arrayBuffer();
    return await WebAssembly.compile(buf);
  }
}

export function getC2pa(): Promise<C2pa> {
  c2paPromise ??= (async () => {
    const wasmSrc = await compileWasm();
    return await createC2pa({ wasmSrc, workerSrc: packagedWorkerSrc() });
  })().catch((err: unknown) => {
    c2paPromise = undefined;
    throw err;
  });
  return c2paPromise;
}

async function loadTrustList(): Promise<string> {
  const res = await fetch(assetUrl("/provenance/C2PA-TRUST-LIST.pem"));
  if (!res.ok) throw new Error(`trust list: HTTP ${res.status}`);
  return await res.text();
}

/** Reader settings used everywhere (also exercised by c2pa.wasm.test.ts). */
export function readerSettings(trustAnchorsPem: string): Settings {
  return {
    verify: {
      verifyTrust: true,
      verifyAfterReading: true,
      // Stay offline: never fetch remote manifests or OCSP responses.
      remoteManifestFetch: false,
      ocspFetch: false,
      // Timestamp authorities are not in the claim-signer list; checking
      // their trust would mark every timestamped asset as untrusted.
      verifyTimestampTrust: false,
    },
    // PEM text (not a URL), so c2pa-web never fetches anything itself.
    trust: { trustAnchors: trustAnchorsPem },
  };
}

export function getReaderContext(): Promise<Context> {
  contextPromise ??= (async () => new Context(readerSettings(await loadTrustList())))().catch((err: unknown) => {
    contextPromise = undefined;
    throw err;
  });
  return contextPromise;
}

/** Reads and validates C2PA from a blob. Returns null if there is no manifest. */
export async function readC2pa(blob: Blob, format?: string): Promise<C2paSummary | null> {
  const [c2pa, context] = await Promise.all([getC2pa(), getReaderContext()]);
  const reader = await Reader.fromBlob(c2pa, format, blob, context);
  if (!reader) return null;
  try {
    return summarizeManifestStore(await reader.manifestStore());
  } finally {
    await reader.free().catch(() => {});
  }
}
