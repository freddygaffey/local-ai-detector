import { describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS, migrateSettings, presenceDefaults, type Settings } from "../shared/settings";
import { AUTO_RUN_CHOICES, normalizeHost, offerShowOnPage, presenceSelectValue, sidePanelOnIconClick } from "./optionsLogic";
import { columnList, columnPatch, toggleDetector } from "./tierSettings";

const withPreset = (p: Settings["presence"]): Settings => ({ ...DEFAULT_SETTINGS, presence: p, ...presenceDefaults(p) });

describe("Presence select", () => {
  test("shows the preset until a toggle changes, then Custom", () => {
    const s = withPreset("badge");
    expect(presenceSelectValue(s)).toBe("badge");
    expect(presenceSelectValue({ ...s, surfaces: { ...s.surfaces, chip: true } })).toBe("custom");
    expect(presenceSelectValue({ ...s, autoRunPolicy: "never" })).toBe("custom");
  });
  test("auto-run offers only what works", () => {
    expect(AUTO_RUN_CHOICES).toEqual(["always", "never"]);
  });
});

describe("surfaces drive behaviour, not the preset name", () => {
  test("side panel toggle alone opens the panel on icon click", () => {
    expect(sidePanelOnIconClick(withPreset("sidePanel"))).toBe(true);
    const s = withPreset("statusChip");
    expect(sidePanelOnIconClick(s)).toBe(false);
    expect(sidePanelOnIconClick({ ...s, surfaces: { ...s.surfaces, sidePanel: true } })).toBe(true);
  });
  test("Show on page is offered when nothing paints the page", () => {
    expect(offerShowOnPage(withPreset("onClick"))).toBe(true);
    expect(offerShowOnPage(withPreset("statusChip"))).toBe(false);
    expect(offerShowOnPage(withPreset("inspector"))).toBe(false);
  });
});

describe("normalizeHost", () => {
  test("strips scheme, path, port and case", () => {
    expect(normalizeHost(" https://Example.com/a/b?x ")).toBe("example.com");
    expect(normalizeHost("news.ycombinator.com")).toBe("news.ycombinator.com");
    expect(normalizeHost("http://localhost:3000/")).toBe("localhost");
    expect(normalizeHost("   ")).toBe("");
  });
});

describe("detector matrix", () => {
  test("toggling keeps at least one detector per column", () => {
    expect(toggleDetector(["tmr"], "tmr", false)).toBeNull();
    expect(toggleDetector(["tmr"], "lite", true)).toEqual(["tmr", "lite"]);
    expect(toggleDetector(["fakespot", "tmr"], "fakespot", false)).toEqual(["tmr"]);
  });
  test("each column writes its own setting", () => {
    const s = DEFAULT_SETTINGS;
    expect(columnPatch(s, "fusion", ["lite"]).fusion?.detectors).toEqual(["lite"]);
    expect(columnPatch(s, "quick", ["lite"]).tiers?.quickDetectors).toEqual(["lite"]);
    expect(columnPatch(s, "deep", ["tmr"]).tiers?.deepDetectors).toEqual(["tmr"]);
    expect(columnPatch(s, "quick", ["lite"]).tiers?.deepDetectors).toEqual(s.tiers.deepDetectors);
    expect(columnList(s, "fusion")).toEqual(s.fusion.detectors);
  });
});

describe("auto-run migration: one control", () => {
  const stored = { settingsVersion: 99 } as Partial<Settings>;
  test("the old hidden Quick checkbox off becomes Auto-run: Never", () => {
    const out = migrateSettings({ ...DEFAULT_SETTINGS, tiers: { ...DEFAULT_SETTINGS.tiers, autoRunQuick: false } }, stored);
    expect(out.autoRunPolicy).toBe("never");
    expect(out.tiers.autoRunQuick).toBe(true);
  });
  test("'ask' (never built) becomes 'never', globally and per site", () => {
    const out = migrateSettings({ ...DEFAULT_SETTINGS, autoRunPolicy: "ask", siteRules: { "a.com": "ask", "b.com": "always" } }, stored);
    expect(out.autoRunPolicy).toBe("never");
    expect(out.siteRules).toEqual({ "a.com": "never", "b.com": "always" });
  });
  test("defaults untouched", () => {
    const out = migrateSettings({ ...DEFAULT_SETTINGS }, stored);
    expect(out.autoRunPolicy).toBe(DEFAULT_SETTINGS.autoRunPolicy);
    expect(out.siteRules).toEqual({});
  });
});
