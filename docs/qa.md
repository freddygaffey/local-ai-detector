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
| Chrome, e2e build, full (5 modes, cold + warm, per-paragraph flag rates, WebGPU vs WASM, options) | **29/29** |
| Chrome, **production build**, fresh profile (consent → real download → 4 modes, flag rates) | **20/20** |
| Firefox, e2e build (4 modes; with `--full` also Binoculars: 19/19 in the earlier run) | **17/17** |
| `npm run typecheck`, `npm test` (226 tests, 21 files, incl. happy-dom DOM tests), both builds | green |
| `web-ext lint` (Firefox build) | 0 errors, 2 warnings (justified below) |

### Per-paragraph flag rates (regression test)

The fixture paragraphs carry `data-src="human"` (public-domain USGS/NWS/NPS text) or
`data-src="ai"` (LLM-written). The Chrome suite reads which highlighted sentences sit in which paragraph.
These are the results at the default settings (ensemble, WASM), identical in the production build:

| Page | Human sentences flagged | AI sentences flagged | Outside labelled paragraphs |
|---|---|---|---|
| `news.html` | **0 / 22** | **13 / 17 (76%)** | none (headline, byline and captions aren't scored) |
| `blog.html` | **0 / 33** | – (its AI text is in reader comments, outside `<article>`, which a page scan doesn't read) | none |

Pill and popup counts match on both pages (news: 15 and 15/41). The test fails if more than 20% of
human sentences are flagged, if AI paragraphs aren't flagged more often, if anything
unlabelled is flagged, or if the pill and popup disagree. For the causes of the earlier
over-flagging and for the paragraph-level calibration, see
[calibration.md](calibration.md#paragraph-level-thresholds-sentence-colours-and-flagged).

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
6. Popup and pill disagreed on the flagged count. The first cause was different thresholds (0.65 vs 0.6),
   now one scale in `src/shared/thresholds.ts`. The second cause was re-analysis
   reading the extension's own `⟦ZW⟧` markers as page text, which lost those sentences'
   ranges (popup 43 against pill 41). Extraction now skips the markers, and the pill counts
   with the popup's function on the same result.
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
17. **Human paragraphs were flagged** (the lead's review of `page-flagged.jpg`). Headings, bylines and
    captions were scored and folded into paragraphs. Classifier chunks spanned several
    paragraphs. Paragraph-sized pieces used document-level thresholds. Now page scans drop
    non-prose blocks, sentence colours come from one classifier chunk per paragraph, and they use
    paragraph-level thresholds fitted in the browser. See the table above.
18. The popup's result area was redone as cards (Text, Hidden characters, Images) with aligned
    label/value rows, a proper per-detector bar grid, a styled permission button and an
    aligned "✕ Clear" button.

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

## T9 addendum: Presence modes, battery saver, entry points, adapters

New unit/DOM tests (happy-dom where DOM is needed), all green under
`npm test`:

| File | Covers |
|---|---|
| `src/shared/presence.test.ts` | Presence preset mapping, "Custom" detection, per-site auto-run rules, fresh-install defaults |
| `src/power/battery.test.ts`, `src/power/idle.test.ts` | Battery/Compute-Pressure gating decisions, idle-unload timing (pure; the real `navigator.getBattery`/`PressureObserver` calls aren't mocked) |
| `src/content/adapters/adapters.test.ts` | Chat (ChatGPT-style `data-message-author-role`, class-hint fallback), Reddit (new `shreddit-*` and old.reddit.com), generic comments (Hacker News `.commtext`, generic forum/review), search-result snippets (Google-style fixture) |
| `src/content/slopFilter.test.ts` | Dim/collapse/"Show", search markers, per-item labels |
| `src/content/siteMemory.test.ts` | Per-domain ring buffer, tally, clear |
| `src/content/fileExtract.test.ts` | .docx (a real deflate-compressed zip built with Node's `zlib` in the test, read back with the runtime's own `DecompressionStream`), .md, .html, dispatch by extension |
| `src/ui/probability.test.ts` | The bridge to T7's `toDisplayProbability`/`MIN_WORDS_FOR_SCORE`/`filterThreshold` |

**Chat/Reddit/search-engine adapters are fixture-based, not verified against
live sites**: this agent has no network access to chatgpt.com, claude.ai,
reddit.com or the search engines, so the selectors (ChatGPT's documented
`data-message-author-role`, Reddit's `shreddit-*` elements and
`old.reddit.com` markup, Google/Bing/DuckDuckGo/Kagi result containers) are
best-effort from documented/general knowledge of each site's structure, with
a generic structural fallback (turn/role hints, alternation) doing most of
the real work on unfamiliar sites. Expect some selector drift on real
sites; this is the same class of risk any DOM-scraping feature has, and it
degrades gracefully (the adapter just doesn't match, and the page falls back
to the normal whole-page scan).

**Not done in this pass** (scope/time; flagged honestly rather than skipped
silently):

- The Chrome/Firefox E2E suites (`scripts/e2e/`) were **not** extended with
  new scenarios for Presence modes, the chip, context menus, `commands`, the
  side panel, or the slop filter, and were **not** re-run end to end (they
  need real model downloads from Hugging Face and a live browser; typecheck,
  `npm test`, both production builds, both e2e-mode builds, and
  `web-ext lint` were all re-verified green instead — see the root
  `README`/commit history for this task's exact commands).
- Screenshots in `docs/screenshots/` were **not** re-taken for the new UI
  (chip, Presence/Battery/Slop filter/Site memory options sections, side
  panel, paste/file-drop popup).
- The toolbar badge is always shown by the engine's own router
  (`src/engine/router.ts`, owned by T7) once an analysis finishes, regardless
  of `Settings.surfaces.badge` — so the "Badge" and "On click" Presence
  presets currently look identical on the toolbar (the page-level
  difference -- chip/highlights vs. nothing -- is unaffected).
- "Battery saver"'s `useCpuOnBattery` computes a decision
  (`decidePowerAction` in `src/power/battery.ts`) but there's no per-request
  channel yet to actually force a single run onto the CPU; the engine-wide
  `useWebGPU` toggle is the only lever until one exists.
- Wording used "Retry" (not "Scan again") for pill actions during this pass;
  `docs/qa.md`'s and `docs/ux/findings-pass1.md`'s older screenshots/text
  predate that rename.

## T7 addendum: Fusion, accuracy pass, WebGPU by default

Date: 2026-09-27. Chrome for Testing 153 (Apple Silicon, shader-f16 adapter) for the WebGPU
path; GitHub-hosted Ubuntu runners (4 vCPU, Playwright Chromium, 12-shard matrix,
`.github/workflows/t7-eval.yml`) for the WASM path and Binoculars. Numbers and methods are in
[calibration.md](calibration.md#what-ships-t7-2026-09-27).

### How to rerun

```sh
npm run build:e2e && node scripts/e2e/fusion.mjs          # Fusion assertions (real models)
node scripts/eval/build-eval-set.mjs --out eval-set.json  # web eval set (cached, not committed)
node scripts/e2e/browser-t7-calibration.mjs --eval eval-set.json --out runs.json --runs webgpu:tmr,...
node scripts/eval/fit-t7.mjs --eval eval-set.json --runs runs.json --md report.md
```

### Fusion E2E (`scripts/e2e/fusion.mjs`): 5/5

| Check | Result |
|---|---|
| 3-detector Fusion (Fakespot + TMR + perplexity): `detectors[]` with device/dtype/weight, `device: "mixed"`, overall and per-sentence agreement recount, calibrated `probability` | ✅ Fakespot wasm/q8, TMR webgpu/fp16, perplexity webgpu/fp16; overall 0.61, P(AI) 0.95, 1/3 agree, `disagree: true` |
| Methods: vote = median, max = highest, log-odds within range, method recorded | ✅ weighted 0.61, vote 0.47, max 0.64, log-odds 0.53 |
| Labelled news fixture at default Fusion | ✅ human 0/22 sentences flagged, AI 17/17 |
| `analyzeTab` with `mode: "classifierLite"` (the auto-run pass) | ✅ lite only, no fusion block, tab status mode recorded |
| v1 settings (`ensemble` + lite, WebGPU off) migrate | ✅ lite + perplexity, WebGPU turned on |

### WebGPU vs WASM

| | WebGPU path | WASM path |
|---|---|---|
| Default Fusion AUROC (web test half) | 0.91 | 0.91 |
| Human texts flagged / AI flagged | 5% / 68% | 5% / 68% |
| Display ECE | 0.040 | 0.040 |
| Warm speed, ms per 1,000 words | TMR 400, lite 207, perplexity 748 (fp16) | TMR ~2,500, lite ~800, perplexity ~2,000, Fakespot ~2,500, ModernBERT ~3,500, Binoculars ~18,000 (4 threads) |

Dtype checks on WebGPU (web eval set): TMR q4f16 0.844 vs fp16 **0.861**; lite q4f16 0.735
vs fp16 **0.756**; Fakespot q8 0.907 vs 0.932 on WASM and no faster, so WASM; ModernBERT
fp16 and q4f16 **constant output** (fp32 works, 599 MB), so WASM; Binoculars fp16 constant (as
q4f16 was in T5), so WASM.

### Findings

1. **ModernBERT and Binoculars are broken on WebGPU at half precision.** Every input gives the same
   score (ORT-web 1.31 dev, Chrome 153). Both are pinned to WASM (`wasmOnly`).
2. **The old "51% confidence" was an uncalibrated score.** The UI now gets `probability`,
   fitted per detector set, device and length. Unedited assistant-voice stories show about 95%.
3. **TMR's scale is knife-edged.** Its human logits bunch up, so an uncalibrated-slope fit
   (~18) turned fp16 run-to-run noise into 0.12 score jumps. Slopes are capped at 6.
4. **Long headless WASM runs crash Chrome under heavy CPU contention** ("Target closed",
   protocol timeouts). The calibration runner resumes and retries errored texts, and CI runs two
   passes per shard. CI finished with 0 errors.
5. `scripts/e2e/chrome.mjs` (the T5 suite) no longer matches the redesigned popup/pill
   (e.g. `select[aria-label="Detector mode"]` and the pill's "Scan page" button are gone).
   That's a T9/T12 selector update. The engine paths it covered are exercised by `fusion.mjs`.
