// Turns a timed eval text (build-transcript-set.mjs) into YouTube-style
// caption cues for each test condition (docs/calibration.md "Transcripts").
//
//   punct    captions that keep the text's punctuation and case (uploaded
//            captions; 2026 YouTube ASR is often punctuated too)
//   raw      classic auto-captions: lowercase, no punctuation, lines of 4-10
//            words split with no regard to sentences; one caption line = one unit
//   pause    the same cues, pseudo-sentences cut at pauses (the shipped default
//            for unpunctuated tracks)
//   pause-panel  the same, but only integer-second start times and no
//            durations (what the transcript panel gives)
//   restored the raw text run through an offline punctuation/truecasing model
//            (restore-punctuation.py), then treated as punctuated

/** Lowercase, strip punctuation (apostrophes kept), like classic auto-captions. */
export function normaliseWord(w) {
  return w
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[-–—/]/g, " ")
    .replace(/[^a-z0-9' ]/g, "")
    .replace(/^'+|'+$/g, "")
    .trim();
}

export function normalisedWords(timed) {
  const out = [];
  for (const { w, t } of timed) {
    for (const part of normaliseWord(w).split(/\s+/)) if (part) out.push({ w: part, t });
  }
  return out;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Caption lines of 4-10 words, cut without regard to sentences. */
export function toCues(timed, seed, { panel = false } = {}) {
  const r = rng(seed);
  const cues = [];
  let i = 0;
  while (i < timed.length) {
    const n = 4 + Math.floor(r() * 7);
    const chunk = timed.slice(i, i + n);
    const next = timed[i + n];
    const start = chunk[0].t;
    const lastT = chunk[chunk.length - 1].t;
    const end = Math.min(next ? next.t : lastT + 0.5, lastT + 0.5);
    const text = chunk.map((x) => x.w).join(" ");
    cues.push(panel ? { start: Math.floor(start), text } : { start, dur: Math.max(0.2, end - start), text });
    i += n;
  }
  return cues;
}

export function seedOf(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Cues and chunker mode for one condition. `restored` maps item id ->
 * punctuated word list aligned with normalisedWords (restore-punctuation.py).
 */
export function conditionInput(item, condition, restored) {
  const seed = seedOf(item.id);
  switch (condition) {
    case "punct":
      return { cues: toCues(item.timed, seed), sentenceMode: "punctuated" };
    case "raw":
      return { cues: toCues(normalisedWords(item.timed), seed), sentenceMode: "raw" };
    case "pause":
      return { cues: toCues(normalisedWords(item.timed), seed), sentenceMode: "pause" };
    case "pause-panel":
      return { cues: toCues(normalisedWords(item.timed), seed, { panel: true }), sentenceMode: "pause" };
    case "restored": {
      const words = normalisedWords(item.timed);
      const rw = restored?.[item.id];
      if (!rw || rw.length !== words.length) return null;
      return { cues: toCues(words.map((x, i) => ({ w: rw[i], t: x.t })), seed), sentenceMode: "punctuated" };
    }
    default:
      throw new Error(`unknown condition ${condition}`);
  }
}

export const CONDITIONS = ["punct", "raw", "pause", "pause-panel", "restored"];
