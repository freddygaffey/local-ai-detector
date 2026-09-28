// Video-page status bus: the YouTube transcript check (./youtube) and the
// voice check (../voice/content) publish their latest result here, and the
// corner card (./card.ts via ./main.ts) summarises both on video pages
// ("Script 23%" over "Voice 1%"), so a video gets the same unobtrusive corner
// indicator as an article. All three live in the same content-script bundle,
// so a plain module-level store is enough.

export interface VideoStatus {
  /** Transcript P(AI); undefined = no score (yet). */
  transcript?: number;
  transcriptState?: string;
  /** Voice P(AI); null = not enough clips yet. */
  voice?: number | null;
  voiceClips?: number;
  /** Playback speed of the sampled video; voice samples within VOICE_MIN_RATE..VOICE_MAX_RATE. */
  voiceSpeed?: number;
  /** YouTube's own "Altered or synthetic content" / "Made with AI" label. */
  disclosure?: string | null;
}

let status: VideoStatus = {};
const listeners = new Set<(s: VideoStatus) => void>();

function emit(): void {
  for (const fn of listeners) {
    try {
      fn(status);
    } catch {
      // a broken listener must not stop the others
    }
  }
}

export function publishTranscriptStatus(r: { state: string; probability?: number; disclosure: string | null } | null): void {
  status = r
    ? { ...status, transcript: r.probability, transcriptState: r.state, disclosure: r.disclosure }
    : { ...status, transcript: undefined, transcriptState: undefined, disclosure: null };
  emit();
}

export function publishVoiceStatus(v: { p: number | null; clips: number; speed?: number } | null): void {
  status = v
    ? { ...status, voice: v.p, voiceClips: v.clips, voiceSpeed: v.speed }
    : { ...status, voice: undefined, voiceClips: undefined, voiceSpeed: undefined };
  emit();
}

/**
 * Playback speeds the voice check can score as captured. Measured
 * (docs/voice-spike.md "Playback speed"): up to 2x no human video was flagged
 * after per-video aggregation; from 2.5x the browser's pitch-preserving
 * time-stretch reads as synthetic (34-68% of human windows), and stretching
 * it back to 1x digitally makes it worse, not better. Faster needs the
 * original audio, not the played audio.
 */
export const VOICE_MIN_RATE = 0.75;
export const VOICE_MAX_RATE = 2;
export const voiceRateOk = (rate: number): boolean => rate >= VOICE_MIN_RATE - 0.01 && rate <= VOICE_MAX_RATE + 0.01;

/** True when voice sampling is paused because the video plays outside VOICE_MIN_RATE..VOICE_MAX_RATE. */
export function voicePausedForSpeed(s: VideoStatus): boolean {
  return s.voice === null && typeof s.voiceSpeed === "number" && !voiceRateOk(s.voiceSpeed);
}

export function onVideoStatus(fn: (s: VideoStatus) => void): () => void {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}
