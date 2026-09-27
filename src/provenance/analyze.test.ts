import { describe, expect, it } from "vitest";
import type { ManifestStore } from "@contentauth/c2pa-web";
import { decodePng, readFixture } from "./__fixtures__/decode-png";
import { analyzeCandidates, analyzeImageBytes, sniffFormat, type AnalyzeDeps } from "./analyze";
import { c2paSignal, mayContainC2pa, summarizeManifestStore } from "./c2pa";
import { detectTextProvenance, bytesToBase64 } from "./text";
import { embedManifest } from "c2pa-text";

const OPENAI_STORE = {
  active_manifest: "urn:c2pa:active",
  manifests: {
    "urn:c2pa:active": {
      claim_generator_info: [{ name: "ChatGPT", version: "1.0" }],
      signature_info: { issuer: "OpenAI", common_name: "OpenAI Media Signer", time: "2026-06-01T00:00:00Z" },
      ingredients: [],
      assertions: [
        {
          label: "c2pa.actions.v2",
          data: {
            actions: [
              {
                action: "c2pa.created",
                digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
                softwareAgent: { name: "GPT-4o" },
              },
            ],
          },
        },
      ],
    },
  },
  validation_state: "Trusted",
  validation_results: { activeManifest: { success: [], informational: [], failure: [] } },
} as unknown as ManifestStore;

describe("C2PA manifest mapping", () => {
  it("summarises a trusted AI-generated manifest", () => {
    const s = summarizeManifestStore(OPENAI_STORE);
    expect(s).toMatchObject({
      signer: "OpenAI Media Signer",
      issuer: "OpenAI",
      trusted: true,
      claimGenerator: "ChatGPT 1.0",
      digitalSourceTypes: ["trainedAlgorithmicMedia"],
      actions: ["c2pa.created"],
      softwareAgents: ["GPT-4o"],
    });
    const sig = c2paSignal(s);
    expect(sig).toMatchObject({ kind: "c2pa", verdict: "ai", trusted: true, signed: true, label: "CR" });
    expect(sig.detail).toMatch(/C2PA Trust List/);
  });

  it("marks an untrusted signer and an invalid manifest", () => {
    const untrusted = summarizeManifestStore({
      ...OPENAI_STORE,
      validation_state: "Valid",
      validation_results: { activeManifest: { success: [], informational: [], failure: [{ code: "signingCredential.untrusted" }] } },
    } as unknown as ManifestStore);
    expect(untrusted.trusted).toBe(false);
    expect(c2paSignal(untrusted).detail).toMatch(/not on the bundled C2PA Trust List/);

    const invalid = summarizeManifestStore({
      ...OPENAI_STORE,
      validation_state: "Invalid",
      validation_results: { activeManifest: { success: [], informational: [], failure: [{ code: "assertion.dataHash.mismatch" }] } },
    } as unknown as ManifestStore);
    const sig = c2paSignal(invalid);
    expect(sig.trusted).toBe(false);
    expect(sig.detail).toMatch(/assertion\.dataHash\.mismatch/);
  });

  it("finds AI generation in an ingredient manifest (AI image later edited)", () => {
    const store = {
      active_manifest: "edit",
      manifests: {
        edit: {
          claim_generator: "Adobe_Photoshop/26.0",
          signature_info: { issuer: "Adobe Inc.", common_name: "Adobe Content Credentials" },
          ingredients: [{ title: "gen.png" }],
          assertions: [{ label: "c2pa.actions", data: { actions: [{ action: "c2pa.cropped" }] } }],
        },
        gen: {
          assertions: [
            {
              label: "c2pa.actions",
              data: {
                actions: [
                  {
                    action: "c2pa.created",
                    digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia",
                  },
                ],
              },
            },
          ],
        },
      },
      validation_state: "Trusted",
    } as unknown as ManifestStore;
    const s = summarizeManifestStore(store);
    expect(s.ingredientCount).toBe(1);
    expect(c2paSignal(s).verdict).toBe("edited");
  });

  it("reports camera capture and 'unknown' for manifests without AI actions", () => {
    const cam = summarizeManifestStore({
      active_manifest: "a",
      manifests: {
        a: {
          assertions: [
            { label: "c2pa.actions", data: { actions: [{ action: "c2pa.created", digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture" }] } },
          ],
        },
      },
      validation_state: "Trusted",
    } as unknown as ManifestStore);
    expect(c2paSignal(cam).verdict).toBe("camera");
    const plain = summarizeManifestStore({ active_manifest: "a", manifests: { a: { assertions: [] } }, validation_state: "Valid" } as unknown as ManifestStore);
    expect(c2paSignal(plain).verdict).toBe("unknown");
  });

  it("pre-filters files that cannot contain C2PA", () => {
    expect(mayContainC2pa(new TextEncoder().encode("xxjumbxxc2paxx"))).toBe(true);
    expect(mayContainC2pa(readFixture("clean.png"))).toBe(false);
  });
});

const deps: AnalyzeDeps = {
  readC2pa: async () => {
    throw new Error("readC2pa should not be called for files without C2PA");
  },
  decodePixels: async (bytes) => decodePng(bytes),
};

describe("analyzeImageBytes pipeline", () => {
  it("sniffs formats", () => {
    expect(sniffFormat(readFixture("clean.png"))).toBe("png");
    expect(sniffFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("jpeg");
    expect(sniffFormat(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
  });

  it("reports the SD watermark and the A1111 metadata on the SD1 fixture", async () => {
    const r = await analyzeImageBytes("https://x/sd1.png", readFixture("sd1_bytes.png"), undefined, deps);
    expect(r.status).toBe("ok");
    expect(r.checks).toMatchObject({ c2pa: "not-found", metadata: "found", invisibleWatermark: "found", novelaiAlpha: "not-found" });
    const wm = r.signals.find((s) => s.kind === "invisible-watermark");
    expect(wm).toMatchObject({ verdict: "ai", label: "SD watermark", provider: "Stable Diffusion 1.x", signed: false });
    expect(r.signals.some((s) => s.kind === "metadata")).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("reports FLUX and NovelAI signals", async () => {
    const flux = await analyzeImageBytes("f", readFixture("flux_ref.png"), undefined, deps);
    expect(flux.signals.find((s) => s.kind === "invisible-watermark")?.label).toBe("FLUX watermark");
    const nai = await analyzeImageBytes("n", readFixture("novelai_stealth.png"), undefined, deps);
    expect(nai.signals.find((s) => s.kind === "novelai-alpha")).toMatchObject({ provider: "NovelAI", verdict: "ai" });
    expect(nai.checks.invisibleWatermark).toBe("skipped"); // 64x64 is below 256x256
  });

  it("finds nothing on the clean image and says a miss is not evidence", async () => {
    const r = await analyzeImageBytes("c", readFixture("clean.png"), undefined, deps);
    expect(r.signals).toEqual([]);
    expect(r.checks.invisibleWatermark).toBe("not-found");
    expect(r.notes.join(" ")).toMatch(/fragile/);
  });

  it("uses c2pa-web when the bytes carry a manifest, and survives its errors", async () => {
    const bytes = new Uint8Array([...readFixture("clean.png"), ...new TextEncoder().encode("c2pa")]);
    let called = 0;
    const r = await analyzeImageBytes("x", bytes, undefined, {
      ...deps,
      readC2pa: async () => {
        called++;
        throw new Error("boom");
      },
    });
    expect(called).toBe(1);
    expect(r.checks.c2pa).toBe("error");
    expect(r.errors[0]).toMatch(/C2PA: boom/);
  });

  it("analyses base64 candidates in order with caching", async () => {
    const b64 = bytesToBase64(readFixture("novelai_stealth.png"));
    const res = await analyzeCandidates(
      [
        { src: "data:1", bytesB64: b64 },
        { src: "ftp://nope" },
        { src: "data:1", bytesB64: b64 },
      ],
      deps,
    );
    expect(res.map((r) => r.status)).toEqual(["ok", "error", "ok"]);
    expect(res[0]!.signals[0]?.kind).toBe("novelai-alpha");
  });
});

describe("C2PA text manifests", () => {
  it("detects a wrapper appended to text and ignores plain text", () => {
    // Minimal JUMBF-shaped bytes; the wrapper, not the manifest, is under test.
    const fake = new Uint8Array([0, 0, 0, 16, 0x6a, 0x75, 0x6d, 0x62, 0, 0, 0, 8, 0x6a, 0x75, 0x6d, 0x64]);
    const text = embedManifest("Hello world, this is a paragraph.", fake);
    const r = detectTextProvenance(`Intro. ${text} Outro.`);
    expect(r.found).toBe(true);
    expect(r.manifestBytes).toBe(fake.length);
    expect(r.verification).toBe("unverified");
    expect(r.detail).toMatch(/signature not verified/);
    expect(detectTextProvenance("plain text with a stray ﻿ BOM").found).toBe(false);
  });
});
