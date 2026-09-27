# Integration notes for T5 (collected by the lead from task reports)

## From T0
- `onnxruntime-web` and `c2pa-text` ship without LICENSE files. public/licenses/ has placeholders; T6 must fetch the real text.
- `modelOverrides` is `Partial<Record<ModelSlot,…>>`.

## From T4 (provenance)
- The provenance background creates the offscreen doc itself and tolerates T1 doing so concurrently. Merge this with T1's offscreen client.
- c2pa-web 0.15.2 rejects non-https worker URLs, so T4 passes a stand-in URL object pointing at the packaged worker. **Unverified in a real browser**, so test this first.
- T2's clear / SPA cleanup must call `clearImageBadges()` (T2 has been told).
- T3 should use `UNCHECKABLE_SCHEMES` (src/provenance/schemes.ts) and `requestImagePermission()` (permissions.ts, must be called from a user gesture).
- C2PA text manifests: the signature and signer are verified, but not that the manifest is bound to the text. The UI says so.
- The Interim Trust List is not bundled because its licence is unclear.
- DWT-DCT detection adds a vote-agreement test on top of the Hamming check, because upstream's own decoder gets 5–20% of bits wrong on small images.

## From T3 (popup/options/badge)
- The popup drives analysis itself: `extractText` goes to the tab, then analyze, then `renderHighlights` goes to the tab. Check that this doesn't duplicate T1's background-driven flow (autoRun, context menu). There should be one path.
- `AnalyzeResult.images` is T3's *proposed* summary shape. Reconcile it with T4's real provenance result and `provenanceScanImages` flow.
- Popup resyncs through `getTabStatus` and `onAnalysisStatus`.

## From T2 (content script)
- The pill's own "Scan page"/autoRun path sends `analyze` with `tabId: 0`. The background must use `HandlerMeta.senderTabId` for requests that come from content scripts.
- The context menu "Analyze selection" is not wired yet. It belongs in the background: create the menu entry, then on click send `extractText{target:'selection'}` to the tab, run `analyze`, and send back `renderHighlights`.
- There are three analysis entry points (popup, pill, context menu), so unify them in one background orchestration if possible.
- `happy-dom` is recommended as a devDependency for DOM tests of extraction and highlighting (not installed).
- Only the first range of a selection is used, so multi-range selections are ignored.

## From T1 (engine)
- Context menu "Check selected text" is added, and the router uses the sender's tab id, so T2's `tabId:0` works.
- Calibration is in docs/calibration.md (49 texts written or chosen by the agent, so the sample is small and weak). The TMR classifier is saturated on modern human prose (~0.98), so T1 added logit re-centring. The lite classifier beat TMR on this sample. **Compare them on real pages and decide which one the ensemble uses.** Burstiness weight is 0.
- wxt.config.ts aliases `onnxruntime-web/webgpu` to the non-bundle build to avoid a second 27 MB wasm file.
- A jsdelivr fallback string remains in the bundle, though it's overridden at runtime. Confirm no requests go to it, and strip it if the store review might object.
- `AnalyzeResult.unicode` indices are into the blocks joined with "\n\n". Check that T2's markers don't double-scan or misalign.
- Test first: returned-promise onMessage in Chrome, the offscreen thread count via getEngineInfo, no CDN requests, the Firefox module worker, caching in private windows, keepalive during long downloads, and whether WebGPU scores differ from the q8 calibration.

## For T12 (after T7): leftovers from T9 and persona pass 1
- Engine hooks that T9 couldn't wire because they're T7's files: idle-unload handler for the battery-saver alarm; a per-request `useCpuOnBattery` device channel; gate the toolbar badge on `surfaces.badge` (router.ts always sets it).
- Persona items not yet done: cache loads are still labelled "Downloading model" (src/ui/state.ts, src/content/pill.ts), so say "Loading…" unless it's a network fetch; colour/weight graduation within the AI band; mixed-article chip (`AI 54% · 15/41`); a quiet "not checked" cue for images without permission; verify defaults on a fresh install (the persona saw autoRun on).
- E2E not extended or re-run for presence modes, adapters, filter or entry points, and screenshots were not re-taken. Chat/Reddit/search adapters are fixture-tested only, so verify them on live public pages (Reddit, HN, Google results; no logins).
- Then: freeze the contract (contractVersion) and write docs/ui-dev.md. (No mock mode: the user declined it.)
- **User feedback (preview): the first-run download becomes a checklist.** Each model is listed with its size and a few words on its role, all ticked by default, with a running total and one Download button. Modes or detectors whose models aren't downloaded are greyed out, with an inline "download (N MB)". The same checklist appears in options → Models (add or remove later).
- **User feedback (preview): "Analyze selection" with no selection** currently replaces the popup with the error state "Select some text on the page first, then try again." That's annoying. Fix: on popup open, query the selection length and dim the button when it's empty (tooltip "Select text first"). If it's clicked anyway, show a non-blocking toast "No text selected" (auto-dismiss ~2 s) and leave the popup state untouched. **General rule:** minor or expected conditions (no selection, no text on page, too short, permission denied) use toasts. Full error states are only for real failures (download or engine errors). Add a small reusable toast component for popup, side panel and options.
