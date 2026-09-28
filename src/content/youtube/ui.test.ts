// @vitest-environment happy-dom
//
// Covers the transcript chip's "consent" state (fresh-install bug fix,
// docs/plan.md "T10"): without a `Download models` action, a user who
// hadn't consented to the download saw a plain "Transcript: --", which read
// as "no result" rather than "do something to get one". See the
// same-pattern comment in src/provenance/badges.test.ts for why attachShadow
// needs spying here.

import { describe, expect, test, vi } from "vitest";
import { chipLabel, createTranscriptChip } from "./ui";
import type { TranscriptReport } from "../../shared/transcript";

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

const consentReport: TranscriptReport = { videoId: "v1", state: "consent", segments: [], disclosure: null, consentMB: 42 };

describe("chip label", () => {
  test("consent state text never reads as a bare '--'", () => {
    expect(chipLabel(consentReport).text).toBe("Transcript: download models");
  });
});

describe("transcript chip: consent state", () => {
  test("shows an inline, already-visible download action sized from the background's quote", () => {
    const capture = captureNextShadowRoot();
    const onConsent = vi.fn();
    const chip = createTranscriptChip({ onRun: () => {}, onDeep: () => {}, onSeek: () => {}, onConsent });
    const root = capture.get();

    chip.setReport(consentReport);

    const details = root.querySelector(".details") as HTMLElement;
    expect(details.hidden).toBe(false); // visible without an extra click

    const btn = root.querySelector(".action") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe("Download models (42 MB)");

    btn.click();
    expect(onConsent).toHaveBeenCalledTimes(1);

    // Clicking the main chip while gated on consent is a no-op (the action
    // is already visible), and doesn't hide it again.
    const chipButton = root.querySelector(".chip") as HTMLButtonElement;
    chipButton.click();
    expect(details.hidden).toBe(false);
  });
});
