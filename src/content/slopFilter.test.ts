// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import { applySearchMarkers, applySlopFilter, clearSearchMarkers, clearSlopFilter } from "./slopFilter";
import { DEFAULT_SETTINGS } from "../shared/settings";

afterEach(() => {
  clearSlopFilter();
  clearSearchMarkers();
  document.body.innerHTML = "";
});

const settings = { ...DEFAULT_SETTINGS.slopFilter, enabled: true, threshold: 0.6 };

describe("applySlopFilter", () => {
  test("dims an item at/above the threshold and shows a Show badge", () => {
    document.body.innerHTML = '<div id="c1">some comment text</div>';
    const el = document.getElementById("c1")!;
    applySlopFilter([{ ownerEl: el, score: 0.8, tooShort: false }], settings);
    expect(el.style.opacity).toBe("0.35");
    const badge = el.previousElementSibling;
    expect(badge?.textContent).toMatch(/^AI \d{1,3}% · Show$/);
  });

  test("collapse style hides the element instead of dimming it", () => {
    document.body.innerHTML = '<div id="c1">some comment text</div>';
    const el = document.getElementById("c1")! as HTMLElement;
    applySlopFilter([{ ownerEl: el, score: 0.9, tooShort: false }], { ...settings, style: "collapse" });
    expect(el.style.display).toBe("none");
  });

  test("leaves items below the threshold alone", () => {
    document.body.innerHTML = '<div id="c1">some comment text</div>';
    const el = document.getElementById("c1")!;
    applySlopFilter([{ ownerEl: el, score: 0.2, tooShort: false }], settings);
    expect(el.getAttribute("style") ?? "").not.toContain("opacity");
  });

  test("never filters a too-short item, even at a high score", () => {
    document.body.innerHTML = '<div id="c1">hi</div>';
    const el = document.getElementById("c1")!;
    applySlopFilter([{ ownerEl: el, score: 0.95, tooShort: true }], settings);
    expect(el.getAttribute("style") ?? "").not.toContain("opacity");
  });

  test("clicking Show undoes the effect", () => {
    document.body.innerHTML = '<div id="c1">some comment text</div>';
    const el = document.getElementById("c1")! as HTMLElement;
    applySlopFilter([{ ownerEl: el, score: 0.9, tooShort: false }], settings);
    const badge = el.previousElementSibling as HTMLElement;
    badge.click();
    expect(el.style.opacity).toBe("");
    expect(document.body.querySelector(".ai-detector-slop-badge")).toBeNull();
  });

  test("disabled settings clears any previously-applied effects", () => {
    document.body.innerHTML = '<div id="c1">some comment text</div>';
    const el = document.getElementById("c1")! as HTMLElement;
    applySlopFilter([{ ownerEl: el, score: 0.9, tooShort: false }], settings);
    applySlopFilter([{ ownerEl: el, score: 0.9, tooShort: false }], { ...settings, enabled: false });
    expect(el.style.opacity).toBe("");
  });
});

describe("applySearchMarkers", () => {
  test("adds a non-interactive badge next to a flagged result, without hiding it", () => {
    document.body.innerHTML = '<div id="r1">a search result</div>';
    const el = document.getElementById("r1")!;
    applySearchMarkers([{ ownerEl: el, score: 0.9, tooShort: false }], 0.6);
    expect(el.style.display).not.toBe("none");
    const badge = el.previousElementSibling;
    expect(badge?.textContent).toMatch(/^AI \d{1,3}%$/);
  });

  test("leaves results below the threshold unmarked", () => {
    document.body.innerHTML = '<div id="r1">a search result</div>';
    const el = document.getElementById("r1")!;
    applySearchMarkers([{ ownerEl: el, score: 0.1, tooShort: false }], 0.6);
    expect(el.previousElementSibling).toBeNull();
  });

  test("clearSearchMarkers removes every added marker", () => {
    document.body.innerHTML = '<div id="r1">a search result</div>';
    const el = document.getElementById("r1")!;
    applySearchMarkers([{ ownerEl: el, score: 0.9, tooShort: false }], 0.6);
    clearSearchMarkers();
    expect(el.previousElementSibling).toBeNull();
  });
});

describe("renderItemLabels", () => {
  test("shows the item's own probability, 'Too short', or '—' when it wasn't analysed", async () => {
    const { renderItemLabels, clearItemLabels } = await import("./slopFilter");
    document.body.innerHTML = '<div id="a">x</div><div id="b">y</div><div id="c">z</div>';
    const [a, b, c] = ["a", "b", "c"].map((id) => document.getElementById(id)!) as [HTMLElement, HTMLElement, HTMLElement];
    renderItemLabels([
      { ownerEl: a, score: 0.9, tooShort: false, probability: 0.42 },
      { ownerEl: b, score: 0, tooShort: true },
      { ownerEl: c, score: 0, tooShort: false, unscored: true },
    ]);
    expect(a.previousElementSibling?.textContent).toBe("AI 42%");
    expect(b.previousElementSibling?.textContent).toBe("Too short");
    expect(c.previousElementSibling?.textContent).toBe("—");
    clearItemLabels();
  });

  test("an unscored item is never filtered", () => {
    document.body.innerHTML = '<div id="c1">some comment text</div>';
    const el = document.getElementById("c1")!;
    applySlopFilter([{ ownerEl: el, score: 0.99, tooShort: false, unscored: true }], settings);
    expect(el.style.opacity).toBe("");
  });
});
