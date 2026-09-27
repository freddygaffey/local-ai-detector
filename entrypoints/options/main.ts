// Options page: all settings, model management (check/update/rollback,
// custom models with licence warnings, cache size/delete), provenance
// explainer, and About (accuracy, privacy, licence, credits).

import "../../src/ui/styles.css";
import "./options.css";

import { getSettings, setSettings } from "@/src/shared/settings";
import type { HighlightStyle, Mode, ModelSlot, Settings } from "@/src/shared/settings";
import { sendMessage } from "@/src/shared/messages";
import type {
  CustomModelValidation,
  EngineInfo,
  ModelSlotCacheInfo,
  ModelUpdateInfo,
} from "@/src/shared/messages";
import { browser } from "wxt/browser";
import { clearChildren, h } from "@/src/ui/dom";
import { formatBytes, shortSha } from "@/src/ui/format";
import { EXPERIMENTAL_MODES, licenseLabel, MODEL_REGISTRY, MODE_LABEL } from "@/src/ui/modelInfo";
import { brandMark, externalLinkIcon } from "@/src/ui/icons";
import { NO_SIGNALS_WORDING, UNCHECKABLE_SCHEMES } from "@/src/provenance/schemes";
import { requestImagePermission } from "@/src/provenance/permissions";

const SLOTS = Object.keys(MODEL_REGISTRY) as ModelSlot[];

interface State {
  settings: Settings;
  cache: { slots: Partial<Record<ModelSlot, ModelSlotCacheInfo>>; totalBytes: number } | null;
  cacheError: string | null;
  updates: Partial<Record<ModelSlot, ModelUpdateInfo | "checking" | "none">>;
  actionBusy: Set<ModelSlot>;
  actionError: Partial<Record<ModelSlot, string>>;
  customRepoInput: Partial<Record<ModelSlot, string>>;
  customValidation: Partial<Record<ModelSlot, CustomModelValidation | "checking">>;
  engine: EngineInfo | null;
  allUrlsGranted: boolean | null;
}

const state: State = {
  settings: await getSettings(),
  cache: null,
  cacheError: null,
  updates: {},
  actionBusy: new Set(),
  actionError: {},
  customRepoInput: {},
  customValidation: {},
  engine: null,
  allUrlsGranted: null,
};

const root = document.getElementById("app") as HTMLDivElement;

async function main() {
  render();
  void refreshCache();
  void refreshEngineInfo();
  void refreshPermission();
}

async function refreshCache(): Promise<void> {
  try {
    const cache = await sendMessage("getModelCacheInfo", undefined);
    state.cache = cache;
    state.cacheError = null;
  } catch (err) {
    state.cacheError = err instanceof Error ? err.message : String(err);
  }
  render();
}

async function refreshEngineInfo(): Promise<void> {
  try {
    state.engine = await sendMessage("getEngineInfo", undefined);
  } catch {
    state.engine = null;
  }
  render();
}

async function refreshPermission(): Promise<void> {
  try {
    state.allUrlsGranted = await browser.permissions.contains({ origins: ["<all_urls>"] });
  } catch {
    state.allUrlsGranted = null;
  }
  render();
}

async function updateSettings(partial: Partial<Settings>): Promise<void> {
  state.settings = await setSettings(partial);
  render();
}

function render(): void {
  clearChildren(root);
  root.append(
    h(
      "div",
      { class: "options-shell" },
      renderNav(),
      h(
        "main",
        { class: "options-main" },
        renderDetectionSection(),
        renderModelsSection(),
        renderProvenanceSection(),
        renderAboutSection(),
      ),
    ),
  );
}

function renderNav(): HTMLElement {
  return h(
    "nav",
    { class: "options-nav" },
    h("div", { class: "brand" }, brandMark(), h("span", null, "Local AI Detector")),
    h("a", { href: "#detection" }, "Detection"),
    h("a", { href: "#models" }, "Models"),
    h("a", { href: "#provenance" }, "Provenance"),
    h("a", { href: "#about" }, "About"),
  );
}

// ---- Detection settings ----

function renderDetectionSection(): HTMLElement {
  const s = state.settings;
  const list = h(
    "div",
    { class: "settings-list" },
    fieldRow(
      "Detector mode",
      "Which model(s) score each page. Ensemble combines two signals for the steadiest read.",
      selectControl(
        (Object.keys(MODE_LABEL) as Mode[]).map((mode) => ({
          value: mode,
          label: MODE_LABEL[mode] + (EXPERIMENTAL_MODES.has(mode) ? " (experimental)" : ""),
        })),
        s.mode,
        (value) => void updateSettings({ mode: value as Mode }),
      ),
    ),
    fieldRow(
      "Ensemble classifier",
      "Which classifier Ensemble mode blends with perplexity. The standard one (TMR, ~126 MB) ranked texts better and flagged fewer human texts in our tests; the lite one (~34 MB) is smaller and faster.",
      selectControl(
        [
          { value: "classifier", label: "Standard (TMR RoBERTa)" },
          { value: "classifierLite", label: "Lite (e5-small)" },
        ],
        s.ensembleClassifier,
        (value) => void updateSettings({ ensembleClassifier: value as Settings["ensembleClassifier"] }),
      ),
    ),
    fieldRow(
      "Highlight style",
      "How flagged sentences are marked on the page.",
      selectControl(
        [
          { value: "heatmap", label: "Heatmap" },
          { value: "flagged", label: "Flagged only" },
          { value: "underline", label: "Underline" },
        ],
        s.highlightStyle,
        (value) => void updateSettings({ highlightStyle: value as HighlightStyle }),
      ),
    ),
    fieldRow(
      "Analyze automatically",
      "Score a page on load instead of waiting for “Analyze page” in the popup.",
      toggleControl(s.autoRun, (checked) => void updateSettings({ autoRun: checked })),
    ),
    fieldRow(
      "Minimum words per chunk",
      "Sentences/chunks shorter than this are too noisy to score and are skipped.",
      numberControl(s.minWords, 0, 500, (value) => void updateSettings({ minWords: value })),
    ),
    fieldRow(
      "Max tokens analyzed per page",
      "Caps how much of a long page gets analyzed, to keep it fast.",
      numberControl(s.maxTokens, 256, 32000, (value) => void updateSettings({ maxTokens: value })),
    ),
    fieldRow(
      "Show hidden-Unicode summary",
      "Report unusual invisible characters. Never treated as AI evidence by itself.",
      toggleControl(s.showUnicode, (checked) => void updateSettings({ showUnicode: checked })),
    ),
    fieldRow(
      "Check images for provenance",
      "Look for Content Credentials (C2PA) and similar metadata in images on the page.",
      toggleControl(s.checkImages, (checked) => void updateSettings({ checkImages: checked })),
    ),
    fieldRow(
      "Use the GPU (WebGPU) when available",
      "Off by default. The GPU is several times faster on long pages, but runs different (fp16/4-bit) model weights, so its scores differ from the CPU's and from Firefox's; it has its own, less-tested calibration. Binoculars always runs on the CPU.",
      toggleControl(s.useWebGPU, (checked) => void updateSettings({ useWebGPU: checked })),
    ),
    fieldRow(
      "Check for model updates automatically",
      "Off by default. When on, checks Hugging Face for newer pinned revisions on startup.",
      toggleControl(s.autoCheckModelUpdates, (checked) => void updateSettings({ autoCheckModelUpdates: checked })),
    ),
  );
  return h(
    "section",
    { id: "detection" },
    h("h2", null, "Detection"),
    h("p", { class: "section-intro" }, "How pages are scanned and scored."),
    list,
  );
}

function fieldRow(label: string, hint: string, control: HTMLElement): HTMLElement {
  return h(
    "div",
    { class: "field-row" },
    h("div", { class: "field-main" }, h("span", { class: "field-label" }, label), h("span", { class: "field-hint" }, hint)),
    h("div", { class: "control" }, control),
  );
}

function selectControl(
  options: { value: string; label: string }[],
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  return h(
    "select",
    { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
    ...options.map((opt) => h("option", { value: opt.value, selected: opt.value === value }, opt.label)),
  );
}

function toggleControl(checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
  return h(
    "label",
    { class: "switch" },
    h("input", { type: "checkbox", checked, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }),
    h("span", { class: "track" }),
    h("span", { class: "knob" }),
  );
}

function numberControl(value: number, min: number, max: number, onChange: (value: number) => void): HTMLInputElement {
  return h("input", {
    type: "number",
    class: "number-input",
    value: String(value),
    min: String(min),
    max: String(max),
    onchange: (e: Event) => {
      const n = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, Math.round(n))));
    },
  });
}

// ---- Models ----

function renderModelsSection(): HTMLElement {
  const total = state.cache ? h("span", { class: "value mono" }, formatBytes(state.cache.totalBytes)) : h("span", { class: "field-hint" }, state.cacheError ? "unknown (models haven't loaded yet)" : "checking…");
  const engineLine = state.engine?.runtime
    ? `Running on ${state.engine.runtime.device.toUpperCase()}${state.engine.runtime.shaderF16 ? " (shader-f16)" : ""} · ${state.engine.runtime.threads} thread${state.engine.runtime.threads === 1 ? "" : "s"} · ${cacheBackendLabel(state.engine.runtime.cache)}${state.engine.runtime.persisted ? " · storage persisted" : ""}`
    : "Runtime not started yet — it initializes on first analysis.";

  return h(
    "section",
    { id: "models" },
    h("h2", null, "Models"),
    h(
      "p",
      { class: "section-intro" },
      "Every model is pinned to a known revision. Updates are opt-in and reversible: the previous revision is kept until you roll back.",
    ),
    h("div", { class: "cache-total" }, h("span", null, "Total model cache"), total),
    h("p", { class: "status-line" }, engineLine),
    h(
      "div",
      { class: "btn-row", style: "margin:0.8em 0 1.2em" },
      h("button", { class: "btn", type: "button", onclick: () => void checkAllUpdates() }, "Check for updates"),
      h("button", { class: "btn btn-ghost", type: "button", onclick: () => void refreshCache() }, "Refresh cache info"),
    ),
    h("div", { class: "settings-list" }, ...SLOTS.map((slot) => renderModelRow(slot))),
  );
}

type CacheBackend = NonNullable<EngineInfo["runtime"]>["cache"];

function cacheBackendLabel(cache: CacheBackend): string {
  switch (cache) {
    case "cache-api":
      return "Cache API";
    case "indexeddb":
      return "IndexedDB fallback";
    case "filesystem":
      return "filesystem fallback";
    default:
      return "no cache backend";
  }
}

async function checkAllUpdates(): Promise<void> {
  for (const slot of SLOTS) state.updates[slot] = "checking";
  render();
  try {
    const updates = await sendMessage("checkModelUpdates", undefined);
    const bySlot = new Map(updates.map((u) => [u.slot, u]));
    for (const slot of SLOTS) state.updates[slot] = bySlot.get(slot) ?? "none";
  } catch (err) {
    for (const slot of SLOTS) state.actionError[slot] = err instanceof Error ? err.message : String(err);
    for (const slot of SLOTS) state.updates[slot] = "none";
  }
  render();
}

function renderModelRow(slot: ModelSlot): HTMLElement {
  const info = MODEL_REGISTRY[slot];
  const override = state.settings.modelOverrides[slot];
  const repo = override?.repo ?? info.repo;
  const revision = override?.revision ?? info.revision;
  const sizeBytes = info.sizes[info.dtypes.wasm] ?? null;
  const cacheEntry = state.cache?.slots[slot];
  const busy = state.actionBusy.has(slot);
  const update = state.updates[slot];

  const rows: HTMLElement[] = [];
  rows.push(
    h(
      "div",
      { class: "field-row" },
      h(
        "div",
        { class: "field-main" },
        h("span", { class: "field-label" }, info.label),
        h(
          "span",
          { class: "field-hint mono" },
          `${repo} @ ${shortSha(revision)} · ${licenseLabel(info.license)}${sizeBytes ? ` · ~${formatBytes(sizeBytes)}` : ""} · `,
          cacheEntry ? (cacheEntry.cached ? `cached (${formatBytes(cacheEntry.sizeBytes)})` : "not cached") : "cached: unknown",
        ),
      ),
      h(
        "div",
        { class: "control model-actions" },
        h(
          "button",
          { class: "btn", type: "button", disabled: busy, onclick: () => void doUpdate(slot) },
          "Update",
        ),
        h(
          "button",
          { class: "btn", type: "button", disabled: busy || !override?.previous, onclick: () => void doRollback(slot) },
          "Roll back",
        ),
        h(
          "button",
          { class: "btn btn-danger", type: "button", disabled: busy, onclick: () => void doDelete(slot) },
          "Delete cache",
        ),
      ),
    ),
  );

  if (update === "checking") {
    rows.push(h("p", { class: "status-line" }, "Checking Hugging Face for a newer revision…"));
  } else if (update && typeof update === "object") {
    rows.push(
      h(
        "p",
        { class: "model-update-note" },
        `New revision available: ${shortSha(update.latestRevision)} (${update.license ?? "licence unknown"}).`,
      ),
    );
  }
  if (state.actionError[slot]) {
    rows.push(h("p", { class: "model-error-note" }, state.actionError[slot]!));
  }
  rows.push(renderCustomModelForm(slot));

  return h("div", { class: "model-block" }, ...rows);
}

async function doUpdate(slot: ModelSlot): Promise<void> {
  await runSlotAction(slot, () => sendMessage("updateModel", { slot }));
}
async function doRollback(slot: ModelSlot): Promise<void> {
  await runSlotAction(slot, () => sendMessage("rollbackModel", { slot }));
}
async function doDelete(slot: ModelSlot): Promise<void> {
  await runSlotAction(slot, async () => {
    const res = await sendMessage("deleteCachedModel", { slot });
    return res;
  });
}

async function runSlotAction(slot: ModelSlot, action: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
  state.actionBusy.add(slot);
  delete state.actionError[slot];
  render();
  try {
    const res = await action();
    if (!res.ok) state.actionError[slot] = res.error ?? "Failed.";
    state.settings = await getSettings();
    void refreshCache();
  } catch (err) {
    state.actionError[slot] = err instanceof Error ? err.message : String(err);
  } finally {
    state.actionBusy.delete(slot);
    render();
  }
}

function renderCustomModelForm(slot: ModelSlot): HTMLElement {
  const value = state.customRepoInput[slot] ?? "";
  const validation = state.customValidation[slot];
  const form = h(
    "div",
    { class: "custom-model-form" },
    h("input", {
      class: "text-input",
      type: "text",
      placeholder: "org/model-name (Hugging Face repo)",
      value,
      oninput: (e: Event) => {
        state.customRepoInput[slot] = (e.target as HTMLInputElement).value;
      },
    }),
    h(
      "button",
      {
        class: "btn",
        type: "button",
        disabled: validation === "checking",
        onclick: () => void validateCustom(slot),
      },
      "Check licence",
    ),
  );
  const wrap = h("div", null, form);
  if (validation === "checking") {
    wrap.append(h("p", { class: "status-line" }, "Checking…"));
  } else if (validation && validation.ok) {
    const warn = !validation.openLicense;
    wrap.append(
      h(
        "p",
        { class: warn ? "license-warning" : "model-update-note" },
        `${validation.repo} @ ${shortSha(validation.revision)} — licence: ${validation.license ?? "unknown"}.` +
          (validation.sizeBytes ? ` ~${formatBytes(validation.sizeBytes)}.` : "") +
          (warn ? " This licence is not a known open licence — double-check it allows this use before switching." : ""),
      ),
    );
    for (const w of validation.warnings) wrap.append(h("p", { class: "model-error-note" }, w));
    wrap.append(
      h(
        "button",
        { class: "btn btn-primary", type: "button", onclick: () => void useCustom(slot, validation.repo) },
        "Use this model",
      ),
    );
  } else if (validation && !validation.ok) {
    wrap.append(h("p", { class: "model-error-note" }, validation.error));
  }
  return wrap;
}

async function validateCustom(slot: ModelSlot): Promise<void> {
  const repo = (state.customRepoInput[slot] ?? "").trim();
  if (!repo) return;
  state.customValidation[slot] = "checking";
  render();
  try {
    state.customValidation[slot] = await sendMessage("validateCustomModel", { slot, repo });
  } catch (err) {
    state.customValidation[slot] = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  render();
}

async function useCustom(slot: ModelSlot, repo: string): Promise<void> {
  state.actionBusy.add(slot);
  render();
  try {
    const res = await sendMessage("setCustomModel", { slot, repo });
    if (!res.ok) {
      state.actionError[slot] = res.error;
    } else {
      state.settings = await getSettings();
      delete state.customValidation[slot];
      void refreshCache();
    }
  } catch (err) {
    state.actionError[slot] = err instanceof Error ? err.message : String(err);
  } finally {
    state.actionBusy.delete(slot);
    render();
  }
}

// ---- Provenance ----

function renderProvenanceSection(): HTMLElement {
  return h(
    "section",
    { id: "provenance" },
    h("h2", null, "Provenance & watermarks"),
    h(
      "p",
      { class: "section-intro" },
      "What this extension can check about images and text without leaving your device, and what it honestly can't.",
    ),
    h(
      "div",
      { class: "provenance-grid" },
      h(
        "div",
        { class: "provenance-card" },
        h("h3", null, "Checked locally"),
        h(
          "ul",
          null,
          h("li", null, "C2PA / Content Credentials manifests in images, validated against a bundled trust list."),
          h("li", null, "IPTC DigitalSourceType and generator metadata (SD/ComfyUI/NovelAI/Midjourney and similar), shown as “unsigned claim”."),
          h("li", null, "Stable Diffusion / FLUX invisible DWT-DCT watermarks (a hit is a positive; a miss means nothing)."),
          h("li", null, "NovelAI stealth PNG metadata."),
          h("li", null, "C2PA text manifests and a hidden-Unicode report in text, shown as “unusual characters”, never as an AI watermark."),
        ),
      ),
      h(
        "div",
        { class: "provenance-card" },
        h("h3", null, "Cannot be checked locally"),
        h(
          "p",
          null,
          "These need a provider's secret key or a remote service. “No watermark found” never means “human-made”. Checker links open the provider's own site only when you click them; nothing is uploaded automatically.",
        ),
        h(
          "ul",
          null,
          ...UNCHECKABLE_SCHEMES.map((scheme) =>
            h(
              "li",
              null,
              h("strong", null, scheme.name),
              ` (${scheme.media}; ${scheme.usedBy}). ${scheme.why} `,
              scheme.checker
                ? h("a", { href: scheme.checker.url, target: "_blank", rel: "noreferrer" }, scheme.checker.label, externalLinkIcon())
                : null,
            ),
          ),
        ),
        h("p", { class: "field-hint" }, NO_SIGNALS_WORDING),
      ),
    ),
    h(
      "div",
      { class: "field-row", style: "margin-top:1.2em" },
      h(
        "div",
        { class: "field-main" },
        h("span", { class: "field-label" }, "Allow checking images on every site"),
        h(
          "span",
          { class: "field-hint" },
          "Optional. Without it, images are only checked on sites you allow one by one from the popup (“Allow image checks on …”). Image bytes are read locally to look for provenance data and never sent anywhere.",
        ),
      ),
      h(
        "div",
        { class: "control" },
        state.allUrlsGranted
          ? h("span", { class: "chip chip-human" }, "Granted")
          : h("button", { class: "btn", type: "button", onclick: () => void requestAllUrls() }, "Grant access"),
      ),
    ),
  );
}

async function requestAllUrls(): Promise<void> {
  try {
    const granted = await requestImagePermission(["<all_urls>"]);
    state.allUrlsGranted = granted;
  } catch {
    // User denied the browser's own permission prompt, or it's unsupported here.
  }
  render();
}

// ---- About ----

const THIRD_PARTY_MODELS: { name: string; license: string }[] = [
  { name: "onnx-community/tmr-ai-text-detector-ONNX (classifier)", license: "MIT" },
  { name: "onnx-community/e5-small-lora-ai-generated-detector-ONNX (classifier — lite)", license: "MIT" },
  { name: "Xenova/distilgpt2 (perplexity)", license: "Apache-2.0" },
  { name: "onnx-community/SmolLM2-135M-ONNX + -Instruct-ONNX (binoculars, experimental)", license: "Apache-2.0" },
];

const THIRD_PARTY_LIBS: { name: string; license: string }[] = [
  { name: "@huggingface/transformers", license: "Apache-2.0" },
  { name: "onnxruntime-web", license: "MIT" },
  { name: "@contentauth/c2pa-web", license: "MIT" },
  { name: "exifreader", license: "MPL-2.0" },
  { name: "c2pa-text", license: "MIT" },
  { name: "C2PA Trust List (c2pa-org/conformance-public)", license: "CC-BY-4.0" },
  { name: "wxt (build tool)", license: "MIT" },
];

function renderAboutSection(): HTMLElement {
  return h(
    "section",
    { id: "about" },
    h("h2", null, "About"),
    h(
      "div",
      { class: "accuracy-box" },
      h(
        "p",
        null,
        "No detector here, or anywhere, is reliable enough to accuse someone of using AI. Paraphrasing defeats most of these methods, non-native English writing is flagged at a disproportionately high rate, and short passages (under ~50 words) score unpredictably — a plain human sentence scored 0.82 “AI” in our own testing.",
      ),
      h(
        "p",
        null,
        "Every model is English-only and trained on a limited sample of AI writing (mostly the RAID dataset), so newer or unusual models will read as more human than they are. Binoculars mode uses much smaller models than the scheme was validated with, so it's labelled experimental. Treat every score as one hint among many, never as a verdict.",
      ),
    ),
    h("h3", null, "Privacy"),
    h(
      "p",
      null,
      "Nothing about a page you analyze leaves your device. Text extraction, scoring and provenance checks all run locally in your browser. The only network requests this extension makes are to huggingface.co, to download a model the first time you use a mode and to check for newer model revisions (only when you ask, or if you turn on automatic update checks).",
    ),
    h("h3", null, "Licence"),
    h("p", null, "This extension is free and open-source software under the MIT licence. It downloads model weights at runtime rather than bundling them; it never redistributes them."),
    h("h3", null, "Third-party models"),
    h(
      "div",
      { class: "credits-list" },
      ...THIRD_PARTY_MODELS.map((m) => h("div", { class: "credits-row" }, h("span", { class: "name" }, m.name), h("span", { class: "license" }, m.license))),
    ),
    h("h3", null, "Bundled libraries"),
    h(
      "div",
      { class: "credits-list" },
      ...THIRD_PARTY_LIBS.map((m) => h("div", { class: "credits-row" }, h("span", { class: "name" }, m.name), h("span", { class: "license" }, m.license))),
    ),
    h(
      "p",
      { class: "field-hint", style: "margin-top:0.8em" },
      "The C2PA Trust List is reproduced under CC-BY-4.0 from the C2PA Conformance Program (c2pa-org/conformance-public). ExifReader's MPL-2.0 licence applies to that file's unmodified source.",
    ),
  );
}

void main();
