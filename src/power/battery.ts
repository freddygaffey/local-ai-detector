// Battery saver (docs/plan.md "T8: Battery saver", merged into T9). Browsers
// don't expose the OS's own low-power mode, so this uses the two signals
// that exist: the Battery Status API (Chrome; unsupported in Firefox
// desktop -- `navigator.getBattery` is undefined there, confirmed against
// Firefox 156's MDN-documented support table) and the Compute Pressure API
// (Chrome only, behind no flag as of Chrome 115+; unsupported everywhere
// else). Where neither exists, `battery.manualOverride` is the only lever,
// and Options must show it prominently there.
//
// Detection (`readBatteryState`/`readPressureState`) touches real browser
// APIs and isn't itself unit-tested; `decidePowerAction` is pure and is
// (see battery.test.ts).

import type { BatterySaverSettings } from "../shared/settings";

export interface BatteryState {
  supported: boolean;
  charging: boolean;
  /** 0..1 */
  level: number;
}

export type PressureLevel = "nominal" | "fair" | "serious" | "critical";

export interface PressureState {
  supported: boolean;
  level: PressureLevel;
}

export interface PowerDecision {
  /** Auto-run should not start (a manual click always still works). */
  pauseAutoRun: boolean;
  /** Use the fast/lite model even where a fuller one is configured. */
  useLiteModel: boolean;
  /** Prefer CPU (WASM) over GPU (WebGPU) for this run. */
  preferCpu: boolean;
  /** Short machine-readable reason, for the one-line "paused" affordance. Null when not paused/limited. */
  reason: "battery-low" | "battery-saver" | "cpu-pressure" | null;
}

const UNSUPPORTED_BATTERY: BatteryState = { supported: false, charging: true, level: 1 };
const UNSUPPORTED_PRESSURE: PressureState = { supported: false, level: "nominal" };

/** Reads the current Battery Status API state, or the unsupported default. Never throws. */
export async function readBatteryState(): Promise<BatteryState> {
  try {
    const getBattery = (navigator as unknown as { getBattery?: () => Promise<BatteryManagerLike> }).getBattery;
    if (typeof getBattery !== "function") return UNSUPPORTED_BATTERY;
    const battery = await getBattery();
    return { supported: true, charging: battery.charging, level: battery.level };
  } catch {
    return UNSUPPORTED_BATTERY;
  }
}

interface BatteryManagerLike {
  charging: boolean;
  level: number;
}

/**
 * Reads the current Compute Pressure state via a short-lived
 * `PressureObserver`. Never throws; resolves `unsupported` immediately where
 * the API doesn't exist.
 */
export function readPressureState(timeoutMs = 500): Promise<PressureState> {
  return new Promise((resolve) => {
    try {
      const PressureObserverCtor = (
        globalThis as unknown as {
          PressureObserver?: new (
            cb: (records: { state: PressureLevel }[]) => void,
          ) => { observe(source: string): Promise<void>; disconnect(): void };
        }
      ).PressureObserver;
      if (!PressureObserverCtor) {
        resolve(UNSUPPORTED_PRESSURE);
        return;
      }
      let settled = false;
      const observer = new PressureObserverCtor((records) => {
        const latest = records[records.length - 1];
        if (settled || !latest) return;
        settled = true;
        try {
          observer.disconnect();
        } catch {
          // ignore
        }
        resolve({ supported: true, level: latest.state });
      });
      observer.observe("cpu").catch(() => {
        if (!settled) {
          settled = true;
          resolve(UNSUPPORTED_PRESSURE);
        }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            observer.disconnect();
          } catch {
            // ignore
          }
          resolve(UNSUPPORTED_PRESSURE);
        }
      }, timeoutMs);
    } catch {
      resolve(UNSUPPORTED_PRESSURE);
    }
  });
}

/**
 * Pure gating decision: whether auto-run should be paused this time, and
 * whether the run (auto or manual) should use the lite model / prefer CPU.
 * `manualOverride` (Options: "Battery saver", shown prominently where the
 * Battery Status API is unsupported) is treated as "on battery" regardless
 * of what the API reports.
 */
export function decidePowerAction(
  battery: BatteryState,
  pressure: PressureState,
  settings: BatterySaverSettings,
): PowerDecision {
  if (settings.pauseOnPressure && pressure.supported && (pressure.level === "serious" || pressure.level === "critical")) {
    return { pauseAutoRun: true, useLiteModel: true, preferCpu: false, reason: "cpu-pressure" };
  }

  const onBattery = settings.manualOverride || (battery.supported && !battery.charging);
  if (!onBattery) {
    return { pauseAutoRun: false, useLiteModel: false, preferCpu: false, reason: null };
  }

  if (battery.supported && Math.round(battery.level * 100) < settings.pauseBelowPercent) {
    return { pauseAutoRun: true, useLiteModel: true, preferCpu: settings.useCpuOnBattery, reason: "battery-low" };
  }

  if (settings.onBatteryAction === "pause") {
    return { pauseAutoRun: true, useLiteModel: true, preferCpu: settings.useCpuOnBattery, reason: "battery-saver" };
  }

  return {
    pauseAutoRun: false,
    useLiteModel: settings.onBatteryAction === "lite",
    preferCpu: settings.useCpuOnBattery,
    reason: null,
  };
}
