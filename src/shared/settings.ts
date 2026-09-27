// Typed settings store. Backed by storage.sync so settings follow the user
// across machines, with a storage.local fallback for when sync throws (quota
// exceeded, sync disabled, or unavailable in some private/Firefox contexts).
//
// This file, together with ./messages.ts, is the shared contract described in
// docs/plan.md ("Shared contract"). Other tasks may read these types freely
// but should not change their shape without the lead's sign-off.

import { browser } from "wxt/browser";

/** Detector mode, selectable in the popup/options UI. */
export type Mode =
  | "ensemble"
  | "classifier"
  | "classifierLite"
  | "perplexity"
  | "binoculars";

/** How flagged sentences are rendered by the content script (T2). */
export type HighlightStyle = "heatmap" | "flagged" | "underline";

/** Which downloadable model a given piece of inference logic uses. */
export type ModelSlot =
  | "classifier"
  | "classifierLite"
  | "perplexityLM"
  | "binocularsObserver"
  | "binocularsPerformer";

export interface ModelRef {
  repo: string;
  revision: string;
}

export interface ModelOverride extends ModelRef {
  /** Kept so "rollbackModel" can restore the previous {repo, revision}. */
  previous?: ModelRef;
}

export interface Settings {
  mode: Mode;
  highlightStyle: HighlightStyle;
  /** Automatically analyze pages on navigation, instead of waiting for a click. */
  autoRun: boolean;
  /** Chunks/sentences shorter than this are too noisy to score (see feasibility.md §6). */
  minWords: number;
  /** Cap on tokens analyzed per page, across all chunks. */
  maxTokens: number;
  showUnicode: boolean;
  checkImages: boolean;
  /** Explicit user consent to download model weights (~100-500MB) over the network. */
  consentedDownload: boolean;
  autoCheckModelUpdates: boolean;
  /**
   * Per-slot overrides of the pinned defaults in `src/engine/models.ts`, set
   * either by "update model" (new revision of the same repo) or by
   * "setCustomModel" (a different repo entirely). Empty means "use defaults
   * for every slot" -- deliberately a *partial* map (not every ModelSlot
   * needs an entry), which is a small, intentional deviation from reading
   * the plan's `Record<ModelSlot, ...>` literally.
   */
  modelOverrides: Partial<Record<ModelSlot, ModelOverride>>;
  /**
   * Which classifier the Ensemble mode blends with perplexity. TMR by
   * default: it ranked better and flagged far fewer human texts on a
   * held-out sample (docs/calibration.md, "Which classifier the ensemble
   * uses"); the lite model is ~4x smaller and faster.
   */
  ensembleClassifier: EnsembleClassifier;
}

export type EnsembleClassifier = "classifier" | "classifierLite";

export const DEFAULT_SETTINGS: Settings = {
  mode: "ensemble",
  highlightStyle: "heatmap",
  autoRun: false,
  minWords: 50,
  maxTokens: 4096,
  showUnicode: true,
  checkImages: true,
  consentedDownload: false,
  autoCheckModelUpdates: false,
  modelOverrides: {},
  ensembleClassifier: "classifier",
};

const STORAGE_KEY = "settings";

// Structural type covering just what we use from browser.storage.sync /
// .local -- their concrete types differ (sync has extra quota constants),
// but both satisfy this.
interface MinimalStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

async function readArea(area: MinimalStorageArea): Promise<Partial<Settings> | undefined> {
  const result = (await area.get(STORAGE_KEY)) as Record<string, unknown>;
  return result[STORAGE_KEY] as Partial<Settings> | undefined;
}

function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    modelOverrides: {
      ...DEFAULT_SETTINGS.modelOverrides,
      ...stored?.modelOverrides,
    },
  };
}

/** Reads the current settings, merged over the defaults. */
export async function getSettings(): Promise<Settings> {
  let stored: Partial<Settings> | undefined;
  try {
    stored = await readArea(browser.storage.sync);
  } catch {
    stored = undefined;
  }
  if (stored === undefined) {
    try {
      stored = await readArea(browser.storage.local);
    } catch {
      stored = undefined;
    }
  }
  return mergeSettings(stored);
}

/** Shallow-merges `partial` (and `modelOverrides` one level deep) into the stored settings. */
export async function setSettings(partial: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next: Settings = {
    ...current,
    ...partial,
    modelOverrides: {
      ...current.modelOverrides,
      ...partial.modelOverrides,
    },
  };
  try {
    await browser.storage.sync.set({ [STORAGE_KEY]: next });
    // Keep local in sync too, so a later sync outage still reads the latest value.
    await browser.storage.local.set({ [STORAGE_KEY]: next }).catch(() => {});
  } catch {
    await browser.storage.local.set({ [STORAGE_KEY]: next });
  }
  return next;
}

/**
 * Calls `callback` with the merged settings whenever they change in either
 * storage area. Returns an unsubscribe function.
 */
export function watchSettings(callback: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
    areaName: string,
  ) => {
    if (areaName !== "sync" && areaName !== "local") return;
    if (!(STORAGE_KEY in changes)) return;
    void getSettings().then(callback);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
