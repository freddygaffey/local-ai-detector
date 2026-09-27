import { test } from "node:test";
import assert from "node:assert/strict";
import { revealUnicode, scanUnicode, stripUnicode } from "./unicode.ts";

test("clean text scores zero", () => {
  const r = scanUnicode("The quick brown fox jumps over the lazy dog.");
  assert.equal(r.totalSuspicious, 0);
  assert.equal(r.score, 0);
  assert.equal(r.hiddenMessage, null);
});

test("flags zero-width spaces", () => {
  const r = scanUnicode("Hello​world, this​ is text.");
  assert.equal(r.totalSuspicious, 2);
  assert.equal(r.findings[0].hex, "U+200B");
  assert.deepEqual(r.findings[0].indices, [5, 17]);
  assert.ok(r.score > 0);
});

test("decodes ASCII smuggled in tag characters", () => {
  const secret = [..."hi AI"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
  const r = scanUnicode(`Normal sentence.${secret}`);
  assert.equal(r.hiddenMessage, "hi AI");
  assert.equal(r.findings[0].category, "tag-character");
  assert.ok(r.score > 0.5);
});

test("ignores emoji ZWJ sequences, presentation selectors and keycaps", () => {
  const r = scanUnicode("Family 👨‍👩‍👧 loves ❤️ and 1️⃣");
  assert.equal(r.totalSuspicious, 0);
});

test("ignores subdivision flag tag sequences", () => {
  const r = scanUnicode("Scotland 🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} flag");
  assert.equal(r.totalSuspicious, 0);
});

test("ignores joiners in Indic/Arabic script and a leading BOM", () => {
  assert.equal(scanUnicode("क्‍ष").totalSuspicious, 0);
  assert.equal(scanUnicode("﻿plain text").totalSuspicious, 0);
});

test("NBSP ignored by default, flagged when includeNbsp", () => {
  const t = "a b";
  assert.equal(scanUnicode(t).totalSuspicious, 0);
  assert.equal(scanUnicode(t, { includeNbsp: true }).totalSuspicious, 1);
});

test("narrow NBSP allowed before units / French punctuation, flagged mid-word", () => {
  assert.equal(scanUnicode("10 km and Bonjour !").totalSuspicious, 0);
  assert.equal(scanUnicode("some words").totalSuspicious, 1);
});

test("flags bidi overrides (Trojan Source style)", () => {
  const r = scanUnicode("access‮ level");
  assert.equal(r.findings[0].category, "bidi-control");
});

test("single stray char in long text stays low", () => {
  const long = "word ".repeat(2000) + " ";
  assert.ok(scanUnicode(long).score < 0.1);
});

test("reveal and strip", () => {
  const t = "a​b\u{E0041}c";
  const r = scanUnicode(t);
  assert.equal(revealUnicode(t, r), "a⟦U+200B⟧b⟦U+E0041⟧c");
  assert.equal(stripUnicode(t, r), "abc");
});
