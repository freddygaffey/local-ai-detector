// Model management backend (runs in the background): check for updates via
// the Hugging Face API, update / roll back / switch to a custom repo (only
// committing the settings change after the new model has downloaded, loaded
// and run once in the inference host), delete cached files, and report cache
// sizes. All side effects go through `ManagerDeps`, so the state transitions
// are unit-testable with mocked fetch/settings/host.

import type {
  ActionResult,
  CustomModelValidation,
  ModelSlotCacheInfo,
  ModelUpdateInfo,
  ProgressEvent,
} from "../shared/messages";
import type { ModelOverride, ModelRef, ModelSlot, Settings } from "../shared/settings";
import {
  activeModel,
  DEFAULT_MODELS,
  isOpenLicense,
  MODEL_SLOTS,
  refKey,
  sameRef,
  slotTask,
} from "./models";
import type { CachedRepo } from "./protocol";

export const HF_API = "https://huggingface.co/api/models/";
const DAY_MS = 24 * 60 * 60 * 1000;
export const LAST_CHECK_KEY = "modelUpdateCheck";

export interface ManagerDeps {
  fetch: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  getSettings(): Promise<Settings>;
  setSettings(partial: Partial<Settings>): Promise<Settings>;
  host: {
    prepare(slot: ModelSlot, ref: ModelRef, onProgress?: (p: ProgressEvent) => void): Promise<unknown>;
    deleteCache(refs: ModelRef[]): Promise<{ freedBytes: number }>;
    cacheInfo(): Promise<CachedRepo[]>;
  };
  /** storage.local-like key/value store for the last update check. */
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  now(): number;
}

// ---------------- Hugging Face API ----------------

export interface RepoInfo {
  id: string;
  sha: string;
  license: string | null;
  licenseName: string | null;
  gated: boolean;
  private: boolean;
  files: { name: string; size: number | null }[];
  architectures: string[];
  modelType: string | null;
  vocabSize: number | null;
}

/** HF repo ids: "owner/name" (letters, digits, - _ .). */
export function isValidRepoId(repo: string): boolean {
  return /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/.test(repo) && !repo.includes("..");
}

export async function fetchRepoInfo(repo: string, deps: Pick<ManagerDeps, "fetch">): Promise<RepoInfo> {
  if (!isValidRepoId(repo)) throw new Error(`"${repo}" is not a Hugging Face repo id (expected owner/name)`);
  const res = await deps.fetch(`${HF_API}${repo}?blobs=true`);
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new Error(`Model "${repo}" was not found on Hugging Face (or is private).`);
  }
  if (!res.ok) throw new Error(`Hugging Face API error ${res.status} for "${repo}"`);
  const j = (await res.json()) as {
    id?: string;
    modelId?: string;
    sha?: string;
    gated?: unknown;
    private?: boolean;
    tags?: string[];
    cardData?: { license?: string | string[]; license_name?: string };
    siblings?: { rfilename: string; size?: number }[];
    config?: { architectures?: string[]; model_type?: string; vocab_size?: number };
  };
  if (!j.sha) throw new Error(`Hugging Face API returned no commit for "${repo}"`);
  let license: string | null = null;
  const cl = j.cardData?.license;
  if (typeof cl === "string") license = cl;
  else if (Array.isArray(cl) && cl.length) license = String(cl[0]);
  if (!license) {
    const tag = j.tags?.find((t) => t.startsWith("license:"));
    if (tag) license = tag.slice("license:".length);
  }
  return {
    id: j.id ?? j.modelId ?? repo,
    sha: j.sha,
    license: license ? license.toLowerCase() : null,
    licenseName: j.cardData?.license_name ?? null,
    gated: !!j.gated && j.gated !== "false",
    private: !!j.private,
    files: (j.siblings ?? []).map((s) => ({ name: s.rfilename, size: typeof s.size === "number" ? s.size : null })),
    architectures: j.config?.architectures ?? [],
    modelType: j.config?.model_type ?? null,
    vocabSize: typeof j.config?.vocab_size === "number" ? j.config.vocab_size : null,
  };
}

/**
 * Licence for a slot's model: the conversion repos (onnx-community / Xenova)
 * often carry none, so fall back to the registry's upstream licence when the
 * repo is our pinned default repo.
 */
function effectiveLicense(slot: ModelSlot, repo: string, apiLicense: string | null): string | null {
  if (apiLicense) return apiLicense;
  const spec = DEFAULT_MODELS[slot];
  return repo === spec.repo ? spec.license : null;
}

// ---------------- update check ----------------

export async function checkModelUpdates(slots: ModelSlot[] | undefined, deps: ManagerDeps): Promise<ModelUpdateInfo[]> {
  const settings = await deps.getSettings();
  const wanted = slots && slots.length ? slots : MODEL_SLOTS;
  const infoByRepo = new Map<string, Promise<RepoInfo>>();
  const out: ModelUpdateInfo[] = [];
  for (const slot of wanted) {
    const a = activeModel(slot, settings.modelOverrides);
    let p = infoByRepo.get(a.repo);
    if (!p) infoByRepo.set(a.repo, (p = fetchRepoInfo(a.repo, deps)));
    const info = await p;
    out.push({
      slot,
      repo: a.repo,
      currentRevision: a.revision,
      latestRevision: info.sha,
      license: effectiveLicense(slot, a.repo, info.license),
    });
  }
  // Only a full check updates the stored "last checked" record.
  if (!slots || slots.length === 0) {
    await deps.store.set(LAST_CHECK_KEY, { ts: deps.now(), updates: out });
  }
  return out;
}

export async function lastUpdateCheck(
  deps: Pick<ManagerDeps, "store">,
): Promise<{ ts: number; updates: ModelUpdateInfo[] } | null> {
  const v = (await deps.store.get(LAST_CHECK_KEY)) as { ts?: number; updates?: ModelUpdateInfo[] } | undefined;
  return v && typeof v.ts === "number" && Array.isArray(v.updates) ? { ts: v.ts, updates: v.updates } : null;
}

/** If auto-check is on and the last full check is over a day old, check now. */
export async function maybeAutoCheck(deps: ManagerDeps): Promise<ModelUpdateInfo[] | null> {
  const settings = await deps.getSettings();
  if (!settings.autoCheckModelUpdates) return null;
  const last = await lastUpdateCheck(deps);
  if (last && deps.now() - last.ts < DAY_MS) return null;
  return checkModelUpdates(undefined, deps);
}

// ---------------- switching models ----------------

/** The override to store when `slot` switches from `current` to `target`. */
export function switchedOverride(current: ModelRef, target: ModelRef): ModelOverride {
  return { repo: target.repo, revision: target.revision, previous: { repo: current.repo, revision: current.revision } };
}

/**
 * Old files that can be deleted after a slot switched away from `old`:
 * nothing if another slot still uses it (or it's the new target).
 */
export function refsSafeToDelete(old: ModelRef, target: ModelRef, settings: Settings, slot: ModelSlot): ModelRef[] {
  if (sameRef(old, target)) return [];
  for (const s of MODEL_SLOTS) {
    if (s === slot) continue;
    if (sameRef(activeModel(s, settings.modelOverrides), old)) return [];
  }
  return [{ repo: old.repo, revision: old.revision }];
}

async function switchSlot(
  slot: ModelSlot,
  target: ModelRef,
  deps: ManagerDeps,
  onProgress?: (p: ProgressEvent) => void,
): Promise<ActionResult> {
  const settings = await deps.getSettings();
  const current = activeModel(slot, settings.modelOverrides);
  if (sameRef(current, target)) return { ok: true };
  try {
    // Download + load + one forward pass. Settings are untouched on failure,
    // so the old model keeps working.
    await deps.host.prepare(slot, target, onProgress);
  } catch (e) {
    return { ok: false, error: `New model failed to load, kept ${refKey(current)}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const next = await deps.setSettings({ modelOverrides: { [slot]: switchedOverride(current, target) } });
  // The previous {repo, revision} stays recorded for rollback; its files are
  // deleted to save space (rollback re-downloads the pinned revision).
  const stale = refsSafeToDelete(current, target, next, slot);
  if (stale.length) await deps.host.deleteCache(stale).catch(() => undefined);
  return { ok: true };
}

export async function updateModel(
  slot: ModelSlot,
  deps: ManagerDeps,
  onProgress?: (p: ProgressEvent) => void,
): Promise<ActionResult> {
  try {
    const settings = await deps.getSettings();
    const current = activeModel(slot, settings.modelOverrides);
    const info = await fetchRepoInfo(current.repo, deps);
    if (info.gated || info.private) return { ok: false, error: `${current.repo} is now gated or private; not updating.` };
    if (info.sha === current.revision) return { ok: true };
    return await switchSlot(slot, { repo: current.repo, revision: info.sha }, deps, onProgress);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Switches back to `previous` (or to the pinned default when there is none). */
export async function rollbackModel(
  slot: ModelSlot,
  deps: ManagerDeps,
  onProgress?: (p: ProgressEvent) => void,
): Promise<ActionResult> {
  const settings = await deps.getSettings();
  const current = activeModel(slot, settings.modelOverrides);
  const spec = DEFAULT_MODELS[slot];
  const target = current.previous ?? { repo: spec.repo, revision: spec.revision };
  if (sameRef(current, target)) return { ok: false, error: "Nothing to roll back to: already on the pinned default." };
  return switchSlot(slot, target, deps, onProgress);
}

// ---------------- custom models ----------------

function onnxBaseNames(files: { name: string }[]): Map<string, Set<string>> {
  // base name -> set of dtype suffixes present, e.g. model -> {"", "_quantized", "_q4f16"}
  const out = new Map<string, Set<string>>();
  const re = /^onnx\/([A-Za-z0-9_]+?)(_quantized|_fp16|_q4f16|_q4|_int8|_uint8|_bnb4)?\.onnx$/;
  for (const f of files) {
    const m = re.exec(f.name);
    if (!m) continue;
    let s = out.get(m[1]!);
    if (!s) out.set(m[1]!, (s = new Set()));
    s.add(m[2] ?? "");
  }
  return out;
}

export async function validateCustomModel(
  slot: ModelSlot,
  repoInput: string,
  deps: ManagerDeps,
): Promise<CustomModelValidation> {
  const repo = repoInput.trim().replace(/^https?:\/\/huggingface\.co\//, "").replace(/\/+$/, "");
  try {
    const info = await fetchRepoInfo(repo, deps);
    if (info.private) return { ok: false, error: `${repo} is private.` };
    if (info.gated) return { ok: false, error: `${repo} is gated (requires accepting terms / login), which a local extension can't do.` };

    const names = new Set(info.files.map((f) => f.name));
    if (!names.has("config.json")) return { ok: false, error: `${repo} has no config.json.` };
    if (!names.has("tokenizer.json")) {
      return { ok: false, error: `${repo} has no tokenizer.json (transformers.js needs the fast-tokenizer file).` };
    }
    const task = slotTask(slot);
    const bases = onnxBaseNames(info.files);
    const candidates = task === "causal-lm" ? ["decoder_model_merged", "model"] : ["model"];
    const base = candidates.find((b) => bases.get(b)?.has("_quantized"));
    if (!base) {
      return {
        ok: false,
        error:
          bases.size === 0
            ? `${repo} has no onnx/ folder. Use a transformers.js-ready export (e.g. an onnx-community/… or Xenova/… repo).`
            : `${repo} has no 8-bit onnx/${candidates[0]}_quantized.onnx, which the WASM backend needs.`,
      };
    }

    const arch = info.architectures;
    if (arch.length) {
      const ok =
        task === "text-classification"
          ? arch.some((a) => /ForSequenceClassification$/.test(a))
          : arch.some((a) => /(ForCausalLM|LMHeadModel)$/.test(a));
      if (!ok) {
        return {
          ok: false,
          error: `${repo} is a ${arch.join(", ")}, but the ${slot} slot needs a ${
            task === "text-classification" ? "sequence-classification" : "causal language"
          } model.`,
        };
      }
    }

    const warnings: string[] = [];
    if (!arch.length) warnings.push("Couldn't read the model architecture from the Hub; it will be checked when it loads.");
    const license = info.license;
    const openLicense = isOpenLicense(license);
    if (!license) warnings.push("No licence declared. You may not have the right to use these weights.");
    else if (!openLicense) {
      warnings.push(
        `Licence "${info.licenseName ?? license}" is not on our open-licence list; check its terms before use.`,
      );
    }
    const sfx = bases.get(base)!;
    if (!sfx.has("_q4f16") && !sfx.has("_fp16")) {
      warnings.push("No fp16/q4f16 weights, so this model will run on WASM even when WebGPU is available.");
    }
    if (task === "text-classification") {
      warnings.push("The score assumes class index 1 (or a label named like 'ai'/'fake'/'machine') means AI-written.");
    }
    if (slot === "binocularsObserver" || slot === "binocularsPerformer") {
      const otherSlot: ModelSlot = slot === "binocularsObserver" ? "binocularsPerformer" : "binocularsObserver";
      const settings = await deps.getSettings();
      const other = activeModel(otherSlot, settings.modelOverrides);
      try {
        const otherInfo = await fetchRepoInfo(other.repo, deps);
        if (info.vocabSize && otherInfo.vocabSize && info.vocabSize !== otherInfo.vocabSize) {
          warnings.push(
            `Vocabulary size ${info.vocabSize} differs from the ${otherSlot} model (${otherInfo.vocabSize}); Binoculars needs both to share a tokenizer and will refuse to run.`,
          );
        }
      } catch {
        // best effort
      }
    }

    const sizeOf = (n: string) => info.files.find((f) => f.name === n)?.size ?? 0;
    const weights = `onnx/${base}_quantized.onnx`;
    const sizeBytes =
      sizeOf(weights) + sizeOf(`${weights}_data`) + sizeOf("tokenizer.json") + sizeOf("tokenizer_config.json") + sizeOf("config.json");

    return {
      ok: true,
      repo: info.id,
      revision: info.sha,
      license,
      openLicense,
      warnings,
      sizeBytes: sizeBytes > 0 ? sizeBytes : null,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function setCustomModel(
  slot: ModelSlot,
  repo: string,
  deps: ManagerDeps,
  onProgress?: (p: ProgressEvent) => void,
): Promise<{ ok: true; license: string | null } | { ok: false; error: string }> {
  const v = await validateCustomModel(slot, repo, deps);
  if (!v.ok) return v;
  const r = await switchSlot(slot, { repo: v.repo, revision: v.revision }, deps, onProgress);
  return r.ok ? { ok: true, license: v.license } : r;
}

// ---------------- cache ----------------

export async function deleteCachedModel(
  slot: ModelSlot,
  deps: ManagerDeps,
): Promise<{ ok: true; freedBytes: number } | { ok: false; error: string }> {
  try {
    const settings = await deps.getSettings();
    const a = activeModel(slot, settings.modelOverrides);
    const refs: ModelRef[] = [{ repo: a.repo, revision: a.revision }];
    // Don't delete files another slot is actively using.
    const usedElsewhere = MODEL_SLOTS.some(
      (s) => s !== slot && sameRef(activeModel(s, settings.modelOverrides), refs[0]),
    );
    if (usedElsewhere) return { ok: true, freedBytes: 0 };
    const { freedBytes } = await deps.host.deleteCache(refs);
    return { ok: true, freedBytes };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Per-slot cache size for the active model, plus the total of everything cached. */
export async function modelCacheInfo(
  deps: ManagerDeps,
): Promise<{ slots: Partial<Record<ModelSlot, ModelSlotCacheInfo>>; totalBytes: number }> {
  const settings = await deps.getSettings();
  const repos = await deps.host.cacheInfo();
  const slots: Partial<Record<ModelSlot, ModelSlotCacheInfo>> = {};
  for (const slot of MODEL_SLOTS) {
    const a = activeModel(slot, settings.modelOverrides);
    const hit = repos.find((r) => r.repo === a.repo && r.revision === a.revision);
    // "cached" means the ONNX weights are there, not just config/tokenizer files.
    slots[slot] = { cached: !!hit && hit.bytes > 1_000_000, sizeBytes: hit?.bytes ?? 0 };
  }
  const totalBytes = repos.reduce((a, r) => a + r.bytes, 0);
  return { slots, totalBytes };
}
