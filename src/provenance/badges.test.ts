// @vitest-environment happy-dom
//
// Covers the quiet "not checked" cue for images awaiting the optional host
// permission (docs/integration-notes.md "For T12"): they used to be
// silently dropped (never passed the old `status === "ok"` filter), so the
// user had no idea some images on the page were never even looked at.

import { afterEach, describe, expect, test, vi } from "vitest";
import { badgeText, clearImageBadges, renderImageBadgeResults } from "./badges";
import type { ImageProvenanceResult, ImageSignal } from "./types";

// The badge host uses a *closed* shadow root on purpose (page scripts must
// never reach in). `Element.prototype.attachShadow`'s return value is a
// real ShadowRoot regardless of mode -- only the `.shadowRoot` getter is
// nulled -- so spying on it is the one way test code can still assert on
// what got rendered, without weakening the closed mode itself.
function captureNextShadowRoot(): { get(): ShadowRoot } {
  const original = Element.prototype.attachShadow;
  let captured: ShadowRoot | undefined;
  const spy = vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init: ShadowRootInit) {
    const root = original.call(this, init);
    captured ??= root;
    return root;
  });
  return {
    get() {
      if (!captured) throw new Error("attachShadow was never called");
      spy.mockRestore();
      return captured;
    },
  };
}

const checks = { c2pa: "not-found", metadata: "not-found", invisibleWatermark: "not-found", novelaiAlpha: "not-found" } as const;

function okResult(src: string, signals: ImageSignal[]): ImageProvenanceResult {
  return { src, status: "ok", signals, checks: { ...checks }, notes: [], errors: [] };
}

function permissionNeededResult(src: string): ImageProvenanceResult {
  return { src, status: "permission-needed", signals: [], checks: { ...checks }, notes: [], errors: [] };
}

function mountImg(src: string): HTMLImageElement {
  const img = document.createElement("img");
  img.src = src;
  document.body.appendChild(img);
  return img;
}

afterEach(() => {
  clearImageBadges();
  document.body.replaceChildren();
});

describe("badgeText", () => {
  test("a quiet marker for permission-needed, distinct from a real 'no signals' result", () => {
    expect(badgeText(permissionNeededResult("https://x/a.png"))).toBe("?");
    expect(badgeText(okResult("https://x/a.png", []))).toBeNull();
  });
});

describe("renderImageBadgeResults", () => {
  test("renders a not-checked badge for a permission-needed image", () => {
    const capture = captureNextShadowRoot();
    const src = "https://example.com/needs-permission.png";
    const img = mountImg(src);
    renderImageBadgeResults([permissionNeededResult(src)], new Map([[src, [img]]]));
    const shadow = capture.get();
    const el = shadow.querySelector(".badge.not-checked");
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("?");
  });

  test("an image with no signals and no permission gap gets no badge at all", () => {
    const src = "https://example.com/checked-clean.png";
    const img = mountImg(src);
    renderImageBadgeResults([okResult(src, [])], new Map([[src, [img]]]));
    const host = document.querySelector("[data-local-ai-detector-badges]");
    // ensureHost() is only called when there's at least one relevant result;
    // a clean, fully-checked image isn't one, so the host never appears.
    expect(host).toBeNull();
  });

  test("upgrades a not-checked badge in place once the image is actually checked", () => {
    const capture = captureNextShadowRoot();
    const src = "https://example.com/now-granted.png";
    const img = mountImg(src);
    const elements = new Map([[src, [img]]]);
    renderImageBadgeResults([permissionNeededResult(src)], elements);
    const shadow = capture.get();
    expect(shadow.querySelector(".badge.not-checked")).not.toBeNull();

    const sig: ImageSignal = { kind: "metadata", verdict: "ai", trusted: false, signed: false, label: "AI claim", detail: "detail" };
    renderImageBadgeResults([okResult(src, [sig])], elements);
    expect(shadow.querySelector(".badge.not-checked")).toBeNull();
    expect(shadow.querySelector(".badge.ai")).not.toBeNull();
    // Still exactly one badge for this image -- upgraded in place, not duplicated.
    expect(shadow.querySelectorAll(".badge").length).toBe(1);
  });
});
