// Self-contained Fusion settings block for the options page (owned by T7;
// T9 mounts it with `mountFusionSettings(el)`). Pick any subset of
// detectors and a combination method; shows the total download and a speed
// estimate for the chosen set on this device. Reads/writes settings itself
// and follows changes made elsewhere (watchSettings).

import { DEFAULT_MODELS, DETECTOR_LABELS, DETECTOR_SLOTS, estimateFusion } from "../engine/models";
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
  tmr: { name: DETECTOR_LABELS.tmr, blurb: "RoBERTa classifier trained on RAID (MIT)." },
  modernbert: { name: DETECTOR_LABELS.modernbert, blurb: "ModernBERT classifier trained on RAID + MAGE (Apache-2.0)." },
  lite: { name: DETECTOR_LABELS.lite, blurb: "Small, fast e5 classifier (MIT). Used for the automatic pass." },
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

const ORDER: FusionDetector[] = ["fakespot", "tmr", "modernbert", "lite", "perplexity", "binoculars"];

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
      .lad-fusion label { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; }
      .lad-fusion .blurb { color: var(--ink-soft, #555); font-size: 0.9em; }
      .lad-fusion .tag { font-size: 0.75em; border: 1px solid var(--border-strong, #999); border-radius: 3px; padding: 0 4px; margin-left: 4px; }
      .lad-fusion .presets { display: flex; flex-wrap: wrap; gap: 6px; }
      .lad-fusion .presets button { font: inherit; padding: 3px 8px; border-radius: var(--radius-sm, 3px); border: 1px solid var(--border-strong, #999); background: var(--surface, #fff); color: inherit; cursor: pointer; }
      .lad-fusion .presets button[aria-pressed="true"] { background: var(--accent-soft, #dde); border-color: var(--accent, #366); }
      .lad-fusion .summary { font-variant-numeric: tabular-nums; }
      .lad-fusion .warn { color: var(--danger, #a40); }
    </style>
    <div class="presets" role="group" aria-label="Presets"></div>
    <fieldset class="dets"><legend>Detectors</legend></fieldset>
    <fieldset class="methods"><legend>Combine scores by</legend></fieldset>
    <div class="summary" aria-live="polite"></div>
    <div class="device blurb"></div>`;
  el.append(root);

  const presetsEl = root.querySelector<HTMLElement>(".presets")!;
  const detsEl = root.querySelector<HTMLElement>(".dets")!;
  const methodsEl = root.querySelector<HTMLElement>(".methods")!;
  const summaryEl = root.querySelector<HTMLElement>(".summary")!;
  const deviceEl = root.querySelector<HTMLElement>(".device")!;

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

  const boxes = new Map<FusionDetector, HTMLInputElement>();
  for (const d of ORDER) {
    const info = FUSION_DETECTOR_INFO[d];
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = d;
    box.addEventListener("change", () => {
      if (!settings) return;
      const next = ORDER.filter((x) => (x === d ? box.checked : settings!.fusion.detectors.includes(x)));
      if (next.length === 0) {
        box.checked = true; // keep at least one
        return;
      }
      save({ ...settings.fusion, detectors: next });
    });
    boxes.set(d, box);
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = info.name;
    text.append(name);
    if (info.experimental) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "experimental";
      text.append(tag);
    }
    const blurb = document.createElement("span");
    blurb.className = "blurb";
    const slots = DETECTOR_SLOTS[d].map((s) => DEFAULT_MODELS[s].repo).join(" + ");
    blurb.textContent = ` — ${info.blurb}`;
    blurb.title = slots;
    text.append(blurb);
    label.append(box, text);
    detsEl.append(label);
  }

  const radios = new Map<FusionMethod, HTMLInputElement>();
  for (const m of Object.keys(FUSION_METHOD_INFO) as FusionMethod[]) {
    const info = FUSION_METHOD_INFO[m];
    const label = document.createElement("label");
    const r = document.createElement("input");
    r.type = "radio";
    r.name = "lad-fusion-method";
    r.value = m;
    r.addEventListener("change", () => {
      if (settings && r.checked) save({ ...settings.fusion, method: m });
    });
    radios.set(m, r);
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = info.name;
    const blurb = document.createElement("span");
    blurb.className = "blurb";
    blurb.textContent = ` — ${info.blurb}`;
    text.append(name, blurb);
    label.append(r, text);
    methodsEl.append(label);
  }

  function render() {
    if (!settings) return;
    const f = settings.fusion;
    for (const [d, box] of boxes) box.checked = f.detectors.includes(d);
    for (const [m, r] of radios) r.checked = f.method === m;
    methodsEl.toggleAttribute("disabled", f.detectors.length < 2);
    for (const { p, b } of presetButtons) b.setAttribute("aria-pressed", String(sameFusion(p.fusion, f)));
    const dev = settings.useWebGPU ? device : "wasm";
    summaryEl.textContent = fusionSummary(f, dev, settings.modelOverrides);
    const e = estimateFusion(f.detectors, dev, settings.modelOverrides);
    const notes: string[] = [];
    if (!deviceKnown) notes.push("Device not checked yet; estimate assumes the GPU.");
    else notes.push(dev === "webgpu" ? "Runs on this device's GPU (WebGPU)." : "Runs on the CPU (WebGPU is off or unavailable here).");
    if (dev === "webgpu" && e.wasmOnly.length) notes.push("Binoculars always runs on the CPU.");
    if (settings.mode !== "ensemble") notes.push("Fusion is used when the detector mode is Fusion.");
    deviceEl.textContent = notes.join(" ");
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
