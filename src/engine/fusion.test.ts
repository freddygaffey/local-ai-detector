import { describe, expect, it } from "vitest";
import { agreementOf, fuseScores } from "./scoring";
import { detectorsForMode, estimateFusion, estimatedDownloadBytes, fusionFrom, slotsForMode } from "./models";
import { DEFAULT_FUSION, DEFAULT_SETTINGS, migrateSettings, sanitizeFusion, type Settings } from "../shared/settings";
import { FILTER_THRESHOLD, FLAGGED_THRESHOLD, MIN_WORDS_FOR_SCORE, toDisplayProbability } from "../shared/thresholds";

const s = (p: number, weight = 1) => ({ p, weight });

describe("fuseScores", () => {
  it("weighted average uses the weights and ignores NaN", () => {
    expect(fuseScores([s(0.2, 1), s(0.8, 3)], "weighted")).toBeCloseTo(0.65);
    expect(fuseScores([s(0.2, 1), s(Number.NaN, 3)], "weighted")).toBeCloseTo(0.2);
    expect(fuseScores([], "weighted")).toBeNaN();
  });
  it("log-odds average is symmetric and pulled by confident detectors", () => {
    expect(fuseScores([s(0.2), s(0.8)], "logodds")).toBeCloseTo(0.5);
    expect(fuseScores([s(0.4), s(0.99)], "logodds")).toBeGreaterThan(0.695);
  });
  it("vote is the median; an even split does not flag", () => {
    expect(fuseScores([s(0.1), s(0.6), s(0.9)], "vote")).toBeCloseTo(0.6);
    expect(fuseScores([s(0.3), s(0.8)], "vote")).toBeCloseTo(0.3);
    expect(fuseScores([s(0.55), s(0.8)], "vote")).toBeGreaterThanOrEqual(FLAGGED_THRESHOLD);
  });
  it("max takes the highest", () => {
    expect(fuseScores([s(0.1), s(0.7), s(0.3)], "max")).toBeCloseTo(0.7);
  });
  it("a single detector passes through for every method", () => {
    for (const m of ["weighted", "logodds", "vote", "max"] as const) expect(fuseScores([s(0.42)], m)).toBeCloseTo(0.42);
  });
});

describe("agreementOf", () => {
  it("counts detectors agreeing with the fused verdict", () => {
    expect(agreementOf([0.7, 0.8, 0.2], 0.6)).toEqual({ agree: 2, total: 3, disagree: true }); // spread 0.6
    expect(agreementOf([0.7, 0.8, 0.45], 0.65)).toEqual({ agree: 2, total: 3, disagree: false });
    expect(agreementOf([0.1, 0.2], 0.15)).toEqual({ agree: 2, total: 2, disagree: false });
    expect(agreementOf([0.3, 0.6], 0.45)).toEqual({ agree: 1, total: 2, disagree: true });
  });
  it("never reports disagreement for one detector", () => {
    expect(agreementOf([0.9], 0.9)).toEqual({ agree: 1, total: 1, disagree: false });
  });
});

describe("detector sets", () => {
  it("single-detector modes map to one detector", () => {
    expect(detectorsForMode("classifier").detectors).toEqual(["tmr"]);
    expect(detectorsForMode("classifierLite").detectors).toEqual(["lite"]);
    expect(slotsForMode("binoculars")).toEqual(["binocularsObserver", "binocularsPerformer"]);
  });
  it("ensemble mode is Fusion: default set, a chosen set, or the legacy classifier", () => {
    expect(detectorsForMode("ensemble").detectors).toEqual(detectorsForMode("ensemble", DEFAULT_FUSION).detectors);
    expect(slotsForMode("ensemble", { detectors: ["perplexity", "modernbert"], method: "vote" })).toEqual([
      "classifierModernBert",
      "perplexityLM",
    ]);
    expect(fusionFrom("classifierLite").detectors).toEqual(["lite", "perplexity"]);
    expect(detectorsForMode("ensemble", { detectors: ["tmr"], method: "max" }).method).toBe("max");
  });
  it("estimates download size and speed per device", () => {
    const gpu = estimateFusion(["tmr", "perplexity"], "webgpu");
    const cpu = estimateFusion(["tmr", "perplexity"], "wasm");
    expect(cpu.bytes).toBe(estimatedDownloadBytes("ensemble", "wasm", undefined, { detectors: ["tmr", "perplexity"], method: "weighted" }));
    expect(gpu.msPer1kWords).toBeLessThan(cpu.msPer1kWords);
    expect(estimateFusion(["binoculars"], "webgpu").wasmOnly).toHaveLength(2);
    expect(estimateFusion(["tmr"], "wasm", { classifier: { repo: "x/y", revision: "1" } }).bytes).toBeNull();
  });
});

describe("settings migration", () => {
  const merged = (stored: Partial<Settings>) => migrateSettings({ ...DEFAULT_SETTINGS, ...stored } as Settings, stored);
  it("v1 settings move to WebGPU and the default Fusion set", () => {
    const out = merged({ mode: "ensemble", useWebGPU: false });
    expect(out.useWebGPU).toBe(true);
    expect(out.fusion).toEqual(DEFAULT_FUSION);
    expect(out.settingsVersion).toBe(2);
  });
  it("keeps a v1 lite ensemble choice", () => {
    expect(merged({ ensembleClassifier: "classifierLite" }).fusion.detectors).toEqual(["lite", "perplexity"]);
  });
  it("v2 settings are left alone (WebGPU off stays off)", () => {
    const out = merged({ settingsVersion: 2, useWebGPU: false, fusion: { detectors: ["tmr"], method: "max" } });
    expect(out.useWebGPU).toBe(false);
    expect(out.fusion).toEqual({ detectors: ["tmr"], method: "max" });
  });
  it("sanitizes unknown detectors and methods", () => {
    expect(sanitizeFusion({ detectors: ["nope" as never, "tmr", "tmr"], method: "bogus" as never })).toEqual({
      detectors: ["tmr"],
      method: "weighted",
    });
    expect(sanitizeFusion({ detectors: [] }).detectors).toEqual(DEFAULT_FUSION.detectors);
  });
});

describe("display probability", () => {
  it("is monotone in the score and within (0, 1)", () => {
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.05) {
      const p = toDisplayProbability(x);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = p;
    }
  });
  it("uses a context curve when there is one and falls back otherwise", () => {
    const def = toDisplayProbability(0.6);
    expect(toDisplayProbability(0.6, { detectors: ["nope"], method: "weighted", device: "wasm", words: 300 })).toBeGreaterThan(0);
    expect(Number.isFinite(def)).toBe(true);
    expect(toDisplayProbability(Number.NaN)).toBeNaN();
  });
  it("exports the filter threshold and minimum words", () => {
    expect(FILTER_THRESHOLD).toBeGreaterThanOrEqual(FLAGGED_THRESHOLD);
    expect(MIN_WORDS_FOR_SCORE).toBeGreaterThan(0);
  });
});
