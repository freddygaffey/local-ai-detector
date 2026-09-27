// @vitest-environment happy-dom
//
// DOM tests for extraction, selection, highlight rendering and hidden-
// Unicode markers, in happy-dom. happy-dom has no CSS Custom Highlight API,
// so highlightStyles.ts takes its <mark> fallback path here; the Highlight
// API path is covered by the Chrome E2E suite (scripts/e2e/chrome.mjs).

import { afterEach, describe, expect, it } from "vitest";
import { extractVisibleBlocks, getRangeForOffsets, isBlockStale } from "./extract";
import { clearHighlights, renderHighlights } from "./highlightStyles";
import { extractSelectionBlock } from "./selection";
import { clearUnicodeMarkers, groupRuns, renderUnicodeMarkers } from "./unicodeMarkers";
import { scanUnicode } from "../detectors/unicode";
import type { ActiveSentence } from "./types";

afterEach(() => {
  clearHighlights();
  clearUnicodeMarkers();
  document.body.innerHTML = "";
  getSelection()?.removeAllRanges();
});

const LONG =
  "The committee met on Tuesday to review the budget. Several members raised concerns about the timeline. " +
  "A final vote is expected next month.";

describe("extractVisibleBlocks", () => {
  it("reads the article, skipping nav/aside/footer/script/hidden/aria-hidden and contenteditable", () => {
    document.body.innerHTML = `
      <nav>Home About Contact</nav>
      <article>
        <h1>Budget review</h1>
        <p>${LONG}</p>
        <p hidden>Hidden paragraph that must not be read.</p>
        <p style="display:none">Display-none paragraph.</p>
        <p aria-hidden="true">Aria-hidden paragraph.</p>
        <aside>Subscribe to our newsletter!</aside>
        <div contenteditable="true">Draft the user is typing.</div>
        <script>var x = "script text";</script>
        <p>Second   paragraph,\n\t with   odd   whitespace. It has two sentences.</p>
      </article>
      <footer>Copyright</footer>`;
    const blocks = extractVisibleBlocks(document);
    const texts = blocks.map((b) => b.text);
    expect(texts).toEqual([
      "Budget review",
      LONG,
      "Second paragraph, with odd whitespace. It has two sentences.",
    ]);
    const joined = texts.join(" ");
    for (const bad of ["Home", "Hidden", "Display-none", "Aria-hidden", "Subscribe", "Draft", "script text", "Copyright"]) {
      expect(joined).not.toContain(bad);
    }
    expect(blocks[1]!.sentences).toHaveLength(3);
  });

  it("maps sentence offsets back to exact DOM ranges across inline elements", () => {
    document.body.innerHTML = `<main><p>First <b>bold</b> sentence here. Second <a href="#">linked</a> one.</p></main>`;
    const [block] = extractVisibleBlocks(document);
    expect(block!.text).toBe("First bold sentence here. Second linked one.");
    for (const s of block!.sentences) {
      const range = getRangeForOffsets(block!, s.start, s.end)!;
      expect(range).not.toBeNull();
      expect(range.toString()).toBe(block!.text.slice(s.start, s.end));
    }
  });

  it("keeps non-breaking and unusual spaces as content (the Unicode scan needs them)", () => {
    document.body.innerHTML = `<main><p>A B C  \n D</p></main>`;
    const [block] = extractVisibleBlocks(document);
    expect(block!.text).toBe("A B C D");
  });

  it("detects stale blocks when their nodes are removed", () => {
    document.body.innerHTML = `<main><p id="p">${LONG}</p></main>`;
    const [block] = extractVisibleBlocks(document);
    expect(isBlockStale(block!)).toBe(false);
    document.getElementById("p")!.remove();
    expect(isBlockStale(block!)).toBe(true);
  });
});

describe("extractSelectionBlock", () => {
  it("reads a selection inside a single text node (regression: used to return null)", () => {
    document.body.innerHTML = `<p id="p">${LONG}</p>`;
    const text = document.getElementById("p")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 50);
    getSelection()!.addRange(range);
    const rec = extractSelectionBlock(window);
    expect(rec).not.toBeNull();
    expect(rec!.text).toBe(LONG.slice(0, 50));
  });

  it("reads a selection spanning elements, clipped to the selected characters", () => {
    document.body.innerHTML = `<div id="d"><p>Alpha beta gamma.</p><p>Delta epsilon zeta.</p></div>`;
    const [p1, p2] = document.querySelectorAll("p");
    const range = document.createRange();
    range.setStart(p1!.firstChild!, 6);
    range.setEnd(p2!.firstChild!, 5);
    getSelection()!.addRange(range);
    const rec = extractSelectionBlock(window)!;
    expect(rec.text.replace(/\s+/g, " ")).toBe("beta gamma.Delta");
  });

  it("returns null for a collapsed selection", () => {
    document.body.innerHTML = `<p id="p">${LONG}</p>`;
    const range = document.createRange();
    range.setStart(document.getElementById("p")!.firstChild!, 3);
    getSelection()!.addRange(range);
    expect(extractSelectionBlock(window)).toBeNull();
  });
});

function activeFrom(scores: number[], muted = false): ActiveSentence[] {
  const [block] = extractVisibleBlocks(document);
  return block!.sentences.map((s, i) => ({
    blockId: block!.id,
    index: i,
    range: getRangeForOffsets(block!, s.start, s.end)!,
    text: block!.text.slice(s.start, s.end),
    score: scores[i] ?? 0,
    sources: {},
    wordCount: 5,
    muted,
  }));
}

describe("renderHighlights (<mark> fallback)", () => {
  it("heatmap marks every sentence; flagged marks only >= threshold; clear restores the DOM", () => {
    document.body.innerHTML = `<main><p id="p">${LONG}</p></main>`;
    const before = document.getElementById("p")!.innerHTML;
    const sentences = activeFrom([0.9, 0.2, 0.7]);

    renderHighlights(sentences, "heatmap");
    let marks = [...document.querySelectorAll("mark.ai-detector-mark")];
    expect(marks.map((m) => m.textContent)).toEqual(sentences.map((s) => s.text));
    expect(marks.every((m) => /ai-detector-hl-heatmap-n\d+/.test(m.className))).toBe(true);
    // The fallback relies on the stylesheet (no inline style that would override it).
    expect(marks.every((m) => !(m as HTMLElement).getAttribute("style"))).toBe(true);
    expect(document.getElementById("ai-detector-highlight-style")!.textContent).toContain("mark.ai-detector-hl-heatmap");

    clearHighlights();
    expect(document.querySelectorAll("mark").length).toBe(0);
    expect(document.getElementById("p")!.textContent).toBe(LONG);
    expect(document.getElementById("p")!.innerHTML.replace(/<!---->/g, "")).toBe(before);

    renderHighlights(activeFrom([0.9, 0.2, 0.7]), "flagged");
    marks = [...document.querySelectorAll("mark.ai-detector-mark")];
    expect(marks.length).toBe(2);
    expect(marks.every((m) => m.className.includes("-flagged-"))).toBe(true);
  });

  it("muted sentences get the muted class variant", () => {
    document.body.innerHTML = `<main><p>${LONG}</p></main>`;
    renderHighlights(activeFrom([0.9, 0.9, 0.9], true), "underline");
    const marks = [...document.querySelectorAll("mark.ai-detector-mark")];
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((m) => /-underline-m\d+/.test(m.className))).toBe(true);
  });
});

describe("hidden-Unicode markers", () => {
  const tags = [..."hi there"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");

  it("groups adjacent characters into one run with UTF-16-correct ends", () => {
    const text = `a​​b${tags}c`;
    const runs = groupRuns(scanUnicode(text).findings);
    const zw = runs.find((r) => r.finding.category === "zero-width")!;
    const tag = runs.find((r) => r.finding.category === "tag-character")!;
    expect([zw.start, zw.end, zw.count]).toEqual([1, 3, 2]);
    expect(tag.count).toBe(8);
    expect(tag.end - tag.start).toBe(16); // 8 astral chars = 16 code units
    expect(text.slice(tag.start, tag.end)).toBe(tags);
  });

  it("inserts one marker per run and never splits a surrogate pair", () => {
    document.body.innerHTML = `<main><p id="p">Visible text${tags} continues​here.</p></main>`;
    const [block] = extractVisibleBlocks(document);
    const { markers } = renderUnicodeMarkers(block!);
    expect(markers.map((m) => m.textContent).sort()).toEqual(["⟦TAG×8⟧", "⟦ZW⟧"]);
    for (const node of document.getElementById("p")!.childNodes) {
      if (node.nodeType !== 3) continue;
      const data = (node as Text).data;
      expect(/[\uD800-\uDBFF]$/.test(data)).toBe(false); // no dangling high surrogate
      expect(/^[\uDC00-\uDFFF]/.test(data)).toBe(false); // no orphaned low surrogate
    }
    clearUnicodeMarkers();
    expect(document.getElementById("p")!.textContent).toBe(`Visible text${tags} continues​here.`);
  });
});
