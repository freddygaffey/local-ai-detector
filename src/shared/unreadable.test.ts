import { describe, expect, test } from "vitest";
import { classifyProbe, classifyUrl, isUnscriptableError, kindForUrl, parseUnreadable, unreadableError, unreadableMessage } from "./unreadable";

describe("classifyUrl", () => {
  test("PDFs by URL", () => {
    expect(classifyUrl("https://example.com/paper.PDF")).toBe("pdf");
    expect(classifyUrl("https://example.com/paper.pdf?dl=1#page=2")).toBe("pdf");
    expect(classifyUrl("file:///Users/me/paper.pdf")).toBe("pdf");
    expect(classifyUrl("resource://pdf.js/web/viewer.html?file=x")).toBe("pdf");
    expect(classifyUrl("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html")).toBe("pdf");
  });
  test("protected pages", () => {
    for (const u of [
      "chrome://extensions",
      "view-source:https://example.com/",
      "chrome-extension://abcdefghijklmnop/options.html",
      "moz-extension://abc/options.html",
      "about:preferences",
      "https://chromewebstore.google.com/detail/x",
      "https://addons.mozilla.org/en-US/firefox/addon/x",
      "resource://gre/something",
    ])
      expect(classifyUrl(u), u).toBe("restricted");
  });
  test("ordinary pages, and PDFs without .pdf (need a probe)", () => {
    expect(classifyUrl("https://example.com/article")).toBeNull();
    expect(classifyUrl("https://arxiv.org/pdf/2401.12070")).toBeNull();
    expect(classifyUrl("file:///Users/me/notes.html")).toBeNull();
  });
  test("missing or unparsable", () => {
    expect(classifyUrl(null)).toBe("restricted");
    expect(classifyUrl("not a url")).toBe("restricted");
  });
});

describe("errors", () => {
  test("round trip", () => {
    expect(parseUnreadable(unreadableError("pdf"))).toBe("pdf");
    expect(parseUnreadable("Tab message failed: unreadable-page:restricted")).toBe("restricted");
    expect(parseUnreadable(new Error("boom"))).toBeNull();
  });
  test("unscriptable errors from Chrome and Firefox", () => {
    for (const m of [
      "Could not establish connection. Receiving end does not exist.",
      "Cannot access contents of the page. Extension manifest must request permission to access the respective host.",
      'Cannot access contents of url "file:///x.pdf". Extension manifest must request permission to access this host.',
      "The extensions gallery cannot be scripted.",
      "Cannot access a chrome:// URL",
      "Missing host permission for the tab",
      "unreadable-page:pdf",
    ])
      expect(isUnscriptableError(new Error(m)), m).toBe(true);
    expect(isUnscriptableError(new Error("consent-required: download"))).toBe(false);
    expect(isUnscriptableError(new Error("WebGPU device lost"))).toBe(false);
  });
  test("messages are one short line", () => {
    expect(unreadableMessage("pdf")).toMatch(/^PDF/);
    expect(unreadableMessage("restricted")).toBe("Can't read this page.");
  });
});

describe("kindForUrl / classifyProbe", () => {
  test("a failed injection on a /pdf/ path is a PDF", () => {
    expect(kindForUrl("https://arxiv.org/pdf/2401.12070")).toBe("pdf");
    expect(kindForUrl("https://example.com/download?id=3")).toBe("restricted");
    expect(kindForUrl(undefined)).toBe("restricted");
  });
  test("content script says PDF", () => {
    expect(classifyProbe({ url: "https://arxiv.org/pdf/1", pageType: { pdf: true } })).toBe("pdf");
  });
  test("probe reads application/pdf", () => {
    expect(classifyProbe({ url: "https://x.org/get?id=1", contentType: "application/pdf" })).toBe("pdf");
  });
  test("readable page", () => {
    expect(classifyProbe({ url: "https://x.org/", contentType: "text/html" })).toBeNull();
    expect(classifyProbe({ url: "https://x.org/", pageType: { pdf: false } })).toBeNull();
  });
  test("injection refused", () => {
    const e = new Error("Cannot access contents of the page.");
    expect(classifyProbe({ url: "https://x.org/files/report", probeError: e })).toBe("restricted");
    expect(classifyProbe({ url: "https://arxiv.org/pdf/2401.12070", probeError: e })).toBe("pdf");
    expect(classifyProbe({ url: "https://x.org/", probeError: new Error("something else") })).toBeNull();
  });
});
