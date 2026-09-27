import { describe, expect, test } from "vitest";
import { DEFAULT_FUSION } from "../shared/settings";
import { ALL_FUSION_DETECTORS, checklistRows, checklistTotalBytes, modeDownloadStatus } from "./modelChecklist";

describe("checklistRows", () => {
  test("single-detector modes show exactly one locked, checked row", () => {
    for (const mode of ["classifier", "classifierLite", "perplexity", "binoculars"] as const) {
      const rows = checklistRows(mode, undefined, undefined, "wasm", undefined);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.checked).toBe(true);
      expect(rows[0]!.locked).toBe(true);
    }
  });

  test("ensemble mode lists only the selected detectors by default", () => {
    const rows = checklistRows("ensemble", DEFAULT_FUSION, undefined, "wasm", undefined);
    expect(rows.map((r) => r.id).sort()).toEqual([...DEFAULT_FUSION.detectors].sort());
    expect(rows.every((r) => r.checked)).toBe(true);
  });

  test("listAll=true lists every detector, unselected ones unchecked", () => {
    const rows = checklistRows("ensemble", DEFAULT_FUSION, undefined, "wasm", undefined, true);
    expect(rows).toHaveLength(ALL_FUSION_DETECTORS.length);
    for (const r of rows) expect(r.checked).toBe(DEFAULT_FUSION.detectors.includes(r.id));
  });

  test("the last remaining detector in Fusion is locked", () => {
    const rows = checklistRows("ensemble", { detectors: ["tmr"], method: "weighted" }, undefined, "wasm", undefined, true);
    const tmr = rows.find((r) => r.id === "tmr")!;
    expect(tmr.checked).toBe(true);
    expect(tmr.locked).toBe(true);
    const others = rows.filter((r) => r.id !== "tmr");
    expect(others.every((r) => !r.locked)).toBe(true);
  });

  test("cached is true only when every one of the detector's slots is cached", () => {
    const rows = checklistRows("binoculars", undefined, undefined, "wasm", { binocularsObserver: true, binocularsPerformer: false });
    expect(rows[0]!.cached).toBe(false);
    const rows2 = checklistRows("binoculars", undefined, undefined, "wasm", { binocularsObserver: true, binocularsPerformer: true });
    expect(rows2[0]!.cached).toBe(true);
  });
});

describe("checklistTotalBytes", () => {
  test("sums only checked rows", () => {
    const rows = checklistRows("ensemble", DEFAULT_FUSION, undefined, "wasm", undefined, true);
    const total = checklistTotalBytes(rows);
    const manualTotal = rows.filter((r) => r.checked).reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0);
    expect(total).toBe(manualTotal);
  });
});

describe("modeDownloadStatus", () => {
  test("unknown cache info never greys out a mode", () => {
    expect(modeDownloadStatus("classifier", undefined, undefined, "wasm", undefined).cached).toBe(true);
  });

  test("fully cached mode reports cached with no missing bytes", () => {
    const status = modeDownloadStatus("classifier", undefined, undefined, "wasm", { classifier: true });
    expect(status.cached).toBe(true);
    expect(status.missingBytes).toBeNull();
  });

  test("missing model reports its size", () => {
    const status = modeDownloadStatus("classifier", undefined, undefined, "wasm", { classifier: false });
    expect(status.cached).toBe(false);
    expect(status.missingBytes).toBeGreaterThan(0);
  });
});

describe("defaultsChecklistRows (first-run checklist)", () => {
  test("defaults list the Quick lite model plus the Fusion set, all ticked", async () => {
    const { defaultsChecklistRows } = await import("./modelChecklist");
    const { DEFAULT_SETTINGS } = await import("../shared/settings");
    const rows = defaultsChecklistRows(DEFAULT_SETTINGS, "wasm", undefined);
    expect(rows.map((r) => r.id).sort()).toEqual(["fakespot", "lite", "tmr"]);
    expect(rows.every((r) => r.checked)).toBe(true);
    // The only Quick detector can't be unticked; Fusion rows can while two remain.
    expect(rows.find((r) => r.id === "lite")).toMatchObject({ tier: "quick", locked: true });
    expect(rows.find((r) => r.id === "tmr")).toMatchObject({ tier: "click", locked: false });
  });

  test("no automatic Quick pass -> no lite row", async () => {
    const { defaultsChecklistRows } = await import("./modelChecklist");
    const { DEFAULT_SETTINGS } = await import("../shared/settings");
    const rows = defaultsChecklistRows({ ...DEFAULT_SETTINGS, tiers: { ...DEFAULT_SETTINGS.tiers, autoRunQuick: false } }, "wasm", undefined);
    expect(rows.map((r) => r.id)).not.toContain("lite");
  });
});
