# QA report (T5: integration + real-browser testing)

Date: 2026-09-27. Machine: Apple Silicon Mac (macOS), 4 ORT threads.
Browsers: Chrome for Testing 153.0.8010.12 (Playwright's build, driven by
puppeteer-core) and Firefox 156.0.1 (Selenium + geckodriver). All runs used
**real model downloads from Hugging Face** in throwaway profiles under the
scratchpad. The user's own browser profile was never touched.

## How to rerun

```sh
npm run build:e2e && node scripts/e2e/chrome.mjs --shots docs/screenshots          # full Chrome suite (e2e build)
npm run build && node scripts/e2e/chrome.mjs --prod --quick --fresh --ext .output/chrome-mv3 --profile /tmp/p
npm run build:e2e:firefox && node scripts/e2e/firefox.mjs --full                   # Firefox suite
node scripts/compare-classifiers.mjs                                              # Node: TMR vs lite (+ MAGE sample)
node scripts/e2e/browser-calibration.mjs                                          # in-browser calibration, WASM vs WebGPU
node scripts/e2e/server.mjs 8765                                                   # fixture pages for manual testing
```

Set `LAD_SCRATCH=<dir>` to keep profiles and reports out of `node_modules/.cache`.
Each run writes a JSON report (steps, timings, engine facts, console, network hosts).

**E2E-only build mode** (`wxt build --mode e2e`, outputs `*-e2e`). It differs from
production in two ways, and neither ships:
1. It adds `http://localhost/*` host access, so image provenance can be tested
   without the optional-permission prompt. Automation can't click that prompt.
2. It adds `src/e2e/bridge.ts`, a page ↔ content-script ↔ background bridge. Firefox's
   WebDriver refuses to navigate to or script `moz-extension://` pages, so the
   Firefox suite drives the extension through the same content → background
   path the in-page pill uses. We checked that the production bundles don't contain it
   (`grep __ladE2E .output/{chrome,firefox}-mv3` finds nothing).

Native context menus can't be clicked by automation. The Chrome suite calls the
menu's own handler through `globalThis.__ladContextMenuSelection` in the
service worker. Firefox calls the same handler through the bridge.

## Results

| Suite | Result |
|---|---|
| Chrome, e2e build, full (5 modes, cold + warm, WebGPU vs WASM, options) | **28/28** |
| Chrome, **production build**, fresh profile (consent → real download → 4 modes) | **19/19** |
| Firefox, e2e build, full (5 modes incl. Binoculars) | **19/19** |
| `npm run typecheck`, `npm test` (223 tests, 21 files, incl. happy-dom DOM tests), both builds | green |
| `web-ext lint` (Firefox build) | 0 errors, 2 warnings (justified below) |

### What was verified, per browser

| Check | Chrome | Firefox |
|---|---|---|
| Consent screen → "Download & enable" → first real download | ✅ popup (prod build, fresh profile) | ✅ (settings via bridge) |
| Analyze page in ensemble / classifier / classifier-lite / perplexity / binoculars | ✅ all 5, non-degenerate scores | ✅ all 5 |
| Highlights rendered via CSS Custom Highlight API | ✅ | ✅ |
| Live style switch heatmap → flagged → underline (from popup/settings) | ✅ | ✅ |
| Pill: done state, ▼/▲ scrolls and counts, ✕ clears highlights, markers **and image badges** | ✅ | ✅ (clear via settings path; the pill's closed shadow DOM isn't clickable by WebDriver) |
| Pill "Scan page" → same background path as popup | ✅ | n/a (same message as bridge) |
| Selection analysis (context-menu handler), incl. selection inside a single text node | ✅ | ✅ |
| SPA `pushState` navigation clears stale highlights; pill offers "Scan again" | ✅ | manual |
| Hidden-Unicode markers (ZW + tag characters grouped: `⟦TAG×11⟧`), no split surrogates | ✅ | ✅ |
| Image provenance: C2PA (c2pa-rs `CA.jpg`: Valid, signer "C2PA Signer", **untrusted** test CA, correctly not "trusted"), SD invisible watermark, unsigned IPTC claim, badges, popup summary | ✅ | ✅ |
| **c2pa-web worker workaround (non-https workerSrc)** | ✅ works in the offscreen doc | ✅ works from the event page |
| Cross-origin image without permission → "permission needed" + popup "Allow image checks on …" button | ✅ (e2e: 127.0.0.1; prod: every image, nothing fetched) | ⚠ Firefox auto-granted it for the temporary add-on, so not exercised |
| Options: renders, engine line, cache size, "Check for updates", custom-model validation | ✅ | ✅ renders (screenshot), update check via message |
| Custom-model validation: `onnx-community/roberta-base-openai-detector-ONNX` → MIT (inherited from the model it converts, with a note); `onnx-community/chatgpt-detector-roberta-ONNX` → no licence, warning; missing repo → rejected | ✅ | – |
| Event-page keep-alive during long downloads | n/a | ✅ Ensemble download took 32 s with the idle timeout set to 20 s; the event page's in-memory tab status survived |
| Console errors from extension contexts | none (only a 404 for `/favicon.ico` on about:blank) | none (0 lines in Firefox stdout) |

### Engine facts (`getEngineInfo`)

| | Chrome 153 | Firefox 156 |
|---|---|---|
| Device | WASM by default. WebGPU (shader-f16) is detected and is opt-in | WASM |
| ORT threads | 4 | 1 |
| `crossOriginIsolated` (offscreen doc / worker) | true | false (expected: no COEP/COOP for extension pages) |
| Model cache | Cache API | Cache API (in the module worker) |
| `storage.persist()` | false (not granted in headless) | n/a in a worker |
| Inference host | offscreen document (`WORKERS`) | module Worker from the event page (loads fine despite WXT's IIFE `import.meta` warning) |

### Network (Chrome `--log-net-log`, whole browser)

Hosts contacted by the extension: `huggingface.co`, `us.aws.cdn.hf.co` (Hugging Face's
redirect target), and the local fixture server. There were **no requests to
cdn.jsdelivr.net** or anywhere else. Other hosts in the log (`www.google.com`,
`update.googleapis.com`, `accounts.google.com`, …) come from Chrome itself in a fresh profile.
The jsDelivr fallback string is also **gone from the bundle**: a Vite transform in
`wxt.config.ts` rewrites it to an inert path.

## Timings

Cold means download + load + analyze on a fresh profile. Warm means the models are already loaded and
the page hasn't been analyzed yet (the engine caches results per text).
Page: `news.html` (~730 words, 47 sentences); warm page: `blog.html` (35 sentences).

| Mode | First download | Chrome cold (prod, fresh) | Chrome warm (WASM, 4 threads) | Firefox cold | Firefox warm (1 thread) |
|---|---|---|---|---|---|
| Ensemble (TMR + DistilGPT-2) | 216 MB | 29.1 s | ~2.6 s | 32.3 s | ~6.6 s |
| Classifier (TMR) | (shared with ensemble) | 1.7 s | ~1.2 s | 4.2 s | ~3.0 s |
| Classifier-lite | 35 MB | 6.0 s | ~0.35 s | 9.3 s | ~0.8 s |
| Perplexity | (shared) | 2.2 s | ~1.5 s | 5.2 s | ~3.6 s |
| Binoculars (2 × SmolLM2 q8, WASM) | 279 MB | ~41 s | ~8.2 s | 50.3 s | ~18 s |

Model load from cache after a browser restart: ~2–5 s for ensemble (Chrome), ~13 s for Binoculars.
Download speed was about 8–10 MB/s. WebGPU (opt-in) was 5–13× faster on bulk runs
(e.g. 650 texts: TMR 21 s on WebGPU against 278 s on WASM), but see below.
Firefox timings were measured while Chrome runs shared the CPU. Treat them as upper
bounds.

## Findings and fixes

Bugs found in the real browsers (or while wiring things together) and fixed:

1. **Three analysis paths → one.** Popup, pill/autoRun and the context menu each
   extracted and rendered on their own. Now they all go through `analyzeTab` →
   `runTabAnalysis` in the background (extract → analyze → render). The pill follows
   `analysisStatus` events. Tabs that were open before the extension was installed get
   the content script injected on demand.
2. **Duplicate offscreen-document creation** (engine and provenance) merged into
   `src/engine/offscreen.ts`: one creator and one retry policy.
3. **`AnalyzeResult.images` was never filled.** The content script now summarises T4's
   real results (`summarizeImageResults`) and reports them. The popup shows the summary and a
   per-site "Allow image checks on …" button (calls `permissions.request` from the click).
4. **Binoculars on WebGPU was broken.** q4f16 gave uniform logits, so every unit scored exactly
   1.0 (p = 0.142). Binoculars is now WASM q8 only.
5. **Scores depend on the runtime.** Browser WASM ≠ Node, and WebGPU differs more. The engine was
   re-calibrated on the browser itself. WASM is the default (same scores in Chrome and Firefox),
   and WebGPU is opt-in with its own constants. See [calibration.md](calibration.md).
6. Popup and pill disagreed on the flagged count (0.65 vs 0.6). There is now one shared scale
   (`src/shared/thresholds.ts`).
7. Every sentence under `minWords` was drawn "muted", so nearly the whole page was, although scores
   are per group of sentences. Now only a whole analysis under `minWords` is muted.
8. Selection inside a single text node extracted nothing (TreeWalker rooted at a text node).
9. Unicode markers split surrogate pairs for tag characters and VS-supplement characters, and emitted one
   marker per character. They are now grouped (`⟦TAG×11⟧`) and UTF-16-correct.
10. The highlight style changed in the popup/options didn't restyle the page. The pill's
    style picker didn't persist. Both fixed.
11. `<mark>` fallback: an inline `all: revert` wiped its own colours. It now wraps in
    reverse order, so it doesn't depend on live-range fix-ups.
12. `senderTabId` was set for extension pages opened as tabs. Now it is set for content scripts
    only.
13. The popup declared tabs "unsupported" when their URL wasn't visible to it. `getEngineInfo`
    reported WebGPU while analyses would run on WASM.
14. Custom models: unlicensed ONNX conversions now show the licence of the model they
    quantize (tag `base_model:quantized:`), labelled as inherited. Fine-tunes don't inherit.
15. Firefox manifest: `strict_min_version` is 140 (optional host permissions, CSS highlights,
    data consent), `data_collection_permissions: none`, and Android 142. The offscreen page is Chrome-only
    and the inference worker Firefox-only.
16. Options now lists `UNCHECKABLE_SCHEMES` (with checker links) and uses
    `requestImagePermission()`.

New settings (Options): **Ensemble classifier** (TMR default, lite optional) and **Use
the GPU (WebGPU)** (off by default).

Classifier decision: the ensemble keeps **TMR**. It ranks better on held-out data
(MAGE AUROC 0.91 against 0.84 in the browser) and flags far fewer human texts. Full reasoning is in
[calibration.md](calibration.md#which-classifier-the-ensemble-uses).

## `web-ext lint` warnings (justified)

- `DANGEROUS_EVAL` in `ort/ort-wasm-simd-threaded.asyncify.mjs`: Emscripten embind's
  `new Function` in ONNX Runtime's vendored glue. The extension CSP (`script-src 'self'
  'wasm-unsafe-eval'`) blocks it anyway, and that code path isn't used.
- `UNSAFE_VAR_ASSIGNMENT` (dynamic `import()`) in `inference-worker.js`: ORT loading its
  own bundled `.mjs` glue from `moz-extension://…/ort/`, never a remote URL.

## Known issues / not covered

- **Accuracy is limited, on purpose conservative.** The default ensemble flags ~1% of
  MAGE human texts and 3/28 calibration human texts (all modern US-government prose), and it
  catches only ~46% of MAGE AI texts. Paraphrased or humanised text will mostly pass.
- WebGPU is opt-in. Its calibration is less tested, and its per-page scores differ from WASM by up to ~0.1.
- Multi-range selections (Firefox table-cell selection) only use the first range.
- The pill's and badges' closed shadow DOM is clicked by coordinates in Chrome (CDP pierce).
  WebDriver can't reach it in Firefox, so the Firefox pill UI is covered by the manual checklist.
- `storage.persist()` isn't granted in headless Chrome. It's untested headed.
- Chrome keeps an unpacked extension's service-worker script across restarts while the version is
  unchanged. During development, reload the extension after rebuilding (the E2E suite clears the
  SW script cache).
- T6 still has to replace the placeholder LICENSE files for `onnxruntime-web` and `c2pa-text`.
- The C2PA sample (`CA.jpg`) is signed by a test CA. A trust-list-signed real-world image
  wasn't tested, because no permissively licensed one was at hand and `c2patool` isn't installed.

## Manual Firefox checklist (what automation can't reach)

Load `.output/firefox-mv3` via `about:debugging` → This Firefox → Load Temporary Add-on
(or `npx web-ext run -s .output/firefox-mv3`), then check:

1. Toolbar popup on `http://localhost:8765/news.html` (`node scripts/e2e/server.mjs`):
   consent screen, then "Download & enable", then progress bar with MB, then gauge + verdict.
2. The pill: ▶ Scan page, ▲/▼ scroll to flagged sentences, style picker, ⓘ, ✕ clears
   highlights and image badges. Hover tooltips on sentences and on `⟦ZW⟧` markers.
3. Right-click a selection → "Check selected text for AI writing" highlights only
   the selection.
4. SPA: on `spa.html`, click "Remote work" after analyzing. Highlights clear and the pill says
   "Page changed".
5. Image badges on `news.html`: "CR" on the photo, "SD watermark" on the second image,
   "AI claim" on the third. Hover cards say "no signals ≠ human-made".
6. Permission prompt: in a normal (non-temporary) install, the 127.0.0.1 image should ask
   for permission via the popup button.
7. Options: Check for updates, the custom-model "Check licence" warnings, cache size and Delete cache,
   and the WebGPU toggle.
8. Private window: allow the add-on in private windows, analyze a page, and confirm no errors.
   The models come from the same cache, because inference runs in the extension's
   non-private worker.
9. Leave the browser idle for over 30 s, then analyze again. The event page restarts and the
   models reload from cache in a few seconds.

## Screenshots

Kept small, in [screenshots/](screenshots/):

| File | What |
|---|---|
| `popup-consent.png` | First-run consent (Chrome) |
| `popup-result.png` | Result: gauge, verdict, per-detector breakdown |
| `popup-images.png` | Result with image-provenance summary and per-site permission button |
| `page-heatmap.jpg`, `page-flagged.jpg`, `page-underline.jpg` | The three highlight styles on the news fixture |
| `page-pill-nav.jpg` | Pill ▼ navigation with the tooltip on a flagged sentence |
| `page-image-badges.jpg` | C2PA "CR" badge on the signed sample image |
| `options.jpg`, `options-custom-model.jpg` | Options: models, engine line; licence warning for a custom model |
| `popup-images-permission.png` | Production build: images not fetched; per-site permission button |
| `firefox-popup.png`, `firefox-options.jpg`, `firefox-page-heatmap.jpg` | Same in Firefox |
