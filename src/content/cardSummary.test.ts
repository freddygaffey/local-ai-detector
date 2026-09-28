import { describe, expect, test } from "vitest";
import { collapsedSummary, hoverLines, markers, type CardState } from "./cardSummary";
import type { ImageProvenanceSummary } from "../shared/messages";

const texts = (s: CardState) => collapsedSummary(s).lines.map((l) => l.text);
const noImages: ImageProvenanceSummary = {
  total: 3,
  checked: 3,
  withCredentials: 0,
  trustedCredentials: 0,
  aiSignals: 0,
  withUnsignedClaim: 0,
  withWatermark: 0,
  permissionNeeded: [],
};

describe("collapsedSummary per page type", () => {
  test("article: a single AI % coloured by that score", () => {
    const sum = collapsedSummary({ pageType: "article", article: { probability: 0.12, flagged: 0, sentences: 20 } });
    expect(sum.lines.map((l) => l.text)).toEqual(["AI 12%"]);
    expect(sum.worst).toBeCloseTo(0.12);
    expect(sum.idle).toBe(false);
    expect(sum.hidden).toBe(false);
  });

  test("article: too short shows a dash, before a result an ellipsis", () => {
    expect(texts({ pageType: "article", article: { probability: null, flagged: 0, sentences: 2 } })).toEqual(["AI —"]);
    expect(texts({ pageType: "article", running: true })).toEqual(["AI …"]);
    expect(collapsedSummary({ pageType: "article", running: true }).running).toBe(true);
  });

  test("thread: a count of AI items (including 0) over the scored total", () => {
    expect(texts({ pageType: "thread", thread: { flagged: 3, total: 24, maxProbability: 0.9 } })).toEqual(["3 AI", "of 24"]);
    expect(texts({ pageType: "thread", thread: { flagged: 0, total: 12, maxProbability: 0.2 } })).toEqual(["0 AI", "of 12"]);
    expect(collapsedSummary({ pageType: "thread", thread: { flagged: 3, total: 24, maxProbability: 0.9 } }).worst).toBe(0.9);
  });

  test("an article with a comment section counts the comments", () => {
    expect(texts({ pageType: "article", thread: { flagged: 1, total: 5 } })).toEqual(["1 AI", "of 5"]);
  });

  test("video: Script and Voice stacked, coloured by the worse", () => {
    const sum = collapsedSummary({ pageType: "video", video: { transcript: 0.23, transcriptState: "done", voice: 0.01, voiceClips: 4 } });
    expect(sum.lines.map((l) => l.text)).toEqual(["Script 23%", "Voice 1%"]);
    expect(sum.worst).toBeCloseTo(0.23);
  });

  test("video: states before scores", () => {
    expect(texts({ pageType: "video", video: { transcriptState: "running", voice: null } })).toEqual(["Script …", "Voice …"]);
    expect(texts({ pageType: "video", video: { transcriptState: "none" } })).toEqual(["Script —"]);
    expect(texts({ pageType: "video", video: {} })).toEqual(["Script —"]);
  });

  test("search: marked snippets over snippets scored", () => {
    expect(texts({ pageType: "search", search: { flagged: 2, total: 10, maxProbability: 0.8 } })).toEqual(["2 AI", "of 10"]);
    expect(texts({ pageType: "search" })).toEqual(["AI"]);
    expect(texts({ pageType: "search", running: true })).toEqual(["AI …"]);
  });

  test("app: an idle glyph; off: nothing at all", () => {
    const app = collapsedSummary({ pageType: "app" });
    expect(app.idle).toBe(true);
    expect(app.lines).toEqual([]);
    expect(collapsedSummary({ pageType: "article", off: true }).hidden).toBe(true);
  });

  test("an error with no score shows a cross", () => {
    expect(texts({ pageType: "article", error: "No readable text" })).toEqual(["AI ✕"]);
  });

  test("aria-label reads the summary and asks for a press", () => {
    const sum = collapsedSummary({ pageType: "video", video: { transcript: 0.5, voice: 0.1 } });
    expect(sum.ariaLabel).toMatch(/^AI detection: Script 50% Voice 10%.*Press for details\.$/);
  });
});

describe("markers", () => {
  test("only what is present", () => {
    expect(markers({ pageType: "article", images: noImages })).toEqual([]);
    const codes = markers({
      pageType: "article",
      images: { ...noImages, withCredentials: 1, withWatermark: 2, withUnsignedClaim: 1 },
      hidden: { count: 5, message: true },
    }).map((m) => m.code);
    expect(codes).toEqual(["CR", "WM", "AI", "U+"]);
  });

  test("image checks switched off show nothing; a platform AI label shows", () => {
    expect(markers({ pageType: "article", images: { ...noImages, withCredentials: 2, disabled: true } })).toEqual([]);
    expect(markers({ pageType: "video", video: { disclosure: "Altered or synthetic content" } }).map((m) => m.code)).toEqual(["YT"]);
  });
});

describe("hoverLines", () => {
  test("article: verdict, agreement, tier and device, page type and why", () => {
    const lines = hoverLines({
      pageType: "article",
      pageReason: "JSON-LD Article",
      article: { probability: 0.91, flagged: 7, sentences: 20, band: "ai" },
      meta: { tier: "quick", confirmed: true, device: "webgpu", agreement: { agree: 2, total: 2, disagree: false } },
    });
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l.value]));
    expect(byLabel.Text).toBe("91% AI");
    expect(byLabel.Sentences).toBe("7/20 flagged");
    expect(byLabel.Detectors).toBe("2/2 agree");
    expect(byLabel.Check).toBe("Quick, confirmed on WebGPU");
    expect(byLabel.Page).toBe("Article (JSON-LD Article)");
  });

  test("video: both signals with their states", () => {
    const lines = hoverLines({ pageType: "video", pageReason: "YouTube", video: { transcriptState: "none", voice: null, voiceClips: 2 } });
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l.value]));
    expect(byLabel.Script).toBe("no captions");
    expect(byLabel.Voice).toBe("sampling (2 clips)");
  });

  test("thread and search show counts; Deep is named", () => {
    const t = hoverLines({ pageType: "thread", thread: { flagged: 3, total: 24 }, meta: { tier: "deep", device: "mixed" } });
    expect(t.find((l) => l.label === "Comments")?.value).toBe("3/24 AI");
    expect(t.find((l) => l.label === "Check")?.value).toBe("Deep on WebGPU + CPU");
    expect(hoverLines({ pageType: "search", search: { flagged: 1, total: 8 } }).find((l) => l.label === "Snippets")?.value).toBe("1/8 AI");
  });
});
