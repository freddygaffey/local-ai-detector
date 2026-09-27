// @vitest-environment happy-dom
//
// T10: transcript parsing (saved youtube.com DOM + caption payloads),
// chunking into timed blocks, the timestamp mapping, acquisition helpers
// that don't need a live page, the disclosure label, and the chip labels.

import panelHtml from "./__fixtures__/panel-2026.html?raw";
import disclosureHtml from "./__fixtures__/how-this-was-made.html?raw";
import { describe, expect, test } from "vitest";
import {
  cleanCueText,
  formatTimestamp,
  looksEnglish,
  looksUnpunctuated,
  parseCaptionPayload,
  parseJson3,
  parsePanelSegments,
  parseTimedTextXml,
  parseTimestamp,
  type Cue,
} from "./transcript";
import { buildTranscriptBlocks, resolveSentenceMode, sampleBlocks, skipQuickPass, timeOf, toTextBlocks } from "./chunk";
import { inlineCaptionTracks, loadedCaptionUrls, readDisclosure, readOpenPanel, videoFromUrl } from "./acquire";
import { chipLabel, detailsMeta } from "./ui";
import { toTranscriptProbability, type TranscriptReport } from "../../shared/transcript";

const FIXTURES: Record<string, string> = { "panel-2026.html": panelHtml, "how-this-was-made.html": disclosureHtml };
const fixture = (name: string) => FIXTURES[name]!;

describe("timestamps", () => {
  test("parse", () => {
    expect(parseTimestamp("0:07")).toBe(7);
    expect(parseTimestamp("12:34")).toBe(754);
    expect(parseTimestamp("1:02:03")).toBe(3723);
    expect(parseTimestamp(" 56:09 ")).toBe(3369);
    expect(parseTimestamp("7 seconds")).toBeNull();
    expect(parseTimestamp("1:75")).toBeNull();
  });
  test("format", () => {
    expect(formatTimestamp(7)).toBe("0:07");
    expect(formatTimestamp(754.9)).toBe("12:34");
    expect(formatTimestamp(3723)).toBe("1:02:03");
  });
});

describe("transcript panel (saved 2026 markup)", () => {
  test("reads segments, timestamps and text, skipping chapter headers and a11y labels", () => {
    document.body.innerHTML = fixture("panel-2026.html");
    const cues = parsePanelSegments(document);
    expect(cues.map((c) => c.start)).toEqual([1, 7, 16]);
    expect(cues[0]!.text).toMatch(/^All right, so here we are, in front of the elephants/);
    expect(cues[1]!.text).toBe("really really long trunks and that's cool (baaaaaaaaaaahhh!!)");
    expect(cues.some((c) => /seconds?$/.test(c.text))).toBe(false);
    // The fixture panel is expanded, so it also counts as "already open".
    expect(readOpenPanel(document)).toEqual(cues);
  });

  test("legacy ytd-transcript-segment-renderer markup", () => {
    document.body.innerHTML = `
      <ytd-transcript-segment-renderer><div class="segment-timestamp">1:05</div><yt-formatted-string class="segment-text">[Music] hello there</yt-formatted-string></ytd-transcript-segment-renderer>
      <ytd-transcript-segment-renderer><div class="segment-timestamp">0:59</div><yt-formatted-string class="segment-text">&gt;&gt; first</yt-formatted-string></ytd-transcript-segment-renderer>
      <ytd-transcript-segment-renderer><div class="segment-timestamp">1:10</div><yt-formatted-string class="segment-text">[Applause]</yt-formatted-string></ytd-transcript-segment-renderer>`;
    expect(parsePanelSegments(document)).toEqual([
      { start: 59, text: "first" },
      { start: 65, text: "hello there" },
    ]);
  });
});

describe("caption payloads", () => {
  test("json3, skipping append-only events and sound tags", () => {
    const cues = parseJson3({
      events: [
        { tStartMs: 0, dDurationMs: 5000 },
        { tStartMs: 1200, dDurationMs: 2400, segs: [{ utf8: "so today" }, { utf8: " we're" }] },
        { tStartMs: 3600, aAppend: 1, segs: [{ utf8: "\n" }] },
        { tStartMs: 3600, dDurationMs: 1000, segs: [{ utf8: "[Music]" }] },
        { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: "talking about bees" }] },
      ],
    });
    expect(cues).toEqual([
      { start: 1.2, dur: 2.4, text: "so today we're" },
      { start: 4, dur: 2, text: "talking about bees" },
    ]);
  });
  test("srv1 and srv3 XML, with entities", () => {
    expect(parseTimedTextXml('<transcript><text start="1.5" dur="2">it&amp;#39;s here</text><text start="4" dur="1">A &amp;amp; B</text></transcript>')).toEqual([
      { start: 1.5, dur: 2, text: "it's here" },
      { start: 4, dur: 1, text: "A & B" },
    ]);
    expect(parseTimedTextXml('<timedtext><body><p t="1000" d="500">one <s>two</s></p><p t="2000" d="700">three</p></body></timedtext>')).toEqual([
      { start: 1, dur: 0.5, text: "one two" },
      { start: 2, dur: 0.7, text: "three" },
    ]);
  });
  test("format sniffing; empty body (the player got nothing) is no cues", () => {
    expect(parseCaptionPayload("")).toEqual([]);
    expect(parseCaptionPayload('{"events":[{"tStartMs":0,"dDurationMs":1,"segs":[{"utf8":"hi"}]}]}')).toHaveLength(1);
    expect(parseCaptionPayload("not captions")).toEqual([]);
  });
  test("cleanCueText", () => {
    expect(cleanCueText(">> SPEAKER: [Music] ♪ la la ♪ (applause) okay")).toBe("SPEAKER: la la okay");
    expect(cleanCueText("we (the team) agree")).toBe("we (the team) agree");
  });
});

const unpunct = (n: number, gapEvery = 0): Cue[] =>
  Array.from({ length: n }, (_, i) => ({
    start: i * 2 + (gapEvery && i >= gapEvery ? 1.5 * Math.floor(i / gapEvery) : 0),
    dur: 1.8,
    text: "and then we went over to the place where it was",
  }));

describe("heuristics", () => {
  test("unpunctuated vs punctuated", () => {
    expect(looksUnpunctuated(unpunct(10))).toBe(true);
    expect(looksUnpunctuated([{ start: 0, text: "So today, we're going to talk about bees. They matter. Here's why, and how." }, ...unpunct(0)])).toBe(false);
  });
  test("English check", () => {
    expect(looksEnglish("and then we went over to the place where it was and it is what you do for the day")).toBe(true);
    expect(looksEnglish("hoy vamos a hablar de las abejas porque son muy importantes para el planeta y para nosotros también")).toBe(false);
  });
});

describe("chunking", () => {
  test("punctuated: sentences keep their start time; blocks close at ~target words", () => {
    const cues: Cue[] = [];
    for (let i = 0; i < 60; i++) cues.push({ start: i * 3, text: `This is sentence number ${i} of the talk. It` }, { start: i * 3 + 1.5, text: "keeps going for a while." });
    const blocks = buildTranscriptBlocks(cues, { targetWords: 60 });
    expect(resolveSentenceMode(cues)).toBe("punctuated");
    expect(blocks.length).toBeGreaterThan(3);
    for (const b of blocks) {
      expect(b.sentences.length).toBe(b.times.length);
      for (const [i, sp] of b.sentences.entries()) expect(b.text.slice(sp.start, sp.end).trim()).toBe(b.text.slice(sp.start, sp.end));
      expect(b.start).toBe(b.times[0]);
      expect(b.end).toBeGreaterThan(b.start);
    }
    // "It keeps going for a while." spans two cues and starts in the first.
    const b0 = blocks[0]!;
    const idx = b0.sentences.findIndex((sp) => b0.text.slice(sp.start, sp.end).startsWith("It keeps"));
    expect(b0.times[idx]).toBe(0);
    expect(timeOf(blocks, blocks[1]!.id, 0)).toBe(blocks[1]!.start);
    expect(timeOf(blocks, "nope")).toBeNull();
    // Wire form drops the timing.
    expect(Object.keys(toTextBlocks(blocks)[0]!).sort()).toEqual(["id", "sentences", "text"]);
  });

  test("pause mode: pseudo-sentences at pauses, capitalised, with a full stop", () => {
    const cues = unpunct(30, 4);
    expect(resolveSentenceMode(cues)).toBe("raw");
    const blocks = buildTranscriptBlocks(cues, { sentenceMode: "pause" });
    const first = blocks[0]!;
    const s0 = first.text.slice(first.sentences[0]!.start, first.sentences[0]!.end);
    expect(s0).toMatch(/^And then .*\.$/);
    // a pause every 4 cues (11 words each) -> 28-word cap or pause, whichever first
    expect(s0.split(" ").length).toBeLessThanOrEqual(28);
    expect(first.times[1]).toBeGreaterThan(first.times[0]!);
  });

  test("raw mode: one caption line per unit; a short tail folds into the last block", () => {
    const cues = unpunct(17);
    const blocks = buildTranscriptBlocks(cues, { sentenceMode: "raw", targetWords: 160 });
    expect(blocks.map((b) => b.sentences.length).reduce((a, b) => a + b)).toBe(17);
    expect(blocks.at(-1)!.words).toBeGreaterThanOrEqual(40);
    expect(blocks.map((b) => b.id)).toEqual(blocks.map((_, i) => `yt-${i}`));
  });

  test("panel cues (no durations) still get increasing times and a sensible end", () => {
    const cues = Array.from({ length: 40 }, (_, i) => ({ start: i * 4, text: "we talked about it for a bit and moved on" }));
    const blocks = buildTranscriptBlocks(cues);
    expect(blocks[0]!.end).toBeLessThanOrEqual(blocks[1]!.start + 4);
  });

  test("Quick tier skips unpunctuated *auto* captions only (fresh-install bug: manual captions must still score)", () => {
    const raw = unpunct(30, 4);
    const punctuated = [{ start: 0, text: "So today, we're going to talk about bees. They matter. Here's why, and how." }, ...unpunct(0)];
    expect(resolveSentenceMode(raw)).toBe("raw");
    expect(resolveSentenceMode(punctuated)).toBe("punctuated");
    // The lite model's measured weakness is on ASR output specifically.
    expect(skipQuickPass(true, raw)).toBe(true);
    // A manual/uploaded transcript that happens to read unpunctuated (rare) isn't ASR: still scored.
    expect(skipQuickPass(false, raw)).toBe(false);
    expect(skipQuickPass(undefined, raw)).toBe(false);
    // Punctuated text is never skipped either way.
    expect(skipQuickPass(true, punctuated)).toBe(false);
    expect(skipQuickPass(false, punctuated)).toBe(false);
  });

  test("sampling a long transcript keeps evenly spaced blocks in order", () => {
    const blocks = Array.from({ length: 50 }, (_, i) => ({ id: `b${i}`, words: 100 }));
    expect(sampleBlocks(blocks, 10_000)).toHaveLength(50);
    const s = sampleBlocks(blocks, 1000);
    expect(s).toHaveLength(10);
    expect(s[0]!.id).toBe("b2");
    expect(s.at(-1)!.id).toBe("b47");
  });
});

describe("acquisition helpers", () => {
  test("video from URL", () => {
    expect(videoFromUrl("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=3")).toEqual({ videoId: "jNQXAC9IVRw", kind: "watch" });
    expect(videoFromUrl("https://www.youtube.com/shorts/16dBNFA0Avs")).toEqual({ videoId: "16dBNFA0Avs", kind: "shorts" });
    expect(videoFromUrl("https://m.youtube.com/watch?v=abcdefghijk")?.kind).toBe("watch");
    expect(videoFromUrl("https://www.youtube.com/")).toBeNull();
    expect(videoFromUrl("https://music.youtube.com/watch?v=abcdefghijk")).toBeNull();
    expect(videoFromUrl("https://example.com/watch?v=abcdefghijk")).toBeNull();
  });

  test("inline caption tracks only for the video they describe", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<script type="text/plain">var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=AAA","name":{"simpleText":"English (auto-generated)"},"languageCode":"en","kind":"asr"}],"audioTracks":[]}},"videoDetails":{"videoId":"AAAAAAAAAAA"}};</script>`;
    expect(inlineCaptionTracks(document, "AAAAAAAAAAA")).toEqual([{ languageCode: "en", kind: "asr", name: "English (auto-generated)" }]);
    expect(inlineCaptionTracks(document, "BBBBBBBBBBB")).toBeNull();
    document.body.innerHTML = `<script type="text/plain">var ytInitialPlayerResponse = {"playabilityStatus":{},"videoDetails":{"videoId":"CCCCCCCCCCC"}};</script>`;
    expect(inlineCaptionTracks(document, "CCCCCCCCCCC")).toEqual([]);
  });

  test("caption URLs the player already loaded, for this video only, newest first", () => {
    const perf = {
      getEntriesByType: () =>
        [
          "https://www.youtube.com/api/timedtext?v=AAA&lang=en&fmt=json3&pot=x",
          "https://www.youtube.com/api/timedtext?v=BBB&lang=en",
          "https://evil.example/api/timedtext?v=AAA",
          "https://www.youtube.com/api/timedtext?v=AAA&lang=en&kind=asr",
          "https://i.ytimg.com/vi/AAA/hq.jpg",
        ].map((name) => ({ name })) as unknown as PerformanceEntryList,
    };
    expect(loadedCaptionUrls("AAA", perf)).toEqual([
      "https://www.youtube.com/api/timedtext?v=AAA&lang=en&kind=asr",
      "https://www.youtube.com/api/timedtext?v=AAA&lang=en&fmt=json3&pot=x",
    ]);
  });

  test("YouTube's disclosure label (saved markup); auto-dub notes ignored", () => {
    document.body.innerHTML = fixture("how-this-was-made.html");
    expect(readDisclosure(document)).toBe("Made with AI");
    document.body.innerHTML = `<how-this-was-made-section-view-model><div class="ytwHowThisWasMadeSectionViewModelBodyHeader"><span>Auto-dubbed</span></div><div class="ytwHowThisWasMadeSectionViewModelBodyText"><span>Audio tracks for some languages were automatically generated.</span></div></how-this-was-made-section-view-model>`;
    expect(readDisclosure(document)).toBeNull();
    document.body.innerHTML = `<ytd-watch-metadata><div><span>Altered or synthetic content</span></div></ytd-watch-metadata>`;
    expect(readDisclosure(document)).toBe("Altered or synthetic content");
  });
});

describe("display", () => {
  const base: TranscriptReport = { videoId: "x", state: "done", pass: "full", probability: 0.843, segments: [], disclosure: null };
  test("chip labels", () => {
    expect(chipLabel(base).text).toBe("Transcript: AI 84%");
    expect(chipLabel({ ...base, probability: undefined }).text).toBe("Transcript: —");
    expect(chipLabel({ ...base, state: "none" }).text).toBe("No transcript");
    expect(chipLabel({ ...base, state: "not-english" }).text).toBe("Transcript: English only");
    expect(chipLabel(null).text).toBe("Transcript");
  });
  test("details line", () => {
    expect(detailsMeta({ ...base, source: "panel", autoGenerated: true, analysedWords: 2800, totalWords: 9000 })).toMatch(/^Transcript panel · auto-captions · 2800 of 9000 words analysed · full check/);
  });
  test("transcript probability: '—' below the word minimum, monotone, in range", () => {
    expect(toTranscriptProbability(0.9, { words: 10 })).toBeUndefined();
    const lo = toTranscriptProbability(0.05, { words: 400 });
    const hi = toTranscriptProbability(0.95, { words: 400 });
    if (lo !== undefined && hi !== undefined) {
      expect(hi).toBeGreaterThanOrEqual(lo);
      expect(hi).toBeLessThanOrEqual(0.99);
      expect(lo).toBeGreaterThanOrEqual(0.01);
    }
  });
});

describe("parseSubtitleText", () => {
  test("SRT", async () => {
    const { parseSubtitleText } = await import("./transcript");
    const cues = parseSubtitleText("1\n00:00:01,000 --> 00:00:04,000\n<i>Hello</i> there.\n\n2\n00:01:05,500 --> 00:01:07,000\nGeneral Kenobi.\nYou are a bold one.\n");
    expect(cues).toEqual([
      { start: 1, dur: 3, text: "Hello there." },
      { start: 65.5, dur: 1.5, text: "General Kenobi. You are a bold one." },
    ]);
  });
  test("WebVTT with header, settings and a note", async () => {
    const { parseSubtitleText } = await import("./transcript");
    const cues = parseSubtitleText("WEBVTT\n\nNOTE made by hand\n\n00:02.000 --> 00:04.500 align:start\nFirst line\n\nintro\n01:00:00.000 --> 01:00:02.000\nLate line\n");
    expect(cues.map((c) => [c.start, c.text])).toEqual([
      [2, "First line"],
      [3600, "Late line"],
    ]);
  });
  test("timestamped transcript lines", async () => {
    const { parseSubtitleText } = await import("./transcript");
    const cues = parseSubtitleText("0:00 Welcome back everyone\n[1:02] Today we talk about bread\nnot a cue\n");
    expect(cues.map((c) => [c.start, c.text])).toEqual([
      [0, "Welcome back everyone"],
      [62, "Today we talk about bread"],
    ]);
  });
});

describe("ads", () => {
  test("waits for an ad to finish before reading captions", async () => {
    const { adShowing, waitForAdEnd } = await import("./acquire");
    const doc = document.implementation.createHTMLDocument("");
    doc.body.innerHTML = '<div id="movie_player" class="html5-video-player ad-showing"></div>';
    expect(adShowing(doc)).toBe(true);
    setTimeout(() => doc.getElementById("movie_player")!.classList.remove("ad-showing"), 30);
    const t0 = Date.now();
    await waitForAdEnd(doc, 2000, 10);
    expect(adShowing(doc)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
