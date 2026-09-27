// Integration test: runs the real c2pa-rs WASM (the same build c2pa-web
// ships) in Node with the extension's exact reader settings, then feeds its
// output through our mapping. Node has no Worker/FileReaderSync, so we call
// the wasm-bindgen reader directly (what c2pa-web's worker does) with a
// minimal synchronous Blob stand-in.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { Context, type ManifestStore } from "@contentauth/c2pa-web";
import * as wasm from "@contentauth/c2pa-wasm";
import { c2paSignal, readerSettings, summarizeManifestStore } from "./c2pa";
import { interpretTextManifest } from "./host";

const require = createRequire(import.meta.url);
const fixture = (p: string) => new URL(`./__fixtures__/${p}`, import.meta.url);

class SyncBlob {
  constructor(
    readonly u8: Uint8Array,
    readonly type = "",
  ) {}
  get size() {
    return this.u8.length;
  }
  slice(a = 0, b = this.u8.length) {
    return new SyncBlob(this.u8.subarray(a, b), this.type);
  }
}

async function read(bytes: Uint8Array, format: string, anchors: string): Promise<ManifestStore> {
  const json = await new Context(readerSettings(anchors)).toJson();
  const reader = await wasm.WasmReader.fromBlob(format, new SyncBlob(bytes, format) as unknown as Blob, json);
  try {
    return reader.manifestStore() as ManifestStore;
  } finally {
    reader.free();
  }
}

/** Concatenates the JUMBF manifest store from a JPEG's APP11 (JPEG XT) segments. */
function jumbfFromJpeg(b: Uint8Array): Uint8Array {
  const parts: Array<{ z: number; data: Uint8Array }> = [];
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (marker === 0xda) break;
    if (marker === 0xeb) {
      const seg = b.subarray(i + 4, i + 2 + len);
      const z = (seg[4]! << 24) | (seg[5]! << 16) | (seg[6]! << 8) | seg[7]!;
      parts.push({ z, data: z === 1 ? seg.subarray(8) : seg.subarray(16) });
    }
    i += 2 + len;
  }
  parts.sort((a, c) => a.z - c.z);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.data.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p.data, o);
    o += p.data.length;
  }
  return out;
}

const trustList = readFileSync(new URL("../../public/provenance/C2PA-TRUST-LIST.pem", import.meta.url), "utf8");
const testRoot = readFileSync(fixture("c2pa/test_cert_root_bundle.pem"), "utf8");
const ca = new Uint8Array(readFileSync(fixture("c2pa/CA.jpg")));

beforeAll(() => {
  (globalThis as unknown as { FileReaderSync: unknown }).FileReaderSync = class {
    readAsArrayBuffer(b: SyncBlob) {
      return b.u8.slice().buffer;
    }
  };
  wasm.initSync({ module: readFileSync(require.resolve("@contentauth/c2pa-wasm/c2pa.wasm")) });
});

describe("c2pa-rs WASM with the extension's settings", () => {
  it("validates a signature offline and reports a signer missing from the C2PA Trust List", async () => {
    const s = summarizeManifestStore(await read(ca, "image/jpeg", trustList));
    expect(s.validationState).toBe("Valid");
    expect(s.trusted).toBe(false);
    expect(s.failures).toContain("signingCredential.untrusted");
    expect(s.signer).toBe("C2PA Signer");
    const sig = c2paSignal(s);
    expect(sig).toMatchObject({ kind: "c2pa", signed: true, trusted: false, verdict: "unknown" });
    expect(sig.detail).toMatch(/not on the bundled C2PA Trust List/);
  });

  it("reports Trusted when the signer chains to a configured anchor (PEM text)", async () => {
    const s = summarizeManifestStore(await read(ca, "image/jpeg", testRoot));
    expect(s.validationState).toBe("Trusted");
    expect(s.trusted).toBe(true);
    expect(c2paSignal(s).trusted).toBe(true);
  });

  it("detects tampering", async () => {
    const tampered = ca.slice();
    tampered[tampered.length - 2000] = tampered[tampered.length - 2000]! ^ 0xff; // flip a byte in the image data
    const s = summarizeManifestStore(await read(tampered, "image/jpeg", testRoot));
    expect(s.validationState).toBe("Invalid");
    expect(s.failures.some((c) => c.startsWith("assertion.dataHash"))).toBe(true);
    expect(c2paSignal(s).trusted).toBe(false);
  });

  it("verifies a detached manifest store (the C2PA text-manifest path) up to, but not including, the binding", async () => {
    const jumbf = jumbfFromJpeg(ca);
    const trusted = interpretTextManifest(summarizeManifestStore(await read(jumbf, "application/c2pa", testRoot)));
    expect(trusted.verification).toBe("verified");
    expect(trusted.c2pa?.trusted).toBe(true);
    expect(trusted.detail).toMatch(/was not checked/);
    const untrusted = interpretTextManifest(summarizeManifestStore(await read(jumbf, "application/c2pa", trustList)));
    expect(untrusted.verification).toBe("verified");
    expect(untrusted.c2pa?.trusted).toBe(false);
    const broken = jumbf.slice();
    // Corrupt the tail of the store (the COSE signature box is last).
    broken[broken.length - 40] = broken[broken.length - 40]! ^ 0xff;
    let outcome: string;
    try {
      outcome = interpretTextManifest(summarizeManifestStore(await read(broken, "application/c2pa", testRoot))).verification;
    } catch {
      outcome = "unreadable";
    }
    expect(["failed", "unreadable"]).toContain(outcome);
  });
});
