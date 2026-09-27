// Idle-unload timing (docs/plan.md T8: "unload models after N minutes
// idle"). Pure so it's unit-testable; entrypoints/background.ts wires this
// to a `browser.alarms` tick and the `unloadIdleModels` message (which the
// engine, owned by T7, may or may not implement yet -- calling it is always
// best-effort and never throws).

/** True once `nowMs - lastActiveMs` reaches `minutes` (<= 0 means "never unload"). */
export function isIdleTooLong(lastActiveMs: number, nowMs: number, minutes: number): boolean {
  if (minutes <= 0) return false;
  return nowMs - lastActiveMs >= minutes * 60_000;
}
