// Transcript cues -> timed, scorable blocks (docs/plan.md "Phase 2: T10").
// Each block is one "segment" in the UI: roughly a minute of speech, cut at
// sentence boundaries, with the start time of every sentence so a flagged
// segment can seek the video. Pure; also imported by the transcript
// calibration scripts (scripts/eval/transcripts/), so what was measured is
// exactly what ships.

import type { SentenceRange, TextBlock } from "../../shared/messages";
import { segmentSentences } from "../segment";
import { looksUnpunctuated, type Cue } from "./transcript";

export interface TranscriptBlock extends TextBlock {
  /** Segment start / end, in seconds. */
  start: number;
  end: number;
  /** Start time (seconds) of each entry in `sentences`. */
  times: number[];
  words: number;
}

/**
 * How sentence units are formed:
 * - "punctuated": the text's own punctuation (Intl.Segmenter).
 * - "pause": for unpunctuated auto-captions, a pseudo-sentence ends at a
 *   pause of `pauseGap` seconds or after `maxSentenceWords` words, and gets a
 *   capital and a full stop.
 * - "raw": one caption line = one unit, text untouched.
 * - "auto" (default): "raw" when the cues look unpunctuated, else "punctuated"
 *   ("pause" measured worse; kept for the calibration scripts).
 */
export type SentenceMode = "auto" | "punctuated" | "pause" | "raw";

export interface ChunkOptions {
  sentenceMode?: SentenceMode;
  pauseGap?: number;
  maxSentenceWords?: number;
  /** A block closes once it has this many words... */
  targetWords?: number;
  /** ...or spans this many seconds (with at least `minBlockWords`). */
  maxSeconds?: number;
  minBlockWords?: number;
  idPrefix?: string;
}

const DEFAULTS = {
  pauseGap: 0.5,
  maxSentenceWords: 28,
  targetWords: 160,
  maxSeconds: 90,
  minBlockWords: 40,
  idPrefix: "yt",
};

/** Typical speaking rate, used to estimate a cue's end when the source has no durations (the panel). */
const WORDS_PER_SECOND = 2.6;

interface TimedSentence {
  text: string;
  time: number;
  end: number;
}

function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function cueEnd(c: Cue, next: Cue | undefined): number {
  if (c.dur !== undefined) return c.start + c.dur;
  const est = c.start + countWords(c.text) / WORDS_PER_SECOND;
  return next ? Math.min(est, next.start) : est;
}

function punctuatedSentences(cues: readonly Cue[]): TimedSentence[] {
  let text = "";
  const offsets: number[] = [];
  for (const c of cues) {
    if (text) text += " ";
    offsets.push(text.length);
    text += c.text;
  }
  const cueAt = (offset: number) => {
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const out: TimedSentence[] = [];
  for (const span of segmentSentences(text)) {
    const raw = text.slice(span.start, span.end);
    const lead = raw.length - raw.trimStart().length;
    const s = raw.trim();
    if (!s) continue;
    const first = cueAt(span.start + lead);
    const last = cueAt(Math.max(span.start + lead, span.end - 1));
    out.push({ text: s, time: cues[first]!.start, end: cueEnd(cues[last]!, cues[last + 1]) });
  }
  return out;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pauseSentences(cues: readonly Cue[], gap: number, maxWords: number): TimedSentence[] {
  const out: TimedSentence[] = [];
  let words: string[] = [];
  let start = 0;
  let end = 0;
  const flush = () => {
    if (words.length === 0) return;
    let s = capitalise(words.join(" "));
    if (!/[.?!]$/.test(s)) s += ".";
    out.push({ text: s, time: start, end });
    words = [];
  };
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    const cw = c.text.split(/\s+/).filter(Boolean);
    const prev = cues[i - 1];
    if (prev && words.length > 0 && c.start - cueEnd(prev, c) >= gap) flush();
    // Words inside one cue share its time span (evenly spread) for the length cap.
    const dur = Math.max(0, cueEnd(c, cues[i + 1]) - c.start);
    for (let k = 0; k < cw.length; k++) {
      if (words.length >= maxWords) flush();
      const t = c.start + (dur * k) / Math.max(1, cw.length);
      if (words.length === 0) start = t;
      words.push(cw[k]!);
      end = c.start + (dur * (k + 1)) / Math.max(1, cw.length);
    }
  }
  flush();
  return out;
}

function rawSentences(cues: readonly Cue[]): TimedSentence[] {
  return cues.map((c, i) => ({ text: c.text, time: c.start, end: cueEnd(c, cues[i + 1]) }));
}

/** Resolves "auto" to the concrete mode used for these cues. */
export function resolveSentenceMode(cues: readonly Cue[], mode: SentenceMode = "auto"): Exclude<SentenceMode, "auto"> {
  if (mode !== "auto") return mode;
  // Measured (docs/calibration.md "Transcripts"): on unpunctuated captions,
  // plain caption lines rank better than pause-based pseudo-sentences.
  return looksUnpunctuated(cues) ? "raw" : "punctuated";
}

/**
 * True when the Quick tier should skip scoring this transcript rather than
 * feed the lite model unpunctuated text it's near chance on (AUROC 0.69,
 * docs/calibration.md "Transcripts"). That weakness is specific to *auto*
 * (ASR) captions -- manual captions that happen to read as unpunctuated
 * (rare) aren't machine transcription and don't share it, so Quick still
 * scores them (the fresh-install bug: a punctuated or manual transcript must
 * get a Quick score, not a silent skip).
 */
export function skipQuickPass(autoGenerated: boolean | undefined, cues: readonly Cue[]): boolean {
  return !!autoGenerated && resolveSentenceMode(cues) === "raw";
}

/** Groups transcript cues into timed blocks for the engine's normal `analyze` path. */
export function buildTranscriptBlocks(cues: readonly Cue[], options: ChunkOptions = {}): TranscriptBlock[] {
  const o = { ...DEFAULTS, ...options };
  if (cues.length === 0) return [];
  const mode = resolveSentenceMode(cues, o.sentenceMode);
  const sentences =
    mode === "punctuated" ? punctuatedSentences(cues) : mode === "pause" ? pauseSentences(cues, o.pauseGap, o.maxSentenceWords) : rawSentences(cues);

  const blocks: TranscriptBlock[] = [];
  let cur: TimedSentence[] = [];
  let curWords = 0;
  const close = () => {
    if (cur.length === 0) return;
    let text = "";
    const spans: SentenceRange[] = [];
    for (const s of cur) {
      if (text) text += " ";
      spans.push({ start: text.length, end: text.length + s.text.length });
      text += s.text;
    }
    blocks.push({
      id: `${o.idPrefix}-${blocks.length}`,
      text,
      sentences: spans,
      times: cur.map((s) => s.time),
      start: cur[0]!.time,
      end: cur[cur.length - 1]!.end,
      words: curWords,
    });
    cur = [];
    curWords = 0;
  };
  for (const s of sentences) {
    const w = countWords(s.text);
    if (cur.length > 0) {
      const long = s.time - cur[0]!.time >= o.maxSeconds && curWords >= o.minBlockWords;
      if (curWords >= o.targetWords || long) close();
    }
    cur.push(s);
    curWords += w;
  }
  // Fold a short tail into the previous block rather than scoring a scrap.
  if (cur.length > 0 && curWords < o.minBlockWords && blocks.length > 0) {
    const prev = blocks.pop()!;
    const merged: TimedSentence[] = prev.sentences.map((sp, i) => ({ text: prev.text.slice(sp.start, sp.end), time: prev.times[i]!, end: prev.end }));
    const tailWords = curWords;
    cur = [...merged, ...cur];
    curWords = prev.words + tailWords;
  }
  close();
  return blocks.map((b, i) => ({ ...b, id: `${o.idPrefix}-${i}` }));
}

/**
 * Keeps the whole transcript when it fits `maxWords`; otherwise evenly
 * spaced blocks across the video (so a long video's score isn't just its
 * intro). Order is preserved.
 */
export function sampleBlocks<T extends { words: number }>(blocks: readonly T[], maxWords: number): T[] {
  const total = blocks.reduce((n, b) => n + b.words, 0);
  if (total <= maxWords || blocks.length === 0) return [...blocks];
  const avg = total / blocks.length;
  const k = Math.max(1, Math.min(blocks.length, Math.floor(maxWords / avg)));
  const out: T[] = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.min(blocks.length - 1, Math.floor(((i + 0.5) * blocks.length) / k));
    if (out[out.length - 1] !== blocks[idx]) out.push(blocks[idx]!);
  }
  return out;
}

/** Wire form for `analyze` (drops the timing fields). */
export function toTextBlocks(blocks: readonly TranscriptBlock[]): TextBlock[] {
  return blocks.map((b) => ({ id: b.id, text: b.text, sentences: b.sentences }));
}

/** Start time (seconds) of a sentence in a block, or the block's start. */
export function timeOf(blocks: readonly TranscriptBlock[], blockId: string, index = 0): number | null {
  const b = blocks.find((x) => x.id === blockId);
  if (!b) return null;
  return b.times[index] ?? b.start;
}
