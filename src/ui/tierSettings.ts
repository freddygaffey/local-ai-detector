// Self-contained "Two tiers" settings block for the options page (docs/plan.md
// "Two tiers: Quick (default) and Deep (on demand)"), mounted the same way
// as Fusion's (src/ui/fusionSettings.ts): `mountTierSettings(el)`. Terse by
// design (the plan calls for exactly this, no more): which detectors Quick
// (the automatic pass) and Deep (the ↻ button) each use, and whether Quick
// runs automatically at all.

import { DETECTOR_LABELS } from "../engine/models";
import {
  DEFAULT_TIERS,
  getSettings,
  sanitizeTiers,
  setSettings,
  watchSettings,
  type FusionDetector,
  type Settings,
  type TierSettings,
} from "../shared/settings";

const ORDER: FusionDetector[] = ["fakespot", "tmr", "modernbert", "lite", "perplexity", "binoculars"];

/** Renders the tiers settings into `el` (replacing its contents). Returns an unmount function. */
export function mountTierSettings(el: HTMLElement): () => void {
  el.replaceChildren();
  const root = document.createElement("div");
  root.className = "lad-tiers";
  root.innerHTML = `
    <style>
      .lad-tiers { display: grid; gap: 10px; font: inherit; color: var(--ink, inherit); }
      .lad-tiers fieldset { border: 1px solid var(--border, #ccc); border-radius: var(--radius-md, 6px); padding: 8px 10px; margin: 0; }
      .lad-tiers legend { font-weight: 600; padding: 0 4px; }
      .lad-tiers label.det { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; }
      .lad-tiers .row { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; }
      .lad-tiers .blurb { color: var(--ink-soft, #555); font-size: 0.9em; }
    </style>
    <fieldset class="quick"><legend>Quick detectors</legend></fieldset>
    <fieldset class="deep"><legend>Deep detectors</legend></fieldset>`;
  // Whether the quick check runs automatically is controlled in one place only:
  // Presence → Auto-run. (A second checkbox here contradicted it.)
  el.append(root);

  const quickEl = root.querySelector<HTMLElement>(".quick")!;
  const deepEl = root.querySelector<HTMLElement>(".deep")!;

  let settings: Settings | null = null;

  const save = (tiers: TierSettings) => {
    void setSettings({ tiers: sanitizeTiers(tiers) }).then((s) => {
      settings = s;
      render();
    });
  };

  function boxesFor(container: HTMLElement, key: "quickDetectors" | "deepDetectors"): Map<FusionDetector, HTMLInputElement> {
    const boxes = new Map<FusionDetector, HTMLInputElement>();
    for (const d of ORDER) {
      const label = document.createElement("label");
      label.className = "det";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = d;
      box.addEventListener("change", () => {
        if (!settings) return;
        const current = settings.tiers[key];
        const next = ORDER.filter((x) => (x === d ? box.checked : current.includes(x)));
        if (next.length === 0) {
          box.checked = true; // keep at least one
          return;
        }
        save({ ...settings.tiers, [key]: next });
      });
      boxes.set(d, box);
      const text = document.createElement("span");
      text.textContent = DETECTOR_LABELS[d];
      label.append(box, text);
      container.append(label);
    }
    return boxes;
  }

  const quickBoxes = boxesFor(quickEl, "quickDetectors");
  const deepBoxes = boxesFor(deepEl, "deepDetectors");

  function render(): void {
    if (!settings) return;
    const t = settings.tiers;
    for (const [d, box] of quickBoxes) box.checked = t.quickDetectors.includes(d);
    for (const [d, box] of deepBoxes) box.checked = t.deepDetectors.includes(d);
  }

  let alive = true;
  void getSettings().then((s) => {
    if (!alive) return;
    settings = s;
    render();
  });
  const unwatch = watchSettings((s) => {
    settings = s;
    render();
  });
  return () => {
    alive = false;
    unwatch();
    el.replaceChildren();
  };
}

/** Pure default, exported for tests/other UI (e.g. a "Reset to defaults" affordance). */
export const DEFAULT_TIER_SETTINGS: TierSettings = DEFAULT_TIERS;
