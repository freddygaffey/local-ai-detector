// Typed settings store. Backed by storage.sync so settings follow the user
// across machines, with a storage.local fallback for when sync throws (quota
// exceeded, sync disabled, or unavailable in some private/Firefox contexts).
//
// This file, together with ./messages.ts, is the shared contract described in
// docs/plan.md ("Shared contract"). Other tasks may read these types freely
// but should not change their shape without the lead's sign-off.

import type { PageTypeOverride } from "../content/pageType";
import { browser } from "wxt/browser";
import { FILTER_THRESHOLD } from "./thresholds";
import { DEFAULT_VOICE, type VoiceSettings } from "../voice/settings";

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
  | "binocularsPerformer"
  // Added by T7 (fusion mode): ModernBERT RAID+MAGE and Fakespot RoBERTa classifiers.
  | "classifierModernBert"
  | "classifierFakespot";

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
  /**
   * Use WebGPU when the browser offers it (with shader-f16). On by default
   * (T7): it is the primary, calibrated path, 5-10x faster; WASM is the
   * fallback with its own constants (docs/calibration.md). Fakespot,
   * ModernBERT and Binoculars always run on WASM.
   */
  useWebGPU: boolean;
}

export type EnsembleClassifier = "classifier" | "classifierLite";

// ---- Added by T9: presence modes, battery saver, slop filter, site memory ----
// (docs/plan.md "T9: Presence modes + battery saver"). Additive to the T0
// contract above; `autoRun` is kept (unused) for shape compatibility.

/** How much the extension shows, by default. See docs/plan.md for the exact
 * behaviour of each. "Custom" isn't a stored value -- see `isPresenceCustom`. */
export type Presence = "onClick" | "badge" | "statusChip" | "inspector" | "sidePanel";

/** Whether a fast automatic pass runs on page load: everywhere, nowhere, or
 * (reserved for a future "ask" prompt) only after confirmation. */
export type AutoRunPolicy = "always" | "never" | "ask";

export interface ResultSurfaces {
  popup: boolean;
  badge: boolean;
  /** The small corner chip (Status chip preset), independent of the pill/inspector. */
  chip: boolean;
  /** Sentence highlights + the floating pill on the page itself. */
  highlights: boolean;
  sidePanel: boolean;
}

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface BatterySaverSettings {
  /** What happens while on battery power (Battery Status API, where available). */
  onBatteryAction: "normal" | "lite" | "pause";
  /** Below this battery percent, auto-run pauses (manual runs still ask first). */
  pauseBelowPercent: number;
  /** Pause auto-run under "serious"/"critical" Compute Pressure, where the API exists. */
  pauseOnPressure: boolean;
  /** Unload models from memory after this many idle minutes. */
  unloadAfterMinutes: number;
  /** Prefer CPU (WASM) over GPU (WebGPU) while on battery power. */
  useCpuOnBattery: boolean;
  /** Manual override, shown prominently where the Battery Status API is unavailable (Firefox desktop). */
  manualOverride: boolean;
}

/** Site categories the slop filter (dim/collapse) applies to. */
export type SlopFilterSite = "reddit" | "hackernews" | "youtube" | "twitter" | "forum" | "review";

export interface SlopFilterSettings {
  enabled: boolean;
  /** 0..1. Items scoring at/above this are dimmed/collapsed. */
  threshold: number;
  style: "dim" | "collapse";
  sites: Partial<Record<SlopFilterSite, boolean>>;
  /** Small marker on flagged search-result snippets (Google/Bing/DuckDuckGo/Kagi). */
  searchMarkers: boolean;
}

export interface Settings {
  mode: Mode;
  highlightStyle: HighlightStyle;
  /** @deprecated superseded by `autoRunPolicy`; kept for shape compatibility. */
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
  /**
   * Use WebGPU when the browser offers it (with shader-f16). On by default
   * (T7): it is the primary, calibrated path, 5-10x faster; WASM is the
   * fallback with its own constants (docs/calibration.md). Fakespot,
   * ModernBERT and Binoculars always run on WASM.
   */
  useWebGPU: boolean;

  /** Selected Presence preset. Its underlying settings (below) are the source
   * of truth at runtime; the preset is what "Custom" is measured against. */
  presence: Presence;
  autoRunPolicy: AutoRunPolicy;
  /** Detector mode used for the automatic (auto-run) pass, kept fast/cheap.
   * An on-demand run (click, chip expand, context menu, command) always uses `mode`. */
  autoRunFastMode: Mode;
  /** Per-hostname override of `autoRunPolicy`, incl. "never on this site". */
  siteRules: Record<string, AutoRunPolicy>;
  /**
   * Per-hostname page-type override (src/content/pageType.ts): what runs
   * automatically on that site. Missing = "auto" (URL rules + fingerprint).
   */
  pageTypes: Record<string, PageTypeOverride>;
  surfaces: ResultSurfaces;
  chipCorner: Corner;
  /** Corner card shrinks to a dim dot below this score (0..1); 0 = always shown. */
  chipAutoHideThreshold: number;

  battery: BatterySaverSettings;
  slopFilter: SlopFilterSettings;
  /** Local-only per-domain score tally (docs/plan.md "Site memory"); no text is stored. */
  siteMemoryEnabled: boolean;
  /** Reuse a page's result while its text is unchanged (src/engine/resultCache.ts); local only. */
  rememberResults: boolean;
}

export const PRESENCE_PRESETS: Record<Presence, { autoRunPolicy: AutoRunPolicy; surfaces: ResultSurfaces }> = {
  onClick: {
    autoRunPolicy: "never",
    surfaces: { popup: true, badge: false, chip: false, highlights: false, sidePanel: false },
  },
  badge: {
    autoRunPolicy: "always",
    surfaces: { popup: true, badge: true, chip: false, highlights: false, sidePanel: false },
  },
  statusChip: {
    autoRunPolicy: "always",
    surfaces: { popup: true, badge: true, chip: true, highlights: false, sidePanel: false },
  },
  inspector: {
    autoRunPolicy: "always",
    surfaces: { popup: true, badge: true, chip: false, highlights: true, sidePanel: false },
  },
  sidePanel: {
    autoRunPolicy: "always",
    surfaces: { popup: true, badge: true, chip: false, highlights: false, sidePanel: true },
  },
};

/** The underlying settings a Presence preset maps onto (applied when the user picks it in Options). */
export function presenceDefaults(preset: Presence): { autoRunPolicy: AutoRunPolicy; surfaces: ResultSurfaces } {
  return PRESENCE_PRESETS[preset];
}

/** True when the stored autoRunPolicy/surfaces no longer match the selected preset -- Options shows "Custom". */
export function isPresenceCustom(settings: Pick<Settings, "presence" | "autoRunPolicy" | "surfaces">): boolean {
  const canon = presenceDefaults(settings.presence);
  if (settings.autoRunPolicy !== canon.autoRunPolicy) return true;
  return (Object.keys(canon.surfaces) as (keyof ResultSurfaces)[]).some(
    (key) => settings.surfaces[key] !== canon.surfaces[key],
  );
}

/** Effective auto-run policy for `hostname`, honouring a per-site rule over the global default. */
export function autoRunPolicyForSite(settings: Pick<Settings, "autoRunPolicy" | "siteRules">, hostname: string): AutoRunPolicy {
  return settings.siteRules[hostname] ?? settings.autoRunPolicy;
}

// ---- Added by T7: Fusion mode (docs/plan.md "T7: Fusion mode") ----
//
// Fusion subsumes the old Ensemble: the stored mode value stays "ensemble"
// (so existing settings and every Record<Mode, ...> keep working) and the UI
// calls it "Fusion". Which detectors it runs and how their scores are
// combined come from `Settings.fusion`; the old Ensemble (TMR + perplexity,
// weighted) is just one possible selection.

/** A detector Fusion can run. Each maps onto one or two model slots (src/engine/models.ts). */
export type FusionDetector = "fakespot" | "tmr" | "lite" | "modernbert" | "perplexity" | "binoculars";

/**
 * How Fusion combines the detectors' calibrated scores:
 * - "weighted": weighted average, weights fitted on the calibration data (default);
 * - "logodds": average in log-odds space (equal weights), so confident detectors count for more;
 * - "vote": majority vote, as the median score (flagged when most detectors flag);
 * - "max": the highest score (most sensitive, and flags the most human text).
 */
export type FusionMethod = "weighted" | "logodds" | "vote" | "max";

export interface FusionSettings {
  detectors: FusionDetector[];
  method: FusionMethod;
}

export interface Settings {
  /** Detector set and combination method for Fusion (mode "ensemble"). */
  fusion: FusionSettings;
  /** Settings schema version, for one-off migrations in `mergeSettings`. */
  settingsVersion?: number;
}

// ---- Added by T11: voice check (experimental); see src/voice/settings.ts ----
export interface Settings {
  voice: VoiceSettings;
}

/**
 * Current `settingsVersion`. 2 = T7: Fusion replaces Ensemble, WebGPU on by
 * default. 3 = Quick check uses TMR instead of lite, chip shows from 70%
 * (docs/calibration.md "Quick tier and false positives"). 4 = the corner
 * card is the default UI and is always present (docs/plan.md "Primary UI:
 * the corner card"): no auto-hide.
 */
export const SETTINGS_VERSION = 4;

/**
 * Default Fusion set, chosen on the T7 web eval set (docs/calibration.md):
 * Fakespot + TMR, weighted. Adding perplexity, lite or ModernBERT did not
 * improve it by 0.01 in AUROC + TPR@1% FPR.
 */
export const DEFAULT_FUSION: FusionSettings = { detectors: ["fakespot", "tmr"], method: "weighted" };

// ---- Added by the tiers task (additive only; see docs/plan.md "Two tiers:
// Quick (default) and Deep (on demand)") ----
//
// Quick is the automatic pass (cheapest detectors); Deep is the on-demand
// "run everything" pass (the ↻ button in the popup, the expanded chip/pill
// and the side panel). Both reuse the Fusion machinery (mode "ensemble")
// with their own detector set instead of `Settings.fusion`, passed per
// request (see `AnalyzeRequest`/`AnalyzeTabRequestT7.fusionOverride` in
// ./messages.ts and `fusionForTier` in ../engine/models.ts).

/** Which pass produced a result/request: the automatic Quick pass, or an on-demand Deep run. */
export type Tier = "quick" | "deep";

export interface TierSettings {
  /**
   * Detectors the automatic Quick pass uses. Default: TMR alone (on the
   * web eval set it shows >= 50% on 16% of human texts, against 41% for
   * lite, at about twice lite's cost on WebGPU; docs/calibration.md).
   */
  quickDetectors: FusionDetector[];
  /** Detectors an on-demand Deep run uses. Default: everything the registry has. */
  deepDetectors: FusionDetector[];
  /**
   * Token budget for the automatic Quick pass (and its Fusion confirmation).
   * The Quick pass is a glance: capping it keeps long pages fast, notably on
   * Firefox's single-threaded WASM. Deep always reads up to `maxTokens`.
   */
  quickMaxTokens: number;
  /** "Run quick check automatically" -- off means no automatic pass at all (Deep still runs on click). */
  autoRunQuick: boolean;
  /**
   * Re-check an AI-leaning Quick result with the Fusion set (`fusion`)
   * before showing it. Costs a Fusion run only on pages the Quick pass
   * flags; cuts human pages shown as AI (docs/calibration.md).
   */
  confirmQuick: boolean;
}

export interface Settings {
  tiers: TierSettings;
}

/** Deep's default: every detector the registry has (docs/plan.md: "Deep detectors (default: all)"). */
export const ALL_TIER_DETECTORS: FusionDetector[] = ["fakespot", "tmr", "modernbert", "lite", "perplexity", "binoculars"];

/**
 * Below this displayed P(AI) the corner card shrinks to a dim dot. 0 = never
 * (the default since v4: the card is always present, docs/plan.md "Primary
 * UI: the corner card"). The old "chip only if high" default was 0.7.
 */
export const CHIP_AUTO_HIDE_DEFAULT = 0;

export const DEFAULT_TIERS: TierSettings = {
  quickDetectors: ["tmr"],
  deepDetectors: [...ALL_TIER_DETECTORS],
  quickMaxTokens: 1024,
  autoRunQuick: true,
  confirmQuick: true,
};

export const DEFAULT_SETTINGS: Settings = {
  fusion: DEFAULT_FUSION,
  settingsVersion: SETTINGS_VERSION,
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
  // T7: WebGPU is the primary, calibrated path (docs/calibration.md); WASM
  // is the fallback where there is no adapter or no shader-f16.
  useWebGPU: true,

  presence: "statusChip",
  autoRunPolicy: "always",
  autoRunFastMode: "classifierLite",
  siteRules: {},
  pageTypes: {},
  surfaces: { popup: true, badge: true, chip: true, highlights: false, sidePanel: false },
  chipCorner: "bottom-right",
  chipAutoHideThreshold: CHIP_AUTO_HIDE_DEFAULT,

  battery: {
    onBatteryAction: "normal",
    pauseBelowPercent: 20,
    pauseOnPressure: true,
    unloadAfterMinutes: 5,
    useCpuOnBattery: false,
    manualOverride: false,
  },
  slopFilter: {
    enabled: false,
    // T7's fitted operating point (docs/calibration.md): about 1% human
    // false positives on the web eval set. User-editable from here on.
    threshold: FILTER_THRESHOLD,
    style: "dim",
    sites: { reddit: true, hackernews: true, youtube: true, twitter: true, forum: true, review: true },
    searchMarkers: true,
  },
  siteMemoryEnabled: false,
  rememberResults: true,
  voice: DEFAULT_VOICE,
  tiers: DEFAULT_TIERS,
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
  const merged: Settings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    modelOverrides: {
      ...DEFAULT_SETTINGS.modelOverrides,
      ...stored?.modelOverrides,
    },
  };
  return migrateSettings(merged, stored);
}

/**
 * One-off migrations for settings stored by older versions (T7). Pure, so
 * it is unit-testable; exported for tests only.
 */
export function migrateSettings(merged: Settings, stored: Partial<Settings> | undefined): Settings {
  const out: Settings = { ...merged, fusion: sanitizeFusion(merged.fusion), tiers: sanitizeTiers(merged.tiers) };
  // Auto-run has one control (Options > Presence > Auto-run). The old hidden
  // "Run quick check automatically" box and the never-built "ask" policy both
  // meant "off": fold them into autoRunPolicy "never" so the UI tells the truth.
  if (out.tiers.autoRunQuick === false) {
    out.autoRunPolicy = "never";
    out.tiers = { ...out.tiers, autoRunQuick: true };
  }
  if (out.autoRunPolicy === "ask") out.autoRunPolicy = "never";
  if (Object.values(out.siteRules ?? {}).includes("ask")) {
    out.siteRules = Object.fromEntries(Object.entries(out.siteRules).map(([h, p]) => [h, p === "ask" ? "never" : p]));
  }
  if (stored && (stored.settingsVersion ?? 1) < 2) {
    // v1 had no Fusion: its Ensemble was one classifier + perplexity, and
    // WebGPU was an opt-in. Carry an explicit lite choice over; everything
    // else moves to the new defaults (WebGPU on, the fitted Fusion set).
    if (!stored.fusion && stored.ensembleClassifier === "classifierLite") {
      out.fusion = { detectors: ["lite", "perplexity"], method: "weighted" };
    }
    out.useWebGPU = true;
    out.settingsVersion = SETTINGS_VERSION;
  }
  if (stored && (stored.settingsVersion ?? 1) < 3) {
    // v3: the old defaults (lite-only Quick check, chip from 35%) put a
    // number on most human pages. Move anyone still on them to the new
    // defaults; a deliberate choice is kept.
    const q = stored.tiers?.quickDetectors;
    if (!q || (q.length === 1 && q[0] === "lite")) out.tiers = { ...out.tiers, quickDetectors: [...DEFAULT_TIERS.quickDetectors] };
    if (stored.chipAutoHideThreshold === undefined || stored.chipAutoHideThreshold === 0.35) out.chipAutoHideThreshold = CHIP_AUTO_HIDE_DEFAULT;
    out.settingsVersion = SETTINGS_VERSION;
  }
  if (stored && (stored.settingsVersion ?? 1) < 4) {
    // v4: the corner card is the default UI and always present. Anyone still
    // on an old default auto-hide threshold moves to "never hide"; a
    // deliberately chosen threshold is kept.
    // (After the v3 step, so a v2 install still on 35% lands here as 0.7.)
    if (stored.chipAutoHideThreshold === undefined || out.chipAutoHideThreshold === 0.7) out.chipAutoHideThreshold = CHIP_AUTO_HIDE_DEFAULT;
    out.settingsVersion = SETTINGS_VERSION;
  }
  return out;
}

const FUSION_DETECTORS: readonly FusionDetector[] = ["fakespot", "tmr", "lite", "modernbert", "perplexity", "binoculars"];
const FUSION_METHODS: readonly FusionMethod[] = ["weighted", "logodds", "vote", "max"];

/** Drops unknown detectors/methods (e.g. from a newer version synced in), never returns an empty set. */
export function sanitizeFusion(f: Partial<FusionSettings> | undefined): FusionSettings {
  const detectors = [...new Set((f?.detectors ?? []).filter((d) => FUSION_DETECTORS.includes(d)))];
  const method = f?.method && FUSION_METHODS.includes(f.method) ? f.method : DEFAULT_FUSION.method;
  return { detectors: detectors.length ? detectors : [...DEFAULT_FUSION.detectors], method };
}

function sanitizeTierDetectors(detectors: FusionDetector[] | undefined, fallback: readonly FusionDetector[]): FusionDetector[] {
  const filtered = [...new Set((detectors ?? []).filter((d) => FUSION_DETECTORS.includes(d)))];
  return filtered.length ? filtered : [...fallback];
}

/** Drops unknown detectors (e.g. from a newer version synced in); never returns an empty set for either list. */
export function sanitizeTiers(t: Partial<TierSettings> | undefined): TierSettings {
  return {
    quickDetectors: sanitizeTierDetectors(t?.quickDetectors, DEFAULT_TIERS.quickDetectors),
    deepDetectors: sanitizeTierDetectors(t?.deepDetectors, DEFAULT_TIERS.deepDetectors),
    quickMaxTokens:
      typeof t?.quickMaxTokens === "number" && Number.isFinite(t.quickMaxTokens)
        ? Math.min(32000, Math.max(128, Math.round(t.quickMaxTokens)))
        : DEFAULT_TIERS.quickMaxTokens,
    autoRunQuick: t?.autoRunQuick ?? DEFAULT_TIERS.autoRunQuick,
    confirmQuick: t?.confirmQuick ?? DEFAULT_TIERS.confirmQuick,
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

/** The page-type override for `hostname` ("auto" when there is none). */
export function pageTypeOverrideForSite(settings: Pick<Settings, "pageTypes">, hostname: string): PageTypeOverride {
  return settings.pageTypes?.[hostname] ?? "auto";
}
