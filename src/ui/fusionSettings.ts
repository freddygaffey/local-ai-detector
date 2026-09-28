// Self-contained Fusion settings block for the options page (owned by T7;
// T9 mounts it with `mountFusionSettings(el)`). Pick any subset of
// detectors and a combination method; shows the total download and a speed
// estimate for the chosen set on this device. Reads/writes settings itself
// and follows changes made elsewhere (watchSettings).

import { DETECTOR_LABELS, estimateFusion } from "../engine/models";
import { sendMessage } from "../shared/messages";
import {
  DEFAULT_FUSION,
  getSettings,
  sanitizeFusion,
  setSettings,
  watchSettings,
  type FusionDetector,
  type FusionMethod,
  type FusionSettings,
  type Settings,
} from "../shared/settings";

export const FUSION_DETECTOR_INFO: Record<FusionDetector, { name: string; blurb: string; experimental?: boolean }> = {
  fakespot: { name: DETECTOR_LABELS.fakespot, blurb: "Mozilla/Fakespot RoBERTa classifier (Apache-2.0). Best single detector on our web test set." },
  tmr: { name: DETECTOR_LABELS.tmr, blurb: "RoBERTa classifier trained on RAID (MIT). Used for the automatic pass." },
  modernbert: { name: DETECTOR_LABELS.modernbert, blurb: "ModernBERT classifier trained on RAID + MAGE (Apache-2.0)." },
  lite: { name: DETECTOR_LABELS.lite, blurb: "Small, fast e5 classifier (MIT)." },
  perplexity: { name: DETECTOR_LABELS.perplexity, blurb: "How predictable the text is to DistilGPT-2 (Apache-2.0)." },
  binoculars: {
    name: DETECTOR_LABELS.binoculars,
    blurb: "Compares two small SmolLM2 models (Apache-2.0). Slow; runs on the CPU.",
    experimental: true,
  },
};

export const FUSION_METHOD_INFO: Record<FusionMethod, { name: string; blurb: string }> = {
  weighted: { name: "Weighted average", blurb: "Default. Weights fitted on our test data." },
  logodds: { name: "Log-odds average", blurb: "A very confident detector counts for more." },
  vote: { name: "Majority vote", blurb: "Flags only when most detectors flag. Fewest false alarms." },
  max: { name: "Highest score", blurb: "Flags when any detector flags. Catches more, but wrongly flags more people." },
};

export const FUSION_PRESETS: { id: string; name: string; fusion: FusionSettings }[] = [
  { id: "recommended", name: "Recommended", fusion: DEFAULT_FUSION },
  { id: "fast", name: "Fast", fusion: { detectors: ["lite", "perplexity"], method: "weighted" } },
  { id: "classic", name: "Classic (v0.1 Ensemble)", fusion: { detectors: ["tmr", "perplexity"], method: "weighted" } },
  {
    id: "everything",
    name: "Everything",
    fusion: { detectors: ["tmr", "modernbert", "lite", "perplexity", "binoculars"], method: "weighted" },
  },
];


function mb(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}

function seconds(ms: number): string {
  return ms < 1000 ? "under 1 s" : `about ${Math.round(ms / 1000)} s`;
}

function sameFusion(a: FusionSettings, b: FusionSettings): boolean {
  return a.method === b.method && a.detectors.length === b.detectors.length && a.detectors.every((d) => b.detectors.includes(d));
}

/** Pure summary line for a detector set (exported for tests). */
export function fusionSummary(
  fusion: FusionSettings,
  device: "webgpu" | "wasm",
  overrides?: Settings["modelOverrides"],
): string {
  const e = estimateFusion(fusion.detectors, device, overrides);
  const size = e.bytes === null ? "download size unknown (custom model)" : `${mb(e.bytes)} download (once)`;
  const where = device === "webgpu" ? "on the GPU" : "on the CPU";
  return `${fusion.detectors.length} detector${fusion.detectors.length === 1 ? "" : "s"} · ${size} · ${seconds(e.msPer1kWords)} per 1,000 words ${where}`;
}

/**
 * Renders the Fusion settings into `el` (replacing its contents). Returns
 * an unmount function.
 */
export function mountFusionSettings(el: HTMLElement): () => void {
  el.replaceChildren();
  const root = document.createElement("div");
  root.className = "lad-fusion";
  root.innerHTML = `
    <style>
      .lad-fusion { display: grid; gap: 10px; font: inherit; color: var(--ink, inherit); }
      .lad-fusion fieldset { border: 1px solid var(--border, #ccc); border-radius: var(--radius-md, 6px); padding: 8px 10px; margin: 0; }
      .lad-fusion legend { font-weight: 600; padding: 0 4px; }
      .lad-fusion label { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; flex-wrap: wrap; }
      .lad-fusion .blurb { color: var(--ink-soft, #555); font-size: 0.9em; }
      .lad-fusion .tag { font-size: 0.75em; border: 1px solid var(--border-strong, #999); border-radius: 3px; padding: 0 4px; margin-left: 4px; }
      .lad-fusion .presets { display: flex; flex-wrap: wrap; gap: 6px; }
      .lad-fusion .presets button { font: inherit; padding: 3px 8px; border-radius: var(--radius-sm, 3px); border: 1px solid var(--border-strong, #999); background: var(--surface, #fff); color: inherit; cursor: pointer; }
      .lad-fusion .presets button[aria-pressed="true"] { background: var(--accent-soft, #dde); border-color: var(--accent, #366); }
      .lad-fusion .summary { font-variant-numeric: tabular-nums; }
      .lad-fusion .warn { color: var(--danger, #a40); }
    </style>
    <div class="presets" role="group" aria-label="Presets"></div>
    <label class="method-row"><span>Combine by</span> <select class="methods"></select> <span class="blurb method-blurb"></span></label>
    <div class="summary blurb" aria-live="polite"></div>`;
  el.append(root);

  const presetsEl = root.querySelector<HTMLElement>(".presets")!;
  const methodsEl = root.querySelector<HTMLSelectElement>(".methods")!;
  const methodBlurb = root.querySelector<HTMLElement>(".method-blurb")!;
  const summaryEl = root.querySelector<HTMLElement>(".summary")!;

  let settings: Settings | null = null;
  let device: "webgpu" | "wasm" = "webgpu";
  let deviceKnown = false;

  const save = (fusion: FusionSettings) => {
    void setSettings({ fusion: sanitizeFusion(fusion) }).then((s) => {
      settings = s;
      render();
    });
  };

  const presetButtons = FUSION_PRESETS.map((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.name;
    b.dataset.preset = p.id;
    b.addEventListener("click", () => save(p.fusion));
    presetsEl.append(b);
    return { p, b };
  });

  // The detectors themselves are ticked in the detector matrix (tierSettings.ts).
  for (const m of Object.keys(FUSION_METHOD_INFO) as FusionMethod[]) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = FUSION_METHOD_INFO[m].name;
    methodsEl.append(opt);
  }
  methodsEl.addEventListener("change", () => {
    if (settings) save({ ...settings.fusion, method: methodsEl.value as FusionMethod });
  });

  function render() {
    if (!settings) return;
    const f = settings.fusion;
    methodsEl.value = f.method;
    methodsEl.disabled = f.detectors.length < 2;
    methodBlurb.textContent = FUSION_METHOD_INFO[f.method].blurb;
    for (const { p, b } of presetButtons) b.setAttribute("aria-pressed", String(sameFusion(p.fusion, f)));
    const dev = settings.useWebGPU ? device : "wasm";
    const e = estimateFusion(f.detectors, dev, settings.modelOverrides);
    const notes = [fusionSummary(f, dev, settings.modelOverrides)];
    if (deviceKnown && dev === "webgpu" && e.wasmOnly.length) notes.push("Binoculars runs on the CPU.");
    summaryEl.textContent = notes.join(" · ");
  }

  let alive = true;
  void getSettings().then((s) => {
    if (!alive) return;
    settings = s;
    render();
  });
  void sendMessage("getEngineInfo", undefined)
    .then((info) => {
      if (!alive || !info.runtime) return;
      deviceKnown = true;
      device = info.runtime.device === "webgpu" || info.runtime.shaderF16 ? "webgpu" : "wasm";
      render();
    })
    .catch(() => {});
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
