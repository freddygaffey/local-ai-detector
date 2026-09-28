// The options page's detector matrix (docs/plan.md "Two tiers"): one row per
// detector, one column per use -- Fusion (checks you start in Fusion mode, and
// the confirmation of a flagged Quick result), Quick (the automatic pass) and
// Deep (the ↻ button). Replaces three separate detector lists that repeated
// each other. Mounted once with `mountTierSettings(el)`; reads/writes settings
// itself and follows changes made elsewhere.

import { DETECTOR_LABELS } from "../engine/models";
import {
  DEFAULT_TIERS,
  getSettings,
  sanitizeFusion,
  sanitizeTiers,
  setSettings,
  watchSettings,
  type FusionDetector,
  type Settings,
  type TierSettings,
} from "../shared/settings";
import { FUSION_DETECTOR_INFO } from "./fusionSettings";

export const DETECTOR_ORDER: FusionDetector[] = ["fakespot", "tmr", "modernbert", "lite", "perplexity", "binoculars"];

type Column = "fusion" | "quick" | "deep";
const COLUMNS: { id: Column; label: string; title: string }[] = [
  { id: "fusion", label: "Fusion", title: "Fusion mode, and confirming a flagged Quick result" },
  { id: "quick", label: "Quick", title: "The automatic pass on page load" },
  { id: "deep", label: "Deep", title: "The ↻ button: slower, reads the whole page" },
];

/** The column's detector list after ticking/unticking `d`; null when that would leave it empty. */
export function toggleDetector(list: readonly FusionDetector[], d: FusionDetector, on: boolean): FusionDetector[] | null {
  const next = DETECTOR_ORDER.filter((x) => (x === d ? on : list.includes(x)));
  return next.length ? next : null;
}

export function columnList(settings: Pick<Settings, "fusion" | "tiers">, column: Column): FusionDetector[] {
  if (column === "fusion") return settings.fusion.detectors;
  return column === "quick" ? settings.tiers.quickDetectors : settings.tiers.deepDetectors;
}

/** The settings patch for a column's new list. */
export function columnPatch(settings: Pick<Settings, "fusion" | "tiers">, column: Column, list: FusionDetector[]): Partial<Settings> {
  if (column === "fusion") return { fusion: sanitizeFusion({ ...settings.fusion, detectors: list }) };
  const key = column === "quick" ? "quickDetectors" : "deepDetectors";
  return { tiers: sanitizeTiers({ ...settings.tiers, [key]: list }) };
}

/** Renders the matrix into `el` (replacing its contents). Returns an unmount function. */
export function mountTierSettings(el: HTMLElement): () => void {
  el.replaceChildren();
  const root = document.createElement("div");
  root.className = "lad-tiers";
  root.innerHTML = `
    <style>
      .lad-tiers { display: grid; gap: 6px; font: inherit; color: var(--ink, inherit); }
      .lad-tiers table { border-collapse: collapse; width: 100%; }
      .lad-tiers th, .lad-tiers td { padding: 4px 6px; text-align: center; border-bottom: 1px solid var(--border, #ddd); }
      .lad-tiers th:first-child, .lad-tiers td:first-child { text-align: left; }
      .lad-tiers thead th { font-weight: 600; font-size: 0.85em; color: var(--ink-soft, #555); }
      .lad-tiers .tag { font-size: 0.75em; color: var(--ink-soft, #555); margin-left: 4px; }
      .lad-tiers .row { display: flex; gap: 8px; align-items: center; padding: 3px 0; }
      .lad-tiers .row input[type=number] { width: 7em; }
      .lad-tiers .blurb { color: var(--ink-soft, #555); font-size: 0.9em; }
    </style>
    <table><thead><tr><th>Detector</th></tr></thead><tbody></tbody></table>
    <label class="row"><input type="checkbox" class="confirm"><span>Confirm flagged Quick results with Fusion</span></label>
    <label class="row budget"><span>Quick reads up to</span> <input type="number" min="128" max="32000" step="128" /> <span class="blurb">tokens</span></label>`;
  // Whether Quick runs automatically is controlled in one place only: Presence → Auto-run.
  el.append(root);

  const headRow = root.querySelector("thead tr")!;
  for (const c of COLUMNS) {
    const th = document.createElement("th");
    th.textContent = c.label;
    th.title = c.title;
    headRow.append(th);
  }

  let settings: Settings | null = null;
  const save = (patch: Partial<Settings>) => {
    void setSettings(patch).then((s) => {
      settings = s;
      render();
    });
  };

  const boxes: { column: Column; d: FusionDetector; box: HTMLInputElement }[] = [];
  const body = root.querySelector("tbody")!;
  for (const d of DETECTOR_ORDER) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = DETECTOR_LABELS[d];
    name.title = FUSION_DETECTOR_INFO[d].blurb;
    if (FUSION_DETECTOR_INFO[d].experimental) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "experimental";
      name.append(tag);
    }
    tr.append(name);
    for (const c of COLUMNS) {
      const td = document.createElement("td");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.setAttribute("aria-label", `${DETECTOR_LABELS[d]}: ${c.label}`);
      box.addEventListener("change", () => {
        if (!settings) return;
        const next = toggleDetector(columnList(settings, c.id), d, box.checked);
        if (!next) {
          box.checked = true; // keep at least one per column
          return;
        }
        save(columnPatch(settings, c.id, next));
      });
      boxes.push({ column: c.id, d, box });
      td.append(box);
      tr.append(td);
    }
    body.append(tr);
  }

  const confirmBox = root.querySelector<HTMLInputElement>("input.confirm")!;
  confirmBox.addEventListener("change", () => {
    if (settings) save({ tiers: sanitizeTiers({ ...settings.tiers, confirmQuick: confirmBox.checked }) });
  });
  const budgetBox = root.querySelector<HTMLInputElement>(".budget input")!;
  budgetBox.addEventListener("change", () => {
    if (settings) save({ tiers: sanitizeTiers({ ...settings.tiers, quickMaxTokens: Number(budgetBox.value) }) });
  });

  function render(): void {
    if (!settings) return;
    for (const { column, d, box } of boxes) box.checked = columnList(settings, column).includes(d);
    confirmBox.checked = settings.tiers.confirmQuick;
    if (document.activeElement !== budgetBox) budgetBox.value = String(settings.tiers.quickMaxTokens);
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
