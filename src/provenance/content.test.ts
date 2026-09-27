import { describe, expect, it } from "vitest";
import { badgeText, primarySignal, signalHeading } from "./badges";
import { dataUrlKey, decodeDataUrl, largestSrcsetCandidate } from "./discover";
import { originPattern } from "./permissions";
import { UNCHECKABLE_SCHEMES } from "./schemes";
import type { ImageProvenanceResult, ImageSignal } from "./types";

const meta: ImageSignal = { kind: "metadata", verdict: "ai", trusted: false, signed: false, label: "AI claim", detail: "x" };
const wm: ImageSignal = { kind: "invisible-watermark", verdict: "ai", trusted: false, signed: false, label: "SD watermark", detail: "x" };
const cr: ImageSignal = { kind: "c2pa", verdict: "ai", trusted: true, signed: true, label: "CR", detail: "x" };
const crNoAi: ImageSignal = { kind: "c2pa", verdict: "unknown", trusted: false, signed: true, label: "CR", detail: "x" };

describe("discovery helpers", () => {
  it("picks the largest srcset candidate", () => {
    const base = "https://example.com/page/";
    expect(largestSrcsetCandidate("a.jpg 320w, b.jpg 1280w, c.jpg 640w", base)).toBe("https://example.com/page/b.jpg");
    expect(largestSrcsetCandidate("a.jpg, b.jpg 2x", base)).toBe("https://example.com/page/b.jpg");
    expect(largestSrcsetCandidate("https://cdn.x/i.jpg?w=400,h=300 400w, https://cdn.x/i.jpg?w=1200,h=900 1200w", base)).toBe(
      "https://cdn.x/i.jpg?w=1200,h=900",
    );
  });

  it("decodes data: URLs with a size cap and keys them compactly", () => {
    const url = "data:image/png;base64,iVBORw0KGgo=";
    expect(decodeDataUrl(url, 1000)?.bytes.slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(decodeDataUrl(url, 2)).toBeNull();
    expect(dataUrlKey(url)).toMatch(/^data:image\/png;len=\d+;h=[0-9a-f]+$/);
  });

  it("builds per-origin permission patterns", () => {
    expect(originPattern("https://cdn.example.com:8443/a.png?x=1")).toBe("https://cdn.example.com/*");
    expect(originPattern("data:image/png;base64,xx")).toBeNull();
  });
});

describe("badge text", () => {
  it("prefers trusted Content Credentials, then AI signals, then stronger kinds", () => {
    expect(primarySignal([meta, wm, cr])).toBe(cr);
    expect(primarySignal([crNoAi, meta])).toBe(meta);
    expect(primarySignal([meta, wm])).toBe(wm);
  });

  it("labels badges with an overflow count and honest headings", () => {
    const r: ImageProvenanceResult = {
      src: "s",
      status: "ok",
      signals: [meta, wm],
      checks: { c2pa: "not-found", metadata: "found", invisibleWatermark: "found", novelaiAlpha: "skipped" },
      notes: [],
      errors: [],
    };
    expect(badgeText(r)).toBe("SD watermark +1");
    expect(badgeText({ ...r, signals: [] })).toBeNull();
    expect(signalHeading(cr)).toBe("Provenance found (verified signer)");
    expect(signalHeading(crNoAi)).toBe("Provenance found (untrusted or unknown signer)");
    expect(signalHeading(meta)).toBe("Unsigned AI metadata claim");
  });

  it("lists the schemes that cannot be checked locally, with checker links", () => {
    const ids = UNCHECKABLE_SCHEMES.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["synthid", "openai-verify", "claude-text", "meta-content-seal"]));
    expect(UNCHECKABLE_SCHEMES.find((s) => s.id === "openai-verify")?.checker?.url).toBe("https://openai.com/verify");
  });
});
