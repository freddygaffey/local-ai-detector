import { describe, expect, it } from "vitest";
import { summarizeImageResults } from "./summary";
import type { ImageProvenanceResult, ImageSignal } from "./types";

const checks = { c2pa: "not-found", metadata: "not-found", invisibleWatermark: "not-found", novelaiAlpha: "not-found" } as const;
const sig = (p: Partial<ImageSignal>): ImageSignal => ({
  kind: "metadata",
  verdict: "ai",
  trusted: false,
  signed: false,
  label: "x",
  detail: "x",
  ...p,
});
const res = (signals: ImageSignal[], extra: Partial<ImageProvenanceResult> = {}): ImageProvenanceResult => ({
  src: Math.random().toString(),
  status: "ok",
  signals,
  checks: { ...checks },
  notes: [],
  errors: [],
  ...extra,
});

describe("summarizeImageResults", () => {
  it("counts credentials, trust, AI signals, unsigned claims and watermarks separately", () => {
    const s = summarizeImageResults(
      [
        res([sig({ kind: "c2pa", signed: true, trusted: true, verdict: "ai" })]),
        res([sig({ kind: "c2pa", signed: true, trusted: false, verdict: "unknown" })]),
        res([sig({ kind: "metadata", verdict: "ai" })]),
        res([sig({ kind: "invisible-watermark", verdict: "ai" })]),
        res([]),
        res([], { status: "error", errors: ["decode failed"] }),
      ],
      { permissionNeeded: ["https://cdn.example/*", "https://cdn.example/*"] },
    );
    expect(s).toEqual({
      total: 6,
      checked: 5,
      withCredentials: 2,
      trustedCredentials: 1,
      aiSignals: 3,
      withUnsignedClaim: 1,
      withWatermark: 1,
      permissionNeeded: ["https://cdn.example/*"],
    });
  });

  it("marks the summary disabled when image checks are off", () => {
    expect(summarizeImageResults([], { disabled: true }).disabled).toBe(true);
  });
});
