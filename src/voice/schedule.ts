// T11 voice-check sampling scheduler (docs/plan.md "T11 decision").
// Pure: it works on WATCHED playback seconds (time the video actually played,
// not wall-clock or position), so pause/seek never cause extra capture. The
// capture side calls `nextClipDelay` after each clip to learn how much more
// playback to wait before the next one.
//
// - Front-loaded: during the first BURST_WINDOW_S of watched playback, clips
//   are dense (Normal: one every ~12 s) for a fast early verdict; then the
//   steady rate (Normal: one per minute).
// - Short videos (known duration) get at least MIN_CLIPS clips, spread out.
// - The battery saver forces Light.
// - A clip rejected by the speech gate is retried after RETRY_S.

export type VoiceRate = "light" | "normal" | "thorough" | "continuous";

/** Model input: 64,600 samples at 16 kHz (4.04 s). */
export const SAMPLE_RATE = 16000;
export const CLIP_SAMPLES = 64600;
export const CLIP_S = CLIP_SAMPLES / SAMPLE_RATE;

export const BURST_WINDOW_S = 120;
export const MIN_CLIPS = 3;
export const RETRY_S = 3;

/** Gap (s of watched playback) between the end of one clip and the start of the next. */
export const RATE_GAPS: Record<VoiceRate, { burst: number; steady: number }> = {
  light: { burst: 24, steady: 120 - CLIP_S },
  normal: { burst: 12, steady: 60 - CLIP_S },
  thorough: { burst: 6, steady: 20 - CLIP_S },
  continuous: { burst: 0, steady: 0 },
};

export interface ScheduleState {
  /** Seconds of playback watched so far (at the end of the last clip). */
  watchedS: number;
  /** Clips accepted so far (speech-gated). */
  clips: number;
  /** Current playback position (s), for short-video spreading. */
  positionS: number;
  /** Video duration (s), or NaN/Infinity for live/unknown. */
  durationS: number;
}

export function effectiveRate(rate: VoiceRate, batterySaver: boolean): VoiceRate {
  return batterySaver ? "light" : rate;
}

/** Seconds of further watched playback before capturing the next clip. */
export function nextClipDelay(state: ScheduleState, rate: VoiceRate, batterySaver = false): number {
  const gaps = RATE_GAPS[effectiveRate(rate, batterySaver)];
  let gap = state.watchedS < BURST_WINDOW_S ? gaps.burst : gaps.steady;
  const needed = MIN_CLIPS - state.clips;
  if (needed > 0 && Number.isFinite(state.durationS) && state.durationS > 0) {
    // Spread the remaining minimum clips over what is left of the video.
    const remaining = state.durationS - state.positionS;
    const spread = (remaining - needed * CLIP_S) / needed;
    gap = Math.min(gap, Math.max(0, spread));
  }
  return Math.max(0, gap);
}

/** True if the video is too short (or too near its end) to fit another clip. */
export function noRoomForClip(state: ScheduleState): boolean {
  return Number.isFinite(state.durationS) && state.durationS - state.positionS < CLIP_S;
}
