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

export function publishVoiceStatus(v: { p: number | null; clips: number } | null): void {
  status = v ? { ...status, voice: v.p, voiceClips: v.clips } : { ...status, voice: undefined, voiceClips: undefined };
  emit();
}

export function onVideoStatus(fn: (s: VideoStatus) => void): () => void {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}
