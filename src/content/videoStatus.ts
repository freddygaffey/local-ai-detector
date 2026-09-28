// Video-page status bus: the YouTube transcript check (./youtube) and the
// voice check (../voice/content) publish their latest result here, and the
// corner status chip (./main.ts) summarises both on video pages
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

/** The corner chip's content for a video page: both signals, coloured by the worse one. */
export function videoChipContent(s: VideoStatus): { label: string; score?: number } {
  const pct = (p: number) => `${Math.round(p * 100)}%`;
  const parts: string[] = [];
  if (typeof s.transcript === "number") parts.push(`Script ${pct(s.transcript)}`);
  else if (s.transcriptState === "none") parts.push("No script");
  if (typeof s.voice === "number") parts.push(`Voice ${pct(s.voice)}`);
  else if (s.voice === null) parts.push("Voice …"); // sampling, not enough clips yet
  const scores = [s.transcript, s.voice].filter((x): x is number => typeof x === "number");
  const score = scores.length ? Math.max(...scores) : undefined;
  const flag = s.disclosure ? "⚑ " : "";
  // Stacked, one signal per line: a thumb-sized box in the corner.
  const label = parts.length ? flag + parts.join("\n") : flag + "AI …";
  return { label, score };
}
