// Hidden / unusual Unicode scanner.
//
// Flags invisible or atypical characters that sometimes ride along with
// copy-pasted AI output (zero-width chars, odd spaces, bidi controls) and
// characters used for text steganography (Unicode tag chars, variation
// selectors). This is a weak signal, never proof: rich-text editors, CMSs,
// and non-Latin scripts produce many of these legitimately, so each category
// carries a weight and legitimate contexts (emoji sequences, Indic/Arabic
// joiners, a leading BOM) are skipped.

export type UnicodeCategory =
  | "zero-width"
  | "bidi-control"
  | "unusual-space"
  | "soft-hyphen"
  | "tag-character"
  | "variation-selector";

export interface UnicodeFinding {
  category: UnicodeCategory;
  codePoint: number;
  /** e.g. "U+200B" */
  hex: string;
  name: string;
  /** UTF-16 index into the scanned text of each occurrence. */
  indices: number[];
}

export interface UnicodeScanResult {
  findings: UnicodeFinding[];
  totalSuspicious: number;
  /** 0 (nothing notable) to 1 (strong hidden-character signal). */
  score: number;
  /** ASCII text smuggled via Unicode tag characters (U+E0020–U+E007E), if any. */
  hiddenMessage: string | null;
}

export interface UnicodeScanOptions {
  /**
   * Page DOM text is full of legitimate &nbsp; entities, so NBSP is ignored by
   * default. Set true when scanning text the user pasted in directly.
   */
  includeNbsp?: boolean;
}

const NAMES: Record<number, string> = {
  0x200b: "ZERO WIDTH SPACE",
  0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER",
  0x2060: "WORD JOINER",
  0xfeff: "ZERO WIDTH NO-BREAK SPACE (BOM)",
  0x180e: "MONGOLIAN VOWEL SEPARATOR",
  0x200e: "LEFT-TO-RIGHT MARK",
  0x200f: "RIGHT-TO-LEFT MARK",
  0x061c: "ARABIC LETTER MARK",
  0x202a: "LEFT-TO-RIGHT EMBEDDING",
  0x202b: "RIGHT-TO-LEFT EMBEDDING",
  0x202c: "POP DIRECTIONAL FORMATTING",
  0x202d: "LEFT-TO-RIGHT OVERRIDE",
  0x202e: "RIGHT-TO-LEFT OVERRIDE",
  0x2066: "LEFT-TO-RIGHT ISOLATE",
  0x2067: "RIGHT-TO-LEFT ISOLATE",
  0x2068: "FIRST STRONG ISOLATE",
  0x2069: "POP DIRECTIONAL ISOLATE",
  0x00a0: "NO-BREAK SPACE",
  0x202f: "NARROW NO-BREAK SPACE",
  0x2000: "EN QUAD",
  0x2001: "EM QUAD",
  0x2002: "EN SPACE",
  0x2003: "EM SPACE",
  0x2004: "THREE-PER-EM SPACE",
  0x2005: "FOUR-PER-EM SPACE",
  0x2006: "SIX-PER-EM SPACE",
  0x2007: "FIGURE SPACE",
  0x2008: "PUNCTUATION SPACE",
  0x2009: "THIN SPACE",
  0x200a: "HAIR SPACE",
  0x205f: "MEDIUM MATHEMATICAL SPACE",
  0x3000: "IDEOGRAPHIC SPACE",
  0x3164: "HANGUL FILLER",
  0x00ad: "SOFT HYPHEN",
};

// Relative weight of one occurrence of each category towards the score.
const WEIGHTS: Record<UnicodeCategory, number> = {
  "tag-character": 1,
  "variation-selector": 0.6,
  "bidi-control": 0.4,
  "zero-width": 0.35,
  "unusual-space": 0.15,
  "soft-hyphen": 0.1,
};

function categorize(cp: number, includeNbsp: boolean): UnicodeCategory | null {
  if (cp >= 0xe0000 && cp <= 0xe007f) return "tag-character";
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) {
    return "variation-selector";
  }
  switch (cp) {
    case 0x200b: case 0x200c: case 0x200d: case 0x2060: case 0xfeff: case 0x180e:
      return "zero-width";
    case 0x200e: case 0x200f: case 0x061c:
    case 0x202a: case 0x202b: case 0x202c: case 0x202d: case 0x202e:
    case 0x2066: case 0x2067: case 0x2068: case 0x2069:
      return "bidi-control";
    case 0x00ad:
      return "soft-hyphen";
    case 0x00a0:
      return includeNbsp ? "unusual-space" : null;
    case 0x202f: case 0x205f: case 0x3000: case 0x3164:
      return "unusual-space";
  }
  if (cp >= 0x2000 && cp <= 0x200a) return "unusual-space";
  return null;
}

const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}/u;
// Scripts where ZWJ/ZWNJ are part of normal orthography.
const JOINING_SCRIPT =
  /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Mongolian}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function charBefore(text: string, i: number): string {
  if (i <= 0) return "";
  const cp = text.codePointAt(i - 1)!;
  // Step back over a surrogate pair.
  if (i >= 2 && cp >= 0xdc00 && cp <= 0xdfff) return String.fromCodePoint(text.codePointAt(i - 2)!);
  return String.fromCodePoint(cp);
}

function charAfter(text: string, i: number, width: number): string {
  const cp = text.codePointAt(i + width);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

/** True when the character at `i` is being used legitimately in context. */
function isLegitimate(text: string, i: number, cp: number, width: number): boolean {
  const prev = charBefore(text, i);
  const next = charAfter(text, i, width);
  // Leading byte-order mark.
  if (cp === 0xfeff && i === 0) return true;
  // Emoji presentation selectors, skin tones, ZWJ emoji sequences, keycaps.
  if ((cp === 0xfe0f || cp === 0xfe0e || cp === 0x200d) && (EMOJI.test(prev) || EMOJI.test(next))) {
    return true;
  }
  if (cp === 0xfe0f && /[0-9#*]/.test(prev)) return true;
  // Joiners and direction marks inside RTL / complex scripts.
  if (
    (cp === 0x200c || cp === 0x200d || cp === 0x200e || cp === 0x200f || cp === 0x061c) &&
    (JOINING_SCRIPT.test(prev) || JOINING_SCRIPT.test(next))
  ) {
    return true;
  }
  // Ideographic space and Mongolian separator in their own scripts.
  if (cp === 0x3000 && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿]/u.test(prev + next)) {
    return true;
  }
  if (cp === 0x180e && /\p{Script=Mongolian}/u.test(prev + next)) return true;
  // Tag characters that follow a black-flag emoji form subdivision flags (🏴󠁧󠁢󠁳󠁣󠁴󠁿).
  if (cp >= 0xe0000 && cp <= 0xe007f && isInFlagTagSequence(text, i)) return true;
  // Narrow no-break space is standard before units / in French punctuation.
  if (cp === 0x202f && (/[0-9]/.test(prev) || /[:;!?»%]/.test(next) || prev === "«")) return true;
  return false;
}

function isInFlagTagSequence(text: string, i: number): boolean {
  let j = i;
  while (j >= 2) {
    const cp = text.codePointAt(j - 2)!;
    if (cp >= 0xe0000 && cp <= 0xe007f) { j -= 2; continue; }
    return text.codePointAt(j - 2) === 0x1f3f4; // 🏴 WAVING BLACK FLAG
  }
  return false;
}

function hex(cp: number): string {
  return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
}

function nameOf(cp: number, category: UnicodeCategory): string {
  if (NAMES[cp]) return NAMES[cp];
  if (category === "tag-character") {
    const ascii = cp - 0xe0000;
    return ascii >= 0x20 && ascii <= 0x7e ? `TAG ${JSON.stringify(String.fromCharCode(ascii))}` : "TAG CHARACTER";
  }
  if (category === "variation-selector") {
    const n = cp <= 0xfe0f ? cp - 0xfe00 + 1 : cp - 0xe0100 + 17;
    return `VARIATION SELECTOR-${n}`;
  }
  return "UNKNOWN";
}

export function scanUnicode(text: string, options: UnicodeScanOptions = {}): UnicodeScanResult {
  const includeNbsp = options.includeNbsp ?? false;
  const byCodePoint = new Map<number, UnicodeFinding>();
  let hidden = "";
  let weighted = 0;
  let total = 0;

  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    const category = categorize(cp, includeNbsp);
    if (category && !isLegitimate(text, i, cp, width)) {
      let f = byCodePoint.get(cp);
      if (!f) {
        f = { category, codePoint: cp, hex: hex(cp), name: nameOf(cp, category), indices: [] };
        byCodePoint.set(cp, f);
      }
      f.indices.push(i);
      total++;
      weighted += WEIGHTS[category];
      if (category === "tag-character" && cp >= 0xe0020 && cp <= 0xe007e) {
        hidden += String.fromCharCode(cp - 0xe0000);
      }
    }
    i += width;
  }

  // Saturating score: a handful of weighted hits approaches 1, normalised a
  // little by length so a single stray char in a long article stays low.
  const words = Math.max(1, text.split(/\s+/).filter(Boolean).length);
  const density = weighted / Math.sqrt(words / 50 + 1);
  const score = total === 0 ? 0 : 1 - Math.exp(-density / 2);

  const findings = [...byCodePoint.values()].sort(
    (a, b) => WEIGHTS[b.category] - WEIGHTS[a.category] || b.indices.length - a.indices.length,
  );
  return {
    findings,
    totalSuspicious: total,
    score: Math.round(score * 1000) / 1000,
    hiddenMessage: hidden || null,
  };
}

/**
 * Returns text with suspicious characters replaced by visible markers such as
 * "⟦U+200B⟧", for showing the user exactly where they are.
 */
export function revealUnicode(text: string, result: UnicodeScanResult): string {
  const at = new Map<number, UnicodeFinding>();
  for (const f of result.findings) for (const i of f.indices) at.set(i, f);
  let out = "";
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    const f = at.get(i);
    out += f ? `⟦${f.hex}⟧` : text.slice(i, i + width);
    i += width;
  }
  return out;
}

/** Removes every flagged character, e.g. for a "clean this text" button. */
export function stripUnicode(text: string, result: UnicodeScanResult): string {
  const drop = new Set<number>();
  for (const f of result.findings) for (const i of f.indices) drop.add(i);
  let out = "";
  for (let i = 0; i < text.length; ) {
    const width = text.codePointAt(i)! > 0xffff ? 2 : 1;
    if (!drop.has(i)) out += text.slice(i, i + width);
    i += width;
  }
  return out;
}
