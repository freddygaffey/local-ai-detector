// @vitest-environment happy-dom
//
// Covers the fresh-install bug fix (docs/plan.md "T4"): every YouTube
// thumbnail was getting a grey "not checked" badge. discoverImages() now
// requires a genuinely content-sized image (>=300x200 by default) that
// isn't inside a link, list item or ARIA list (a thumbnail grid tile), and
// can be restricted to one subtree (`root`) -- youtube.com uses this to
// scope to the video description.

import { describe, expect, test } from "vitest";
import { discoverImages } from "./discover";

/** A real <img> happy-dom will report as "loaded" at a given displayed/intrinsic size. */
function mountImg(parent: Element, src: string, opts: { w?: number; h?: number; natW?: number; natH?: number } = {}): HTMLImageElement {
  const img = document.createElement("img");
  img.src = src;
  const w = opts.w ?? 400;
  const h = opts.h ?? 300;
  Object.defineProperty(img, "naturalWidth", { value: opts.natW ?? w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: opts.natH ?? h, configurable: true });
  img.getBoundingClientRect = () => ({ x: 0, y: 0, width: w, height: h, top: 0, left: 0, right: w, bottom: h, toJSON() {} });
  parent.appendChild(img);
  return img;
}

describe("discoverImages: thumbnail suppression (fresh-install YouTube badge-noise bug)", () => {
  test("a large, unwrapped image is discovered by default", async () => {
    document.body.replaceChildren();
    mountImg(document.body, "https://example.com/hero.jpg", { w: 400, h: 300 });
    const found = await discoverImages();
    expect(found.map((f) => f.candidate.src)).toEqual(["https://example.com/hero.jpg"]);
  });

  test("below the 300x200 default size reads as a thumbnail and is skipped", async () => {
    document.body.replaceChildren();
    mountImg(document.body, "https://example.com/small.jpg", { w: 200, h: 150 });
    const found = await discoverImages();
    expect(found).toHaveLength(0);
  });

  test("a large image inside a link (a video/article tile) is skipped by default", async () => {
    document.body.replaceChildren();
    const a = document.createElement("a");
    a.href = "/watch?v=x";
    document.body.appendChild(a);
    mountImg(a, "https://example.com/tile.jpg", { w: 400, h: 300 });
    expect(await discoverImages()).toHaveLength(0);
    // The context-menu "check this image" flow opts out explicitly.
    const found = await discoverImages({ excludeThumbnails: false });
    expect(found.map((f) => f.candidate.src)).toEqual(["https://example.com/tile.jpg"]);
  });

  test("a large image inside a list item or ARIA list is skipped by default", async () => {
    document.body.replaceChildren();
    const ul = document.createElement("ul");
    const li = document.createElement("li");
    ul.appendChild(li);
    document.body.appendChild(ul);
    mountImg(li, "https://example.com/li.jpg", { w: 400, h: 300 });
    expect(await discoverImages()).toHaveLength(0);

    document.body.replaceChildren();
    const list = document.createElement("div");
    list.setAttribute("role", "list");
    document.body.appendChild(list);
    mountImg(list, "https://example.com/ariali.jpg", { w: 400, h: 300 });
    expect(await discoverImages()).toHaveLength(0);
  });

  test("root restricts discovery to a subtree; root: null means nothing at all", async () => {
    document.body.replaceChildren();
    const description = document.createElement("div");
    description.id = "description";
    document.body.appendChild(description);
    mountImg(description, "https://example.com/in-desc.jpg", { w: 400, h: 300 });
    mountImg(document.body, "https://example.com/outside.jpg", { w: 400, h: 300 });

    const scoped = await discoverImages({ root: description });
    expect(scoped.map((f) => f.candidate.src)).toEqual(["https://example.com/in-desc.jpg"]);

    expect(await discoverImages({ root: null })).toHaveLength(0);
  });
});
