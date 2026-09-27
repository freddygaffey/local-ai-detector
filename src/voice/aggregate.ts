// Per-clip calibration and robust aggregation for the voice check.
//
// Each clip gives the model's spoof-minus-bona-fide logit margin. The
// sensitivity picks an operating point `tau` (the margin at which a clip reads
// 50%), fitted on the T11 spike's human clips over clean + codec conditions
// (docs/voice-spike.md; int8 scores, i.e. the shipped files; scratchpad t11/strict.py):
//   Strict    = 99th percentile of human windows (0% human clips flagged)
//   Balanced  = 95th percentile
//   Sensitive = 90th percentile
// p = sigmoid((margin - tau) / scale). The running score is a trimmed mean of
// the per-clip p, so a few odd clips (music sting, laughter) cannot swing it.

export type VoiceSensitivity = "strict" | "balanced" | "sensitive";
export type VoiceModelId = "voiceW2V2Aasist" | "voiceSpectraAasist3";

export interface VoiceCalibration {
  tau: Record<VoiceSensitivity, number>;
  scale: number;
}

export const VOICE_CALIBRATION: Record<VoiceModelId, VoiceCalibration> = {
  voiceW2V2Aasist: { tau: { strict: 12.26, balanced: 8.21, sensitive: 6.67 }, scale: 1.5 },
  voiceSpectraAasist3: { tau: { strict: 0, balanced: -6.99, sensitive: -12.68 }, scale: 3 },
};

/** Fewer accepted clips than this shows "—" instead of a number. */
export const MIN_CLIPS_FOR_SCORE = 3;

export function clipProbability(margin: number, model: VoiceModelId, sensitivity: VoiceSensitivity): number {
  const c = VOICE_CALIBRATION[model];
  const z = (margin - c.tau[sensitivity]) / c.scale;
  return 1 / (1 + Math.exp(-z));
}

/** Mean after dropping `trim` of the values from each end (at least 1 each end once n >= 5). */
export function trimmedMean(values: number[], trim = 0.1): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const k = s.length >= 5 ? Math.max(1, Math.floor(s.length * trim)) : 0;
  const kept = s.slice(k, s.length - k);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

export interface VoiceClip {
  /** Playback position (s) at the start of the clip. */
  atS: number;
  /** Calibrated P(AI) for this clip. */
  p: number;
}

export interface VoiceAggregate {
  /** Trimmed-mean P(AI), or null while fewer than MIN_CLIPS_FOR_SCORE clips. */
  p: number | null;
  clips: number;
}

export function aggregate(clips: VoiceClip[]): VoiceAggregate {
  if (clips.length < MIN_CLIPS_FOR_SCORE) return { p: null, clips: clips.length };
  return { p: trimmedMean(clips.map((c) => c.p)), clips: clips.length };
}

/** "Voice: AI 72% · 14 clips", or "Voice: — · 2 clips" before there's a score. */
export function formatVoice(a: VoiceAggregate): string {
  const n = `${a.clips} clip${a.clips === 1 ? "" : "s"}`;
  if (a.p === null) return `Voice: — · ${n}`;
  return `Voice: AI ${Math.round(a.p * 100)}% · ${n}`;
}
