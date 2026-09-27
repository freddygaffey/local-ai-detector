import { describe, expect, test } from "vitest";
import { derivePopupState, isUnsupportedUrl, progressLabel, progressPercent } from "./state";

describe("isUnsupportedUrl", () => {
  test("browser-internal pages", () => {
    expect(isUnsupportedUrl("chrome://extensions")).toBe(true);
    expect(isUnsupportedUrl("about:preferences")).toBe(true);
    expect(isUnsupportedUrl("edge://settings")).toBe(true);
    expect(isUnsupportedUrl("moz-extension://abc/options.html")).toBe(true);
  });
  test("store pages", () => {
    expect(isUnsupportedUrl("https://chromewebstore.google.com/detail/x")).toBe(true);
    expect(isUnsupportedUrl("https://addons.mozilla.org/en-US/firefox/addon/x")).toBe(true);
  });
  test("pdf viewer", () => {
    expect(isUnsupportedUrl("https://example.com/paper.pdf")).toBe(true);
    expect(isUnsupportedUrl("https://example.com/paper.pdf?x=1")).toBe(true);
    expect(isUnsupportedUrl("file:///Users/me/paper.pdf")).toBe(true);
  });
  test("ordinary pages are supported", () => {
    expect(isUnsupportedUrl("https://example.com/article")).toBe(false);
    expect(isUnsupportedUrl("http://localhost:3000/")).toBe(false);
  });
  test("missing or unparsable url is unsupported", () => {
    expect(isUnsupportedUrl(null)).toBe(true);
    expect(isUnsupportedUrl(undefined)).toBe(true);
    expect(isUnsupportedUrl("not a url")).toBe(true);
  });
});

describe("derivePopupState", () => {
  const base = { consentedDownload: true, tabUrl: "https://example.com", progress: null, result: null, error: null };

  test("no consent yet", () => {
    expect(derivePopupState({ ...base, consentedDownload: false })).toBe("consent");
  });
  test("unsupported page wins over consent state once consented", () => {
    expect(derivePopupState({ ...base, tabUrl: "chrome://extensions" })).toBe("unsupported");
  });
  test("error state", () => {
    expect(derivePopupState({ ...base, error: "boom" })).toBe("error");
  });
  test("progress phases map to downloading/loading/analyzing", () => {
    expect(derivePopupState({ ...base, progress: { phase: "download", loaded: 1, total: 2, message: "" } })).toBe(
      "downloading",
    );
    expect(derivePopupState({ ...base, progress: { phase: "load", loaded: 1, total: 2, message: "" } })).toBe(
      "loading",
    );
    expect(derivePopupState({ ...base, progress: { phase: "analyze", loaded: 1, total: 2, message: "" } })).toBe(
      "analyzing",
    );
  });
  test("done once a result exists and nothing is in flight", () => {
    expect(
      derivePopupState({ ...base, result: { overall: 0.5, sentences: [], unicode: { findings: [], totalSuspicious: 0, score: 0, hiddenMessage: null }, notes: [] } }),
    ).toBe("done");
  });
  test("idle otherwise", () => {
    expect(derivePopupState(base)).toBe("idle");
  });
});

describe("progressLabel / progressPercent", () => {
  test("labels each phase", () => {
    expect(progressLabel({ phase: "download", loaded: 0, total: 0, message: "" })).toBe("Downloading model");
    expect(progressLabel({ phase: "load", loaded: 0, total: 0, message: "" })).toBe("Loading model");
    expect(progressLabel({ phase: "analyze", loaded: 0, total: 0, message: "" })).toBe("Analyzing");
  });
  test("percent is null when total is unknown, else clamped 0-100", () => {
    expect(progressPercent({ phase: "download", loaded: 5, total: 0, message: "" })).toBeNull();
    expect(progressPercent({ phase: "download", loaded: 50, total: 200, message: "" })).toBe(25);
    expect(progressPercent({ phase: "download", loaded: 999, total: 200, message: "" })).toBe(100);
  });
});
