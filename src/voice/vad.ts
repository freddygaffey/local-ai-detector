// Energy-based speech gate for voice-check clips (docs/plan.md "T11 decision":
// no fixed intro skip; discard clips with little speech and retry). Cheap and
// pure: 20 ms frames, RMS in dBFS, a frame is "active" when it is above both an
// absolute floor and the clip's own noise floor + margin. A digitally silent
// clip (e.g. Firefox's silent track for a cross-origin, no-CORS source) is
// reported separately so the caller can give up with "—".

export const FRAME = 320; // 20 ms at 16 kHz
export const ABS_FLOOR_DB = -45;
export const NOISE_MARGIN_DB = 12;
export const MIN_ACTIVE_FRACTION = 0.35;
const SILENT_RMS = 1e-5;

export type GateResult =
  | { ok: true; activeFraction: number }
  | { ok: false; reason: "silent" | "no-speech"; activeFraction: number };

export function frameDb(x: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + FRAME <= x.length; i += FRAME) {
    let s = 0;
    for (let j = i; j < i + FRAME; j++) s += x[j] * x[j];
    const rms = Math.sqrt(s / FRAME);
    out.push(20 * Math.log10(Math.max(rms, 1e-10)));
  }
  return out;
}

export function speechGate(x: Float32Array): GateResult {
  let total = 0;
  for (let i = 0; i < x.length; i++) total += x[i] * x[i];
  if (x.length === 0 || Math.sqrt(total / x.length) < SILENT_RMS) {
    return { ok: false, reason: "silent", activeFraction: 0 };
  }
  const db = frameDb(x);
  const sorted = [...db].sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.1)] ?? -100;
  const thr = Math.max(ABS_FLOOR_DB, noiseFloor + NOISE_MARGIN_DB);
  const active = db.filter((d) => d > thr).length / Math.max(1, db.length);
  // Speech has pauses: a steady tone/music bed is "active" everywhere but has
  // no floor/peak contrast, so it fails the noise-floor test above.
  return active >= MIN_ACTIVE_FRACTION
    ? { ok: true, activeFraction: active }
    : { ok: false, reason: "no-speech", activeFraction: active };
}
