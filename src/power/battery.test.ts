import { describe, expect, test } from "vitest";
import { decidePowerAction, type BatteryState, type PressureState } from "./battery";
import { DEFAULT_SETTINGS } from "../shared/settings";

const CHARGING: BatteryState = { supported: true, charging: true, level: 1 };
const ON_BATTERY_OK: BatteryState = { supported: true, charging: false, level: 0.6 };
const ON_BATTERY_LOW: BatteryState = { supported: true, charging: false, level: 0.1 };
const UNSUPPORTED_BATTERY: BatteryState = { supported: false, charging: true, level: 1 };
const CALM: PressureState = { supported: true, level: "nominal" };
const SERIOUS: PressureState = { supported: true, level: "serious" };
const NO_PRESSURE_API: PressureState = { supported: false, level: "nominal" };

const settings = DEFAULT_SETTINGS.battery;

describe("decidePowerAction", () => {
  test("charging, no pressure: normal", () => {
    const d = decidePowerAction(CHARGING, CALM, settings);
    expect(d).toEqual({ pauseAutoRun: false, useLiteModel: false, preferCpu: false, reason: null });
  });

  test("on battery above the pause threshold, default action: normal (not lite/pause)", () => {
    const d = decidePowerAction(ON_BATTERY_OK, CALM, settings);
    expect(d.pauseAutoRun).toBe(false);
    expect(d.reason).toBeNull();
  });

  test("on battery below the pause threshold: pauses and uses the lite model", () => {
    const d = decidePowerAction(ON_BATTERY_LOW, CALM, settings);
    expect(d.pauseAutoRun).toBe(true);
    expect(d.useLiteModel).toBe(true);
    expect(d.reason).toBe("battery-low");
  });

  test("onBatteryAction 'pause' pauses even above the percent threshold", () => {
    const d = decidePowerAction(ON_BATTERY_OK, CALM, { ...settings, onBatteryAction: "pause" });
    expect(d.pauseAutoRun).toBe(true);
    expect(d.reason).toBe("battery-saver");
  });

  test("onBatteryAction 'lite' doesn't pause but requests the lite model", () => {
    const d = decidePowerAction(ON_BATTERY_OK, CALM, { ...settings, onBatteryAction: "lite" });
    expect(d.pauseAutoRun).toBe(false);
    expect(d.useLiteModel).toBe(true);
  });

  test("useCpuOnBattery is honoured only while on battery", () => {
    const onCpu = decidePowerAction(ON_BATTERY_OK, CALM, { ...settings, useCpuOnBattery: true });
    expect(onCpu.preferCpu).toBe(true);
    const charging = decidePowerAction(CHARGING, CALM, { ...settings, useCpuOnBattery: true });
    expect(charging.preferCpu).toBe(false);
  });

  test("serious/critical Compute Pressure pauses regardless of battery", () => {
    const d = decidePowerAction(CHARGING, SERIOUS, settings);
    expect(d.pauseAutoRun).toBe(true);
    expect(d.reason).toBe("cpu-pressure");
  });

  test("pauseOnPressure off ignores pressure", () => {
    const d = decidePowerAction(CHARGING, SERIOUS, { ...settings, pauseOnPressure: false });
    expect(d.pauseAutoRun).toBe(false);
  });

  test("unsupported Battery API + manualOverride acts as on-battery", () => {
    const d = decidePowerAction(UNSUPPORTED_BATTERY, NO_PRESSURE_API, { ...settings, manualOverride: true, onBatteryAction: "pause" });
    expect(d.pauseAutoRun).toBe(true);
  });

  test("unsupported Battery API without manualOverride is treated as not on battery", () => {
    const d = decidePowerAction(UNSUPPORTED_BATTERY, NO_PRESSURE_API, { ...settings, onBatteryAction: "pause" });
    expect(d.pauseAutoRun).toBe(false);
  });
});
