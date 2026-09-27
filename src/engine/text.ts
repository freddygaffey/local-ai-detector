// Pure text bookkeeping for the engine: flattening TextBlocks into one
// document, splitting it into per-sentence "pieces" that tokenize to exactly
// the same ids as the whole text would, grouping sentences into scoring
// units of >= minWords words, packing units into model-sized chunks, and
// applying the maxTokens cap. No model or browser APIs in here, so it's all
// unit-testable.

import type { TextBlock } from "../shared/messages";

/** Separator placed between blocks when they are joined into one document. */
export const BLOCK_SEPARATOR = "\n\n";

export interface DocSentence {
  blockId: string;
  /** Index of the sentence within its block (as sent by the content script). */
  index: number;
  /** Offsets into Doc.text. */
  start: number;
  end: number;
  words: number;
}

export interface Doc {
  text: string;
  sentences: DocSentence[];
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;

export function countWords(text: string): number {
  const m = text.match(WORD_RE);
  return m ? m.length : 0;
}

/**
 * Joins blocks into a single document (separated by a blank line, which
 * gives the LM paragraph context across blocks) and re-bases each sentence
 * range onto it. Invalid or empty ranges are dropped; a block with no
 * sentence ranges is treated as one sentence. Overlapping/unsorted ranges are
 * sorted and clipped so pieces never overlap.
 */
export function buildDoc(blocks: TextBlock[]): Doc {
  let text = "";
  const sentences: DocSentence[] = [];
  for (const block of blocks) {
    if (!block || typeof block.text !== "string" || block.text.length === 0) continue;
    if (text.length > 0) text += BLOCK_SEPARATOR;
    const base = text.length;
    text += block.text;
    const len = block.text.length;
    const ranges =
      block.sentences && block.sentences.length > 0
        ? block.sentences.map((r, index) => ({ ...r, index }))
        : [{ start: 0, end: len, index: 0 }];
    const sorted = ranges
      .map((r) => ({
        index: r.index,
        start: Math.max(0, Math.min(len, Math.floor(Number(r.start) || 0))),
        end: Math.max(0, Math.min(len, Math.floor(Number(r.end) || 0))),
      }))
      .filter((r) => r.end > r.start)
      .sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const r of sorted) {
      const start = Math.max(r.start, cursor);
      if (r.end <= start) continue;
      const slice = block.text.slice(start, r.end);
      if (slice.trim().length === 0) continue;
      sentences.push({
        blockId: block.id,
        index: r.index,
        start: base + start,
        end: base + r.end,
        words: countWords(slice),
      });
      cursor = r.end;
    }
  }
  return { text, sentences };
}

/**
 * Piece i = the text between the end of sentence i-1 (or the start of the
 * document) and the end of sentence i. Pieces therefore start with the
 * whitespace that precedes a sentence, which is exactly how byte-level BPE
 * (GPT-2, RoBERTa, SmolLM2) and WordPiece pre-tokenizers split text, so
 * concatenating the per-piece token ids reproduces the whole-text
 * tokenization (up to rare merges across a sentence boundary) and gives us an
 * exact token -> sentence map without needing offset mappings.
 */
export function sentencePieces(doc: Doc): string[] {
  const pieces: string[] = [];
  let prev = 0;
  for (const s of doc.sentences) {
    pieces.push(doc.text.slice(prev, s.end));
    prev = s.end;
  }
  return pieces;
}

/**
 * How many leading sentences fit within `maxTokens`, given each sentence's
 * token count. At least one sentence is always kept (it will be truncated by
 * the model if needed).
 */
export function capSentences(tokenCounts: number[], maxTokens: number): number {
  if (tokenCounts.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < tokenCounts.length; i++) {
    total += tokenCounts[i];
    if (total > maxTokens) return Math.max(1, i);
  }
  return tokenCounts.length;
}

/** A run of consecutive sentences (inclusive indices into Doc.sentences). */
export interface Span {
  first: number;
  last: number;
}

/**
 * Groups consecutive sentences into scoring units of at least `minWords`
 * words, so short sentences never get a standalone verdict: they are folded
 * into their neighbours. A trailing remainder shorter than `minWords` is
 * merged into the previous unit. If the whole text is shorter than
 * `minWords`, it becomes a single (low-confidence) unit.
 */
export function buildUnits(words: number[], minWords: number): Span[] {
  const n = words.length;
  if (n === 0) return [];
  const min = Math.max(1, minWords);
  const units: Span[] = [];
  let first = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += words[i];
    if (acc >= min) {
      units.push({ first, last: i });
      first = i + 1;
      acc = 0;
    }
  }
  if (first < n) {
    if (units.length > 0) units[units.length - 1].last = n - 1;
    else units.push({ first, last: n - 1 });
  }
  return units;
}

/**
 * Packs consecutive units into chunks of at most `maxTokens` tokens (sum of
 * sentence token counts), never splitting a unit unless the unit alone is too
 * long, in which case it is split on sentence boundaries. A single sentence
 * longer than `maxTokens` becomes its own chunk (the tokenizer truncates it).
 *
 * `targetTokens` (<= maxTokens) lets callers prefer smaller chunks for finer
 * highlighting: a chunk is closed once it reaches the target.
 */
export function packChunks(
  units: Span[],
  tokenCounts: number[],
  maxTokens: number,
  targetTokens: number = maxTokens,
): Span[] {
  const target = Math.min(targetTokens, maxTokens);
  const chunks: Span[] = [];
  const tokensOf = (s: Span) => {
    let t = 0;
    for (let i = s.first; i <= s.last; i++) t += tokenCounts[i] ?? 0;
    return t;
  };
  let cur: Span | null = null;
  let curTokens = 0;
  const flush = () => {
    if (cur) chunks.push(cur);
    cur = null;
    curTokens = 0;
  };
  for (const unit of units) {
    const ut = tokensOf(unit);
    if (ut > maxTokens) {
      // Split this unit on sentence boundaries.
      flush();
      let sub: Span | null = null;
      let subTokens = 0;
      for (let i = unit.first; i <= unit.last; i++) {
        const t = tokenCounts[i] ?? 0;
        if (sub && subTokens + t > maxTokens) {
          chunks.push(sub);
          sub = null;
          subTokens = 0;
        }
        if (!sub) sub = { first: i, last: i };
        else sub.last = i;
        subTokens += t;
      }
      if (sub) chunks.push(sub);
      continue;
    }
    if (cur && curTokens + ut > maxTokens) flush();
    if (!cur) {
      cur = { first: unit.first, last: unit.last };
      curTokens = ut;
    } else {
      (cur as Span).last = unit.last;
      curTokens += ut;
    }
    if (curTokens >= target) flush();
  }
  flush();
  return chunks;
}

/** Index of the span containing sentence `i`, for each sentence. */
export function spanIndexBySentence(spans: Span[], sentenceCount: number): Int32Array {
  const out = new Int32Array(sentenceCount).fill(-1);
  spans.forEach((s, k) => {
    for (let i = s.first; i <= s.last && i < sentenceCount; i++) out[i] = k;
  });
  return out;
}

/**
 * Small, fast, non-cryptographic 53-bit string hash (cyrb53), used for the
 * in-memory result cache key.
 */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
