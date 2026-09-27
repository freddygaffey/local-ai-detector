import { describe, expect, test } from "vitest";
import { revealUnicode, scanUnicode, stripUnicode } from "./unicode";

describe("scanUnicode", () => {
  test("clean text scores zero", () => {
    const r = scanUnicode("The quick brown fox jumps over the lazy dog.");
    expect(r.totalSuspicious).toBe(0);
    expect(r.score).toBe(0);
    expect(r.hiddenMessage).toBeNull();
  });

  test("flags zero-width spaces", () => {
    const r = scanUnicode("Hello​world, this​ is text.");
    expect(r.totalSuspicious).toBe(2);
    expect(r.findings[0]!.hex).toBe("U+200B");
    expect(r.findings[0]!.indices).toEqual([5, 17]);
    expect(r.score).toBeGreaterThan(0);
  });

  test("decodes ASCII smuggled in tag characters", () => {
    const secret = [..."hi AI"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    const r = scanUnicode(`Normal sentence.${secret}`);
    expect(r.hiddenMessage).toBe("hi AI");
    expect(r.findings[0]!.category).toBe("tag-character");
    expect(r.score).toBeGreaterThan(0.5);
  });

  test("ignores emoji ZWJ sequences, presentation selectors and keycaps", () => {
    const r = scanUnicode("Family 👨‍👩‍👧 loves ❤️ and 1️⃣");
    expect(r.totalSuspicious).toBe(0);
  });

  test("ignores subdivision flag tag sequences", () => {
    const r = scanUnicode("Scotland 🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} flag");
    expect(r.totalSuspicious).toBe(0);
  });

  test("ignores joiners in Indic/Arabic script and a leading BOM", () => {
    expect(scanUnicode("क्‍ष").totalSuspicious).toBe(0);
    expect(scanUnicode("﻿plain text").totalSuspicious).toBe(0);
  });

  test("NBSP ignored by default, flagged when includeNbsp", () => {
    const t = "a b";
    expect(scanUnicode(t).totalSuspicious).toBe(0);
    expect(scanUnicode(t, { includeNbsp: true }).totalSuspicious).toBe(1);
  });

  test("narrow NBSP allowed before units / French punctuation, flagged mid-word", () => {
    expect(scanUnicode("10 km and Bonjour !").totalSuspicious).toBe(0);
    expect(scanUnicode("some words").totalSuspicious).toBe(1);
  });

  test("flags bidi overrides (Trojan Source style)", () => {
    const r = scanUnicode("access‮ level");
    expect(r.findings[0]!.category).toBe("bidi-control");
  });

  test("single stray char in long text stays low", () => {
    const long = "word ".repeat(2000) + " ";
    expect(scanUnicode(long).score).toBeLessThan(0.1);
  });

  test("reveal and strip", () => {
    const t = "a​b\u{E0041}c";
    const r = scanUnicode(t);
    expect(revealUnicode(t, r)).toBe("a⟦U+200B⟧b⟦U+E0041⟧c");
    expect(stripUnicode(t, r)).toBe("abc");
  });
});
