// Presence-preset mapping tests (docs/plan.md "T9: Presence modes"). Kept
// separate from settings.test.ts (none previously existed for this file) so
// T9's additions are easy to find.

import { describe, expect, test } from "vitest";
import {
  autoRunPolicyForSite,
  DEFAULT_SETTINGS,
  isPresenceCustom,
  presenceDefaults,
  PRESENCE_PRESETS,
  type Presence,
  type Settings,
} from "./settings";

describe("presenceDefaults / PRESENCE_PRESETS", () => {
  test("every preset is covered", () => {
    const presets: Presence[] = ["onClick", "badge", "statusChip", "inspector", "sidePanel"];
    for (const p of presets) expect(PRESENCE_PRESETS[p]).toBeDefined();
  });

  test("onClick never auto-runs and shows nothing on the page", () => {
    const d = presenceDefaults("onClick");
    expect(d.autoRunPolicy).toBe("never");
    expect(d.surfaces.chip).toBe(false);
    expect(d.surfaces.highlights).toBe(false);
  });

  test("statusChip auto-runs and shows the chip but not highlights", () => {
    const d = presenceDefaults("statusChip");
    expect(d.autoRunPolicy).toBe("always");
    expect(d.surfaces.chip).toBe(true);
    expect(d.surfaces.highlights).toBe(false);
  });

  test("inspector shows highlights but not the chip", () => {
    const d = presenceDefaults("inspector");
    expect(d.surfaces.highlights).toBe(true);
    expect(d.surfaces.chip).toBe(false);
  });

  test("sidePanel marks the page nowhere", () => {
    const d = presenceDefaults("sidePanel");
    expect(d.surfaces.highlights).toBe(false);
    expect(d.surfaces.chip).toBe(false);
    expect(d.surfaces.sidePanel).toBe(true);
  });
});

function settingsFor(presence: Presence): Pick<Settings, "presence" | "autoRunPolicy" | "surfaces"> {
  const d = presenceDefaults(presence);
  return { presence, autoRunPolicy: d.autoRunPolicy, surfaces: { ...d.surfaces } };
}

describe("isPresenceCustom", () => {
  test("false right after picking a preset", () => {
    for (const p of ["onClick", "badge", "statusChip", "inspector", "sidePanel"] as Presence[]) {
      expect(isPresenceCustom(settingsFor(p))).toBe(false);
    }
  });

  test("true once autoRunPolicy is edited away from the preset", () => {
    const s = settingsFor("statusChip");
    expect(isPresenceCustom({ ...s, autoRunPolicy: "never" })).toBe(true);
  });

  test("true once a surface is toggled away from the preset", () => {
    const s = settingsFor("inspector");
    expect(isPresenceCustom({ ...s, surfaces: { ...s.surfaces, chip: true } })).toBe(true);
  });

  test("the default settings match their own preset (not custom out of the box)", () => {
    expect(isPresenceCustom(DEFAULT_SETTINGS)).toBe(false);
  });
});

// Persona walkthrough finding: a fresh install must actually get the
// intended default (Status chip, auto-run on) -- not a stale/mismatched
// value from an old build or a partial migration.
describe("fresh-install defaults", () => {
  test("Status chip, auto-run always on", () => {
    expect(DEFAULT_SETTINGS.presence).toBe("statusChip");
    expect(DEFAULT_SETTINGS.autoRunPolicy).toBe("always");
    expect(DEFAULT_SETTINGS.autoRunFastMode).toBe("classifierLite");
  });
});

describe("autoRunPolicyForSite", () => {
  test("falls back to the global policy with no site rule", () => {
    expect(autoRunPolicyForSite({ autoRunPolicy: "always", siteRules: {} }, "example.com")).toBe("always");
  });

  test("a site rule overrides the global policy ('never on this site')", () => {
    expect(
      autoRunPolicyForSite({ autoRunPolicy: "always", siteRules: { "example.com": "never" } }, "example.com"),
    ).toBe("never");
  });

  test("a site rule only applies to its own hostname", () => {
    expect(
      autoRunPolicyForSite({ autoRunPolicy: "always", siteRules: { "example.com": "never" } }, "other.example"),
    ).toBe("always");
  });
});
