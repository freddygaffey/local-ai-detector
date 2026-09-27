# Implementation plan

Free, open-source (MIT), fully local AI-content detector for Chrome and Firefox (MV3).
The research behind it is in [feasibility.md](feasibility.md) and [watermarks.md](watermarks.md).
Accuracy is **not** the goal. The goals are open licences, privacy, and honest UI.

## Decisions (from the user)
- Everything runs locally, with no APIs, keys or cost. Models download once from Hugging Face.
- **Detector mode is a setting:** Ensemble (default), Classifier, Classifier-lite, Perplexity,
  Binoculars (experimental).
- **Highlight style is a setting:** Heatmap (default), Flagged-only (Ctrl+F style), Underline.
- A hidden-Unicode scan always runs (`src/detectors/unicode.ts`, already done).
- Provenance and watermarks for page images: scope comes from watermarks.md.
- A floating in-page pill shows progress, then the score, with ▲/▼ to step through flagged
  sentences and ✕ to clear. The toolbar badge shows a spinner, then the %.
- Packaging: store-ready Chrome zip, Firefox zip, AMO sources zip. **No publishing or signing
  by the agent.** The user runs those commands.
- Subagent models: Opus for ML and provenance, Sonnet for scaffold, UI and packaging.

## Architecture
```
content script (extract text → sentences; render highlights, pill, tooltips, image badges)
   │  runtime messages (src/shared/messages.ts)
   ▼
background (Chrome: service worker, Firefox: event page) — router, badge, settings
   │
   ▼
inference host (Chrome: offscreen document, Firefox: dedicated Worker from event page)
   transformers.js 4.x + bundled ORT wasm (public/ort/, wasmPaths set, never CDN)
   WebGPU if available, else WASM (Chrome multithreaded via COEP/COOP, Firefox 1 thread)
popup: gauge, mode, style, run button, download consent + progress
options: all settings, model cache management, About + licences
```
Models are pinned by repo revision in `src/engine/models.ts`. They are cached through the Cache
API, with an IndexedDB fallback.

## Shared contract (written in T0, and other tasks must not change it without the lead)
`src/shared/messages.ts` and `src/shared/settings.ts`:
- `TextBlock { id: string; text: string; sentences: {start:number; end:number}[] }`
- `AnalyzeRequest { tabId; mode; blocks: TextBlock[] }`
- `SentenceScore { blockId; index; score: number /*0..1 AI*/; sources: Partial<Record<'classifier'|'perplexity'|'binoculars', number>> }`
- Progress events `{ phase:'download'|'load'|'analyze', loaded, total, message }`
- `AnalyzeResult { overall: number; sentences: SentenceScore[]; unicode: UnicodeScanResult; tooLong?: boolean; notes: string[] }`
- `Settings { mode; highlightStyle; autoRun: boolean; minWords: number; maxTokens: number; showUnicode: boolean; checkImages: boolean; consentedDownload: boolean }`

## Tasks
| # | Task | Owner model | Depends on | Owns paths |
|---|---|---|---|---|
| T0 | WXT scaffold, manifest (both browsers), CSP, COEP/COOP, ORT copy step, shared types, settings store, vitest (port unicode test), all deps preinstalled | Sonnet | – | package.json, wxt.config.ts, src/shared/**, entrypoint stubs, public/ort |
| T1 | Inference engine: host per browser, model registry, classifier / perplexity / binoculars / ensemble, chunking, sentence mapping, progress, cache fallback, device selection | Opus | T0 | src/engine/**, entrypoints/offscreen*, inference worker |
| T2 | Content script: visible-text extraction, sentence segmentation, 3 highlight styles, Unicode markers, floating pill + navigation, tooltips (Shadow DOM, no page CSS leakage) | Sonnet | T0 | entrypoints/content/**, src/content/** |
| T3 | Popup + options UI: gauge, mode/style selects, consent + download progress, cache management, About/licences, badge updates in background | Sonnet | T0 | entrypoints/popup/**, entrypoints/options/**, src/ui/** |
| T4 | Provenance and watermarks: image metadata/C2PA/etc. per watermarks.md, image badges | Opus | T0, research | src/provenance/** |
| T5 | Integration + QA: wire it all together, run in real Chrome and Firefox, fix bugs, sanity-calibrate thresholds on a small sample | Opus | T1–T4 | cross-cutting |
| T6 | Packaging + docs: `npm run package` → chrome zip, firefox zip, sources zip; icons; README (honest accuracy section), PRIVACY.md, THIRD_PARTY.md, LICENSE (MIT), store listing text, load/sign instructions | Sonnet | T5 | root docs, scripts/ |

T1–T4 run in parallel after T0. Each task commits only its own paths locally and never pushes.
Only T0 edits package.json. Later tasks ask the lead if they need a dependency.

## Out of scope for v1
Remote APIs, SynthID (needs Google keys), non-English calibration, and store publishing
(done by the user).
