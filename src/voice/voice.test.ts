import { describe, expect, test } from "vitest";
import { CLIP_S, MIN_CLIPS, nextClipDelay, noRoomForClip, effectiveRate, BURST_WINDOW_S, type ScheduleState } from "./schedule";
import { speechGate, FRAME } from "./vad";
import { aggregate, clipProbability, formatVoice, trimmedMean } from "./aggregate";

const LONG: ScheduleState = { watchedS: 0, clips: 5, positionS: 0, durationS: 3600 };

/** Simulate a whole watch-through; returns clip start positions. */
function simulate(durationS: number, rate: Parameters<typeof nextClipDelay>[1], battery = false): number[] {
  const starts: number[] = [];
  let pos = 0;
  let wait = 0;
  for (;;) {
    pos += wait;
    const st = { watchedS: pos, clips: starts.length, positionS: pos, durationS };
    if (noRoomForClip(st)) break;
    starts.push(pos);
    pos += CLIP_S;
    wait = nextClipDelay({ watchedS: pos, clips: starts.length, positionS: pos, durationS }, rate, battery);
  }
  return starts;
}

describe("scheduler", () => {
  test("front-loaded: dense inside the burst window, steady after", () => {
    expect(nextClipDelay({ ...LONG, watchedS: 30 }, "normal")).toBe(12);
    expect(nextClipDelay({ ...LONG, watchedS: BURST_WINDOW_S + 1 }, "normal")).toBeCloseTo(60 - CLIP_S);
    const starts = simulate(600, "normal");
    const early = starts.filter((s) => s < 120).length;
    const late = starts.filter((s) => s >= 120).length;
    expect(early).toBeGreaterThanOrEqual(7); // every ~16 s
    expect(late).toBeGreaterThanOrEqual(7);
    expect(late).toBeLessThanOrEqual(8); // ~1 per min over 8 min
  });

  test("preset scales burst and steady rate", () => {
    const n = (r: "light" | "normal" | "thorough" | "continuous") => simulate(600, r).length;
    expect(n("light")).toBeLessThan(n("normal"));
    expect(n("normal")).toBeLessThan(n("thorough"));
    expect(n("thorough")).toBeLessThan(n("continuous"));
    expect(nextClipDelay({ ...LONG, watchedS: 500 }, "continuous")).toBe(0);
  });

  test("short videos get at least the minimum clips, spread across", () => {
    for (const d of [15, 20, 30, 45]) {
      const starts = simulate(d, "light");
      expect(starts.length).toBeGreaterThanOrEqual(MIN_CLIPS);
    }
    const s = simulate(30, "light");
    expect(s[s.length - 1]).toBeGreaterThan(15); // not all bunched at the start
  });

  test("unknown/live duration uses the plain rate", () => {
    expect(nextClipDelay({ watchedS: 10, clips: 0, positionS: 10, durationS: Infinity }, "normal")).toBe(12);
    expect(noRoomForClip({ watchedS: 10, clips: 0, positionS: 10, durationS: NaN })).toBe(false);
  });

  test("battery saver forces Light", () => {
    expect(effectiveRate("thorough", true)).toBe("light");
    expect(nextClipDelay({ ...LONG, watchedS: 500 }, "thorough", true)).toBeCloseTo(120 - CLIP_S);
    expect(simulate(600, "continuous", true).length).toBe(simulate(600, "light").length);
  });
});

function tone(seconds: number, amp: number, gapEvery = 0): Float32Array {
  const x = new Float32Array(Math.round(seconds * 16000));
  for (let i = 0; i < x.length; i++) {
    const on = gapEvery === 0 || Math.floor(i / (gapEvery * 16000)) % 2 === 0;
    x[i] = on ? amp * Math.sin((2 * Math.PI * 180 * i) / 16000) : 0.0005 * Math.sin(i);
  }
  return x;
}

describe("speech gate", () => {
  test("digital silence is 'silent'", () => {
    expect(speechGate(new Float32Array(64600))).toMatchObject({ ok: false, reason: "silent" });
  });
  test("low-level hiss is rejected", () => {
    const x = new Float32Array(64600).map((_, i) => 0.002 * Math.sin(i * 1.7));
    expect(speechGate(x)).toMatchObject({ ok: false, reason: "no-speech" });
  });
  test("speech-like bursts with pauses pass", () => {
    expect(speechGate(tone(4.04, 0.3, 0.3)).ok).toBe(true);
  });
  test("mostly quiet clip with one short burst fails", () => {
    const x = tone(4.04, 0.0005);
    for (let i = 0; i < FRAME * 10; i++) x[i] = 0.3 * Math.sin(i);
    expect(speechGate(x).ok).toBe(false);
  });
});

describe("aggregation", () => {
  test("tau maps to 50%", () => {
    expect(clipProbability(0, "voiceSpectraAasist3", "strict")).toBeCloseTo(0.5);
    expect(clipProbability(12.26, "voiceW2V2Aasist", "strict")).toBeCloseTo(0.5);
    expect(clipProbability(10, "voiceSpectraAasist3", "strict")).toBeGreaterThan(0.9);
    expect(clipProbability(5, "voiceSpectraAasist3", "sensitive")).toBeGreaterThan(clipProbability(5, "voiceSpectraAasist3", "strict"));
  });
  test("trimmed mean resists outliers", () => {
    expect(trimmedMean([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0])).toBeCloseTo(0.9);
    expect(trimmedMean([0.2, 0.4])).toBeCloseTo(0.3);
  });
  test("needs the minimum clips before a score", () => {
    const c = (p: number, atS = 0) => ({ p, atS });
    expect(aggregate([c(0.9), c(0.8)]).p).toBeNull();
    expect(formatVoice(aggregate([c(0.9), c(0.8)]))).toBe("Voice: — · 2 clips");
    const a = aggregate(Array.from({ length: 14 }, (_, i) => c(i === 0 ? 0 : 0.72, i * 10)));
    expect(formatVoice(a)).toBe("Voice: AI 72% · 14 clips");
  });
});
