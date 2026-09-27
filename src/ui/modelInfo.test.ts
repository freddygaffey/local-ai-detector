import { describe, expect, test } from "vitest";
import { modeSizeMB, licenseLabel } from "./modelInfo";
import { estimatedDownloadBytes } from "../engine/models";

describe("modeSizeMB", () => {
  test("matches the engine's estimatedDownloadBytes, rounded to MB", () => {
    for (const mode of ["ensemble", "classifier", "classifierLite", "perplexity", "binoculars"] as const) {
      const bytes = estimatedDownloadBytes(mode, "wasm")!;
      expect(modeSizeMB(mode)).toBe(Math.round(bytes / (1024 * 1024)));
    }
  });
  test("ensemble is the biggest non-experimental default (~200+ MB)", () => {
    expect(modeSizeMB("ensemble")).toBeGreaterThan(150);
  });
  test("classifier-lite is the smallest option", () => {
    expect(modeSizeMB("classifierLite")).toBeLessThan(modeSizeMB("classifier"));
    expect(modeSizeMB("classifierLite")).toBeLessThan(modeSizeMB("ensemble"));
  });
});

describe("licenseLabel", () => {
  test("formats known licences", () => {
    expect(licenseLabel("mit")).toBe("MIT");
    expect(licenseLabel("apache-2.0")).toBe("Apache-2.0");
  });
  test("falls back for missing licences", () => {
    expect(licenseLabel(null)).toBe("unknown");
    expect(licenseLabel(undefined)).toBe("unknown");
  });
});
