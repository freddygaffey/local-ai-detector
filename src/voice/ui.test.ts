// @vitest-environment happy-dom
//
// Covers the voice chip's "consent" state (fresh-install bug fix, docs/plan.md
// "T11"): without a `Download model` action, a user who hadn't consented to
// the download saw a chip stuck on "Voice: --" with no way to act on it,
// which read as "nothing happened". See the same-pattern comment in
// src/provenance/badges.test.ts for why attachShadow needs spying here.

import { describe, expect, test, vi } from "vitest";
import { createVoiceChip } from "./ui";
import { DEFAULT_VOICE } from "./settings";
import type { VoiceState } from "./capture";

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

const consentState: VoiceState = { status: "consent", clips: [], agg: { p: null, clips: 0 }, durationS: 60 };

describe("voice chip: consent state", () => {
  test("shows an inline, already-visible download action sized from the model registry", () => {
    const capture = captureNextShadowRoot();
    const onConsent = vi.fn();
    const chip = createVoiceChip({ onRun: () => {}, onSeek: () => {}, onConsent });
    const root = capture.get();

    chip.setState(consentState, { settings: DEFAULT_VOICE, rate: "normal" });

    const details = root.querySelector(".details") as HTMLElement;
    expect(details.hidden).toBe(false); // visible without an extra click

    const btn = root.querySelector(".action") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    // formatBytes() (binary MiB), the same helper the model checklist uses for consistency.
    expect(btn.textContent).toBe("Download model (347.2 MB)"); // Spectra-AASIST3, the default model

    btn.click();
    expect(onConsent).toHaveBeenCalledTimes(1);

    // Clicking the main chip while gated on consent doesn't hide the action again.
    const chipButton = root.querySelector(".chip") as HTMLButtonElement;
    chipButton.click();
    expect(details.hidden).toBe(false);
  });
});
