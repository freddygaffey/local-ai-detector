import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings";
import { shouldPreferCpu, unloadIdleModels } from "./router";

const withBattery = (b: Partial<Settings["battery"]>): Settings => ({
  ...DEFAULT_SETTINGS,
  battery: { ...DEFAULT_SETTINGS.battery, ...b },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shouldPreferCpu (T12b per-request device)", () => {
  it("an explicit request wins", async () => {
    expect(await shouldPreferCpu(withBattery({ useCpuOnBattery: false }), true)).toBe(true);
    expect(await shouldPreferCpu(withBattery({ useCpuOnBattery: true, manualOverride: true }), false)).toBe(false);
  });
  it("off unless useCpuOnBattery", async () => {
    expect(await shouldPreferCpu(withBattery({ useCpuOnBattery: false, manualOverride: true }), undefined)).toBe(false);
  });
  it("manual battery-saver override counts as on battery", async () => {
    expect(await shouldPreferCpu(withBattery({ useCpuOnBattery: true, manualOverride: true }), undefined)).toBe(true);
  });
  it("reads the Battery Status API where it exists", async () => {
    vi.stubGlobal("navigator", { getBattery: async () => ({ charging: false, level: 0.8 }) });
    expect(await shouldPreferCpu(withBattery({ useCpuOnBattery: true }), undefined)).toBe(true);
    vi.stubGlobal("navigator", { getBattery: async () => ({ charging: true, level: 0.8 }) });
    expect(await shouldPreferCpu(withBattery({ useCpuOnBattery: true }), undefined)).toBe(false);
  });
});

describe("unloadIdleModels", () => {
  it("is a no-op before any analysis (never starts a host)", async () => {
    expect(await unloadIdleModels()).toEqual({ ok: true });
  });
});
