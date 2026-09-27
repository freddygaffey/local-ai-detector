import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ModelRef, type ModelSlot, type Settings } from "../shared/settings";
import {
  checkModelUpdates,
  deleteCachedModel,
  maybeAutoCheck,
  modelCacheInfo,
  refsSafeToDelete,
  rollbackModel,
  setCustomModel,
  updateModel,
  validateCustomModel,
  type ManagerDeps,
} from "./model-manager";
import { activeModel, DEFAULT_MODELS } from "./models";
import type { CachedRepo } from "./protocol";

const CLS = DEFAULT_MODELS.classifier;
const NEW_SHA = "1111111111111111111111111111111111111111";

type ApiModel = Record<string, unknown>;

function apiModel(repo: string, sha: string, extra: Partial<ApiModel> = {}): ApiModel {
  return {
    id: repo,
    sha,
    gated: false,
    private: false,
    cardData: { license: "mit" },
    siblings: [
      { rfilename: "config.json", size: 900 },
      { rfilename: "tokenizer.json", size: 2_000_000 },
      { rfilename: "onnx/model.onnx", size: 400_000_000 },
      { rfilename: "onnx/model_quantized.onnx", size: 100_000_000 },
      { rfilename: "onnx/model_q4f16.onnx", size: 90_000_000 },
    ],
    config: { architectures: ["RobertaForSequenceClassification"], model_type: "roberta" },
    ...extra,
  };
}

interface Harness {
  deps: ManagerDeps;
  settings: Settings;
  store: Map<string, unknown>;
  api: Map<string, ApiModel | number>;
  prepare: ReturnType<typeof vi.fn>;
  deleteCache: ReturnType<typeof vi.fn>;
  cached: CachedRepo[];
  now: number;
}

function harness(): Harness {
  const h = {} as Harness;
  h.settings = structuredClone(DEFAULT_SETTINGS);
  h.store = new Map();
  h.api = new Map();
  h.cached = [];
  h.now = 1_000_000_000_000;
  for (const spec of Object.values(DEFAULT_MODELS)) h.api.set(spec.repo, apiModel(spec.repo, spec.revision));
  h.prepare = vi.fn(async () => ({ device: "wasm", dtype: "q8" }));
  h.deleteCache = vi.fn(async (refs: ModelRef[]) => ({ freedBytes: refs.length * 100 }));
  h.deps = {
    fetch: vi.fn(async (url: string) => {
      const repo = decodeURIComponent(url.replace("https://huggingface.co/api/models/", "").replace(/\?.*$/, ""));
      const v = h.api.get(repo);
      if (typeof v === "number" || v === undefined) {
        const status = typeof v === "number" ? v : 404;
        return { ok: false, status, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => structuredClone(v) };
    }),
    getSettings: async () => structuredClone(h.settings),
    setSettings: async (partial) => {
      h.settings = {
        ...h.settings,
        ...partial,
        modelOverrides: { ...h.settings.modelOverrides, ...partial.modelOverrides },
      };
      return structuredClone(h.settings);
    },
    host: {
      prepare: h.prepare as ManagerDeps["host"]["prepare"],
      deleteCache: h.deleteCache as ManagerDeps["host"]["deleteCache"],
      cacheInfo: async () => h.cached,
    },
    store: {
      get: async (k) => h.store.get(k),
      set: async (k, v) => {
        h.store.set(k, v);
      },
    },
    now: () => h.now,
  };
  return h;
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("checkModelUpdates", () => {
  it("reports current vs latest revision and licence for every slot, and records the check", async () => {
    h.api.set(CLS.repo, apiModel(CLS.repo, NEW_SHA));
    h.api.set(DEFAULT_MODELS.perplexityLM.repo, apiModel(DEFAULT_MODELS.perplexityLM.repo, DEFAULT_MODELS.perplexityLM.revision, { cardData: {} }));
    const res = await checkModelUpdates(undefined, h.deps);
    expect(res).toHaveLength(5);
    const cls = res.find((r) => r.slot === "classifier")!;
    expect(cls).toMatchObject({ repo: CLS.repo, currentRevision: CLS.revision, latestRevision: NEW_SHA, license: "mit" });
    // Conversion repo with no licence tag falls back to the upstream licence.
    expect(res.find((r) => r.slot === "perplexityLM")!.license).toBe("apache-2.0");
    expect((h.store.get("modelUpdateCheck") as { ts: number }).ts).toBe(h.now);
  });

  it("maybeAutoCheck: off by default, at most daily when on", async () => {
    expect(await maybeAutoCheck(h.deps)).toBeNull();
    h.settings.autoCheckModelUpdates = true;
    expect(await maybeAutoCheck(h.deps)).toHaveLength(5);
    h.now += 60 * 60 * 1000;
    expect(await maybeAutoCheck(h.deps)).toBeNull();
    h.now += 24 * 60 * 60 * 1000;
    expect(await maybeAutoCheck(h.deps)).toHaveLength(5);
  });
});

describe("updateModel / rollbackModel", () => {
  it("switches only after the new revision loads, keeps previous for rollback, deletes old files", async () => {
    h.api.set(CLS.repo, apiModel(CLS.repo, NEW_SHA));
    const r = await updateModel("classifier", h.deps);
    expect(r).toEqual({ ok: true });
    expect(h.prepare).toHaveBeenCalledWith("classifier", { repo: CLS.repo, revision: NEW_SHA }, undefined);
    expect(h.settings.modelOverrides.classifier).toEqual({
      repo: CLS.repo,
      revision: NEW_SHA,
      previous: { repo: CLS.repo, revision: CLS.revision },
    });
    expect(h.deleteCache).toHaveBeenCalledWith([{ repo: CLS.repo, revision: CLS.revision }]);
  });

  it("is a no-op when already on the latest revision", async () => {
    expect(await updateModel("classifier", h.deps)).toEqual({ ok: true });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.settings.modelOverrides.classifier).toBeUndefined();
  });

  it("keeps the old model when the new one fails to load", async () => {
    h.api.set(CLS.repo, apiModel(CLS.repo, NEW_SHA));
    h.prepare.mockRejectedValueOnce(new Error("bad onnx"));
    const r = await updateModel("classifier", h.deps);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/bad onnx/);
    expect(h.settings.modelOverrides.classifier).toBeUndefined();
    expect(h.deleteCache).not.toHaveBeenCalled();
  });

  it("refuses to update to a repo that became gated", async () => {
    h.api.set(CLS.repo, apiModel(CLS.repo, NEW_SHA, { gated: "manual" }));
    const r = await updateModel("classifier", h.deps);
    expect(r.ok).toBe(false);
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it("rollback swaps back to previous (and can swap forward again)", async () => {
    h.api.set(CLS.repo, apiModel(CLS.repo, NEW_SHA));
    await updateModel("classifier", h.deps);
    expect(await rollbackModel("classifier", h.deps)).toEqual({ ok: true });
    expect(activeModel("classifier", h.settings.modelOverrides)).toMatchObject({ revision: CLS.revision, isDefault: true });
    expect(h.settings.modelOverrides.classifier!.previous).toEqual({ repo: CLS.repo, revision: NEW_SHA });
    expect(await rollbackModel("classifier", h.deps)).toEqual({ ok: true });
    expect(h.settings.modelOverrides.classifier!.revision).toBe(NEW_SHA);
  });

  it("rollback with nothing to roll back to is an error", async () => {
    const r = await rollbackModel("classifier", h.deps);
    expect(r.ok).toBe(false);
  });

  it("rollback of a custom model without `previous` returns to the pinned default", async () => {
    h.settings.modelOverrides.classifier = { repo: "someone/custom", revision: "abc" };
    expect(await rollbackModel("classifier", h.deps)).toEqual({ ok: true });
    expect(activeModel("classifier", h.settings.modelOverrides).isDefault).toBe(true);
  });

  it("does not delete files another slot still uses", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const shared = { repo: "x/y", revision: "r1" };
    settings.modelOverrides.binocularsObserver = { ...shared };
    expect(refsSafeToDelete(shared, { repo: "x/y", revision: "r2" }, settings, "binocularsPerformer")).toEqual([]);
    expect(refsSafeToDelete(shared, { repo: "x/y", revision: "r2" }, settings, "binocularsObserver")).toEqual([shared]);
    expect(refsSafeToDelete(shared, shared, settings, "binocularsObserver")).toEqual([]);
  });
});

describe("validateCustomModel / setCustomModel", () => {
  const REPO = "someone/my-detector-ONNX";

  it("accepts a transformers.js classifier export and reports licence + size", async () => {
    h.api.set(REPO, apiModel(REPO, NEW_SHA));
    const v = await validateCustomModel("classifier", ` https://huggingface.co/${REPO}/ `, h.deps);
    expect(v).toMatchObject({ ok: true, repo: REPO, revision: NEW_SHA, license: "mit", openLicense: true });
    expect(v.ok && v.sizeBytes).toBe(100_000_000 + 2_000_000 + 900);
  });

  it("rejects missing, gated, non-ONNX and wrong-task repos", async () => {
    expect(await validateCustomModel("classifier", "nobody/missing", h.deps)).toMatchObject({ ok: false });
    expect(await validateCustomModel("classifier", "not a repo", h.deps)).toMatchObject({ ok: false });
    h.api.set(REPO, apiModel(REPO, NEW_SHA, { gated: "auto" }));
    expect(await validateCustomModel("classifier", REPO, h.deps)).toMatchObject({ ok: false, error: expect.stringMatching(/gated/) });
    h.api.set(REPO, apiModel(REPO, NEW_SHA, { siblings: [{ rfilename: "config.json" }, { rfilename: "tokenizer.json" }, { rfilename: "model.safetensors" }] }));
    expect(await validateCustomModel("classifier", REPO, h.deps)).toMatchObject({ ok: false, error: expect.stringMatching(/onnx/) });
    h.api.set(REPO, apiModel(REPO, NEW_SHA));
    expect(await validateCustomModel("perplexityLM", REPO, h.deps)).toMatchObject({ ok: false, error: expect.stringMatching(/causal/) });
  });

  it("warns (but allows) non-open or missing licences", async () => {
    h.api.set(REPO, apiModel(REPO, NEW_SHA, { cardData: { license: "other", license_name: "research-only" } }));
    const v = await validateCustomModel("classifier", REPO, h.deps);
    expect(v.ok).toBe(true);
    expect(v.ok && v.openLicense).toBe(false);
    expect(v.ok && v.warnings.join(" ")).toMatch(/research-only/);
    h.api.set(REPO, apiModel(REPO, NEW_SHA, { cardData: {} }));
    const v2 = await validateCustomModel("classifier", REPO, h.deps);
    expect(v2.ok && v2.warnings.join(" ")).toMatch(/No licence/);
  });

  it("takes the licence of the model an unlicensed ONNX conversion quantizes (tagged only)", async () => {
    h.api.set("upstream/detector", apiModel("upstream/detector", NEW_SHA, { cardData: { license: "mit" } }));
    h.api.set(REPO, apiModel(REPO, NEW_SHA, { cardData: {}, tags: ["base_model:quantized:upstream/detector"] }));
    const v = await validateCustomModel("classifier", REPO, h.deps);
    expect(v).toMatchObject({ ok: true, license: "mit", openLicense: true });
    expect(v.ok && v.warnings.join(" ")).toMatch(/declares no licence.*upstream\/detector/);
    // A fine-tune (base_model:finetune:…) does NOT inherit its base's licence.
    h.api.set(REPO, apiModel(REPO, NEW_SHA, { cardData: {}, tags: ["base_model:finetune:upstream/detector"] }));
    expect(await validateCustomModel("classifier", REPO, h.deps)).toMatchObject({ ok: true, license: null, openLicense: false });
  });

  it("accepts a causal LM with a merged decoder for the perplexity slot", async () => {
    h.api.set(REPO, apiModel(REPO, NEW_SHA, {
      siblings: [
        { rfilename: "config.json" },
        { rfilename: "tokenizer.json" },
        { rfilename: "onnx/decoder_model_merged_quantized.onnx", size: 80 },
      ],
      config: { architectures: ["GPT2LMHeadModel"] },
    }));
    expect(await validateCustomModel("perplexityLM", REPO, h.deps)).toMatchObject({ ok: true });
  });

  it("setCustomModel pins the repo's current SHA after it loads", async () => {
    h.api.set(REPO, apiModel(REPO, NEW_SHA));
    const r = await setCustomModel("classifierLite", REPO, h.deps);
    expect(r).toEqual({ ok: true, license: "mit" });
    const lite = DEFAULT_MODELS.classifierLite;
    expect(h.settings.modelOverrides.classifierLite).toEqual({
      repo: REPO,
      revision: NEW_SHA,
      previous: { repo: lite.repo, revision: lite.revision },
    });
  });
});

describe("cache management", () => {
  it("deleteCachedModel deletes the active ref's files and reports freed bytes", async () => {
    const r = await deleteCachedModel("classifier", h.deps);
    expect(r).toEqual({ ok: true, freedBytes: 100 });
    expect(h.deleteCache).toHaveBeenCalledWith([{ repo: CLS.repo, revision: CLS.revision }]);
  });

  it("modelCacheInfo maps cached repos to slots and totals everything", async () => {
    h.cached = [
      { repo: CLS.repo, revision: CLS.revision, bytes: 130_000_000, files: 4 },
      { repo: "old/thing", revision: "zzz", bytes: 5_000_000, files: 2 },
    ];
    const info = await modelCacheInfo(h.deps);
    expect(info.slots.classifier).toEqual({ cached: true, sizeBytes: 130_000_000 });
    expect(info.slots.perplexityLM).toEqual({ cached: false, sizeBytes: 0 });
    expect(info.totalBytes).toBe(135_000_000);
    const slots = Object.keys(info.slots) as ModelSlot[];
    expect(slots).toHaveLength(5);
  });
});
