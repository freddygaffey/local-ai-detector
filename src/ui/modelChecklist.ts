// Model download checklist (docs/integration-notes.md "For T12", user
// feedback: "the first-run download becomes a checklist"). Shown on the
// popup's first-run consent screen and again in options -> Models. Reads
// the model registry dynamically (src/engine/models.ts) instead of
// hard-coding sizes/roles, because T7 may add slots (e.g. Fakespot).
//
// All rows start ticked. Unchecking a row removes that detector from
// `settings.fusion.detectors` (only meaningful in Fusion mode -- the other
// modes have exactly one required model and its row is locked on). The
// running total and the "Download" button reflect only checked rows.
// Actually fetching the bytes still happens lazily on first analysis (T1's
// `ensureModels`); this component only decides *which* detectors are asked
// for, by writing the same `fusion.detectors` field the Fusion settings
// panel (src/ui/fusionSettings.ts, T7) reads and writes.

import { DEFAULT_MODELS, DETECTOR_SLOTS, estimateFusion, type FusionSpec } from "../engine/models";
import type { FusionDetector, Mode, ModelSlot, Settings } from "../shared/settings";
import { fusionFrom } from "../engine/models";
import { formatBytes } from "./format";
import { h } from "./dom";

/** Short, plain-language role blurb per detector -- "a few words," not a sentence. */
export const DETECTOR_ROLE: Record<FusionDetector, string> = {
  fakespot: "Main classifier (Mozilla/Fakespot).",
  tmr: "Second classifier (RAID-trained).",
  modernbert: "Extra classifier (RAID + MAGE).",
  lite: "Small & fast; used for the automatic pass.",
  perplexity: "Predictability to a small language model.",
  binoculars: "Compares two small models. Slow.",
};

/** Mode -> the one detector it needs, for the four single-detector modes. */
const MODE_DETECTOR: Partial<Record<Mode, FusionDetector>> = {
  classifier: "tmr",
  classifierLite: "lite",
  perplexity: "perplexity",
  binoculars: "binoculars",
};

/** Every Fusion detector, in a fixed display order (matches src/ui/fusionSettings.ts). */
export const ALL_FUSION_DETECTORS: FusionDetector[] = ["fakespot", "tmr", "modernbert", "lite", "perplexity", "binoculars"];

export interface ChecklistRow {
  id: FusionDetector;
  label: string;
  role: string;
  sizeBytes: number | null;
  slots: ModelSlot[];
  /** Every slot this detector needs is already in the cache. */
  cached: boolean;
  checked: boolean;
  /** Can't be unchecked: the only detector for a single-detector mode, or the last one left in Fusion. */
  locked: boolean;
}

export type CacheKnown = Partial<Record<ModelSlot, boolean>>;

/**
 * Builds the checklist rows for the current mode. For "ensemble" (Fusion),
 * one row per detector in `settings.fusion.detectors` (checked) plus any
 * detector NOT currently selected is omitted -- the checklist only ever
 * shows what would actually be requested, never an unrelated detector the
 * user would need the Fusion panel to add first.
 */
export function checklistRows(
  mode: Mode,
  fusion: FusionSpec,
  overrides: Settings["modelOverrides"] | undefined,
  device: "wasm" | "webgpu",
  cache: CacheKnown | undefined,
  /** Options -> Models passes true to also list detectors NOT currently selected (unchecked, addable). */
  listAll = false,
): ChecklistRow[] {
  const single = MODE_DETECTOR[mode];
  const selected = single ? [single] : fusionFrom(fusion).detectors;
  const ids = single ? [single] : listAll ? ALL_FUSION_DETECTORS : selected;
  return ids.map((id) => {
    const slots = DETECTOR_SLOTS[id];
    const sizeBytes = estimateFusion([id], device, overrides).bytes;
    const cached = cache ? slots.every((s) => cache[s] === true) : false;
    const checked = selected.includes(id);
    return {
      id,
      label: slots.map((s) => DEFAULT_MODELS[s].label).join(" + "),
      role: DETECTOR_ROLE[id],
      sizeBytes,
      slots,
      cached,
      checked,
      locked: !!single || (checked && selected.length <= 1),
    };
  });
}

/**
 * First-run checklist rows for the default setup (docs/plan.md "Two tiers"):
 * every text detector the defaults use -- the Quick tier's automatic pass
 * (the lite model) and the click-to-run Fusion set -- all ticked. A row
 * can't be unticked when it's the last detector of its tier. Deep-only
 * extras (ModernBERT, perplexity, Binoculars) are fetched when Deep first
 * runs, behind their own prompt.
 */
export function defaultsChecklistRows(
  settings: Pick<Settings, "mode" | "fusion" | "tiers" | "modelOverrides">,
  device: "wasm" | "webgpu",
  cache: CacheKnown | undefined,
): (ChecklistRow & { tier: "quick" | "click" })[] {
  const quick = settings.tiers.autoRunQuick ? settings.tiers.quickDetectors : [];
  const single = MODE_DETECTOR[settings.mode];
  const click = single ? [single] : fusionFrom(settings.fusion).detectors;
  const ids = [...new Set([...quick, ...click])];
  return ids.map((id) => {
    const slots = DETECTOR_SLOTS[id];
    const inQuick = quick.includes(id);
    const inClick = click.includes(id);
    return {
      id,
      label: slots.map((s) => DEFAULT_MODELS[s].label).join(" + "),
      role: DETECTOR_ROLE[id],
      sizeBytes: estimateFusion([id], device, settings.modelOverrides).bytes,
      slots,
      cached: cache ? slots.every((s) => cache[s] === true) : false,
      checked: true,
      locked: !!single && inClick ? true : (inQuick && quick.length <= 1) || (inClick && click.length <= 1),
      tier: inQuick ? "quick" : "click",
    };
  });
}

/** Running total over checked rows only; null if any checked row's size is unknown (custom repo). */
export function checklistTotalBytes(rows: Pick<ChecklistRow, "checked" | "sizeBytes">[]): number | null {
  let total = 0;
  for (const r of rows) {
    if (!r.checked) continue;
    if (r.sizeBytes === null) return null;
    total += r.sizeBytes;
  }
  return total;
}

/**
 * Whether a mode's models are fully cached already, and how much is left to
 * fetch if not -- for greying out a mode/detector picker with an inline
 * "download (N MB)" hint (docs/integration-notes.md "For T12").
 */
export function modeDownloadStatus(
  mode: Mode,
  fusion: FusionSpec,
  overrides: Settings["modelOverrides"] | undefined,
  device: "wasm" | "webgpu",
  cache: CacheKnown | undefined,
): { cached: boolean; missingBytes: number | null } {
  if (!cache) return { cached: true, missingBytes: null }; // unknown yet -- don't grey out speculatively
  const rows = checklistRows(mode, fusion, overrides, device, cache);
  const missing = rows.filter((r) => !r.cached);
  if (missing.length === 0) return { cached: true, missingBytes: null };
  let bytes = 0;
  for (const r of missing) {
    if (r.sizeBytes === null) return { cached: false, missingBytes: null };
    bytes += r.sizeBytes;
  }
  return { cached: false, missingBytes: bytes };
}

export interface ChecklistOptions {
  rows: ChecklistRow[];
  onToggle: (id: FusionDetector, checked: boolean) => void;
  /** Omit to hide the Download button (e.g. nothing left to fetch). */
  onDownload?: () => void;
  downloadLabel?: string;
  busy?: boolean;
  /** T11: non-Fusion rows (e.g. the voice-check models, src/voice/checklist.ts), rendered after the detector rows and counted in the total. */
  extraRows?: ExtraChecklistRow[];
}

/** A checklist row that isn't a Fusion detector; it handles its own toggle. */
export interface ExtraChecklistRow {
  key: string;
  label: string;
  role: string;
  sizeBytes: number | null;
  checked: boolean;
  cached: boolean;
  onToggle(checked: boolean): void;
}

/** Renders the checklist: one row per detector, a running total, one button. */
export function renderModelChecklist(opts: ChecklistOptions): HTMLElement {
  const { rows, onToggle, onDownload, downloadLabel, busy } = opts;
  const extra = opts.extraRows ?? [];
  const allRows = [
    ...rows.map((row) => ({ ...row, key: row.id as string, onToggleRow: (c: boolean) => onToggle(row.id, c) })),
    ...extra.map((row) => ({ ...row, locked: false, onToggleRow: row.onToggle })),
  ];
  const rowEls = allRows.map((row) => {
    const checkbox = h("input", {
      type: "checkbox",
      checked: row.checked,
      disabled: row.locked,
      "aria-label": row.label,
      onchange: (e: Event) => row.onToggleRow((e.target as HTMLInputElement).checked),
    }) as HTMLInputElement;
    return h(
      "label",
      { class: `model-checklist-row${row.cached ? " is-cached" : ""}` },
      checkbox,
      h(
        "span",
        { class: "model-checklist-text" },
        h("span", { class: "model-checklist-label" }, row.label),
        h("span", { class: "model-checklist-role" }, row.cached ? `${row.role} · cached` : row.role),
      ),
      h("span", { class: "model-checklist-size mono" }, row.sizeBytes === null ? "size unknown" : formatBytes(row.sizeBytes)),
    );
  });
  const totalBytes = checklistTotalBytes([...rows, ...extra] as Pick<ChecklistRow, "checked" | "sizeBytes">[]);
  const footer = h(
    "div",
    { class: "model-checklist-footer" },
    h("span", null, "Total"),
    h("span", { class: "value mono" }, totalBytes === null ? "unknown" : `~${formatBytes(totalBytes)}`),
  );
  const children: (Node | null)[] = [h("div", { class: "model-checklist-rows" }, ...rowEls), footer];
  if (onDownload) {
    children.push(
      h(
        "button",
        { class: "btn btn-primary btn-block", type: "button", disabled: !!busy, onclick: onDownload },
        busy ? "Downloading…" : downloadLabel ?? "Download",
      ),
    );
  }
  return h("div", { class: "model-checklist" }, ...children);
}
