# Provenance & watermarks: what can be checked locally in the browser

Research date: 2026-09-27. Scope: a Chrome and Firefox MV3 extension that runs entirely
in the browser, with no remote APIs, no keys and no cost. The project is MIT-licensed, so
anything we ship has to be openly licensed and bundleable. In-browser ML text classifiers
are covered separately in `feasibility.md` and are left out here.

## TL;DR

* **Worth shipping in v1 (all local, all openly licensed):**
  1. **C2PA / Content Credentials** in images (and optionally audio and video), read and
     validated with `@contentauth/c2pa-web` (MIT). Signers are identified against the
     bundled C2PA Trust List (CC-BY-4.0). This is now the main provenance signal:
     OpenAI, Google, Adobe, Microsoft, Anthropic, Meta (Imagine), BFL/Stability hosted APIs,
     Synthesia and others ship it.
  2. **IPTC `DigitalSourceType`** (`trainedAlgorithmicMedia`,
     `compositeWithTrainedAlgorithmicMedia`, `algorithmicMedia`) in XMP/IPTC, plus
     **generator metadata**: SD WebUI/Forge `parameters`, ComfyUI `prompt`/`workflow`,
     InvokeAI, NovelAI `Comment` and stealth-alpha, Midjourney `Description`/Job ID,
     China GB 45438-2025 `AIGC` labels, and the EXIF `Software` value. Read with
     **ExifReader** (MPL-2.0) plus a small PNG-chunk parser of our own.
  3. **Stable Diffusion / FLUX `invisible-watermark` (DWT-DCT)** decoding with a small
     port we write ourselves (MIT). The payloads are fixed and public, so no key is
     needed. It is fragile, so a hit counts as a positive but a miss tells us nothing.
  4. **Text: C2PA text manifests** (Unicode variation selectors after U+FEFF), detected
     with `c2pa-text` (MIT). Also a **hidden-Unicode report**, presented as
     "unusual characters", never as "AI watermark".
* **Can't be checked locally (label it that way in the UI):** Google **SynthID** (image,
  video, audio, text; now also used by OpenAI, ElevenLabs and others), **Anthropic's Claude
  text watermark** (SynthID-Text-style, keyed), **Meta Content Seal** (Muse Image),
  OpenAI's unreleased text watermark, Digimarc, and any keyed Kirchenbauer/Aaronson-style
  LLM watermark. They all need either a secret key or a proprietary detector that sits
  behind a rate-limited web portal.
* **Excluded for licence or feasibility reasons:** Stable Signature (CC-BY-NC weights),
  Tree-Ring (needs full diffusion inversion), and SynthID-Text detection of production
  models (the keys are secret). Meta VideoSeal/PixelSeal/AudioSeal are MIT and could
  technically run in onnxruntime-web, but the models are large (VideoSeal is 228 MB) and
  no major production service is known to use their public open-source weights.
  **Deferred to v2.** Adobe TrustMark (MIT, JS/ONNX decoder exists, 47 MB per model)
  only gives an ID that has to be resolved through a **remote** soft-binding API. It is
  optional for v2 and off by default.

## Main table

Legend: **Local?** means it can be checked in-browser with no key and no network (apart
from fetching the asset itself). **Licence** is the licence of the library/model we would
bundle. "Bundle OK" means compatible with shipping inside an MIT open-source extension.

| Scheme | Who uses it (2026-09) | Media | Local? | Library (npm / source) | Licence / bundle OK? | Robustness |
|---|---|---|---|---|---|---|
| **C2PA manifest (Content Credentials)**, JUMBF in JPEG APP11, PNG `caBX`, WebP/AVIF/HEIC, MP4 `uuid`, WAV/MP3 | OpenAI (DALL-E/GPT-image in ChatGPT, API, Codex; Sora partially), Google (Gemini/Imagen/"Nano Banana", Pixel camera), Adobe Firefly and CC, Microsoft (Designer/Copilot, Azure OpenAI/Foundry), Anthropic (Claude-produced PNG/JPEG files since 2026-08-02), Meta Imagine (rolling out 2026), BFL FLUX.2 / Stability hosted APIs, Synthesia (video), ElevenLabs (paid audio), LinkedIn/TikTok (display). **Not** Midjourney; xAI Grok not confirmed. | image, video, audio, PDF | **Yes**. Signature and hash validation run locally. Signer trust uses a bundled trust list. OCSP and remote-manifest fetch must be switched off to stay offline. | `@contentauth/c2pa-web` 0.15.2 (WASM 8.8 MB raw / 3.2 MB gzip, ~100 KB JS; worker `c2pa_worker.js`). Older `c2pa` 0.30.x is deprecated. | **MIT** (c2pa-js). The underlying c2pa-rs is MIT/Apache-2.0. **Bundle OK.** | Cryptographically strong but **fragile**: removed by screenshots, most re-encodes, and most social/CDN pipelines (X, Facebook, Instagram, WhatsApp strip it). Absence means nothing. |
| **C2PA Trust List** (signer identification) | Official C2PA Conformance Program list (2025→). The Interim Trust List was frozen 2026-01-01. | n/a | **Yes**, bundled PEM | `c2pa-org/conformance-public/trust-list/C2PA-TRUST-LIST.pem` (+ `C2PA-TSA-TRUST-LIST.pem`), passed via `Settings.trust.trustAnchors` | **CC-BY-4.0**. Bundle OK with attribution. | n/a. Refresh with each extension release. |
| **C2PA text manifest** (`C2PATextManifestWrapper`: magic `C2PATXT\0`, variation selectors U+FE00–FE0F / U+E0100–E01EF, prefixed by U+FEFF) | In the C2PA spec (2.3/2.4) for unstructured text. Used by Encypher and some publishers. No major LLM chat UI is known to emit it by default. | text | **Yes**. Extraction is trivial; signature validation of the JUMBF depends on c2pa-web accepting raw manifest bytes (**to verify**). | `c2pa-text` 3.0.0 (npm, ~100 KB unpacked, TS) | **MIT**. Bundle OK. | Removed by NFC-unsafe copy/paste, sanitisers, and any retyping. |
| **IPTC `DigitalSourceType`** (`trainedAlgorithmicMedia`, `compositeWithTrainedAlgorithmicMedia`, `algorithmicMedia`, `compositeSynthetic`) in XMP `Iptc4xmpExt:DigitalSourceType` / IIM | Google (also `Credit: Made with Google AI`), Midjourney, OpenAI, Adobe Firefly, Meta, Microsoft, Stability hosted, many stock sites. Meta/Google platforms read it for labelling. | image (also video XMP) | **Yes** | **ExifReader** 4.46.0 (`exifreader`, 133 KB min / 39 KB gzip; custom builds can be smaller). Parses EXIF, IPTC, XMP, ICC, PNG tEXt/iTXt/zTXt, WebP, HEIC/AVIF, GIF. | **MPL-2.0** (file-level copyleft). Bundle OK: the unmodified library ships under MPL and our code stays MIT. We must keep its licence notice and publish changes to *its* files, if any. Alternative: `exifr` (MIT) but unmaintained since 2022. | Unsigned and trivially stripped or forged. Removed by most re-encodes. Useful as a positive hint only. |
| **Generator metadata**: A1111/Forge/SD.Next `parameters` (tEXt / JPEG UserComment); ComfyUI `prompt` + `workflow` JSON; InvokeAI `invokeai_metadata`; Fooocus; NovelAI `Software=NovelAI` + `Comment` JSON; DALL-E/ChatGPT (C2PA only); Midjourney XMP `Description` with prompt + Job ID + author | Local/open-weights users (SD, SDXL, FLUX, etc.), NovelAI, Midjourney | image | **Yes** | ExifReader + our own ~100-line PNG chunk walker for keys ExifReader doesn't normalise | ExifReader MPL-2.0. Own code MIT. | Stripped by any re-encode. Plain text, so it can be forged. |
| **NovelAI "stealth pnginfo"** (`stealth_pnginfo`/`stealth_pngcomp`/`stealth_rgbinfo`/`stealth_rgbcomp`: LSB of alpha or RGB, gzipped JSON, signed by NAI) | NovelAI, and A1111 extensions that copy it | image (PNG) | **Yes**. Needs pixel access (see extension notes). | Own port of `NovelAI/novelai-image-metadata` (~80 lines; uses `DecompressionStream('gzip')`) | Reference code **MIT**. Bundle OK. | Survives metadata stripping, but lossy re-encode or resize destroys it. |
| **China GB 45438-2025 implicit label** (`AIGC` tEXt / XMP ns `http://www.tc260.org.cn/ns/AIGC/1.0/`: `Label`, `ContentProducer`, `ProduceID`, ...) | Chinese providers (mandatory since 2025-09-01): DeepSeek, Qwen, Doubao, Ernie, Kling, Hailuo, etc. | image, video, audio, (text via file metadata) | **Yes** | ExifReader (XMP) + PNG chunk walker | as above | Stripped by re-encode. |
| **SD/FLUX `invisible-watermark` DWT-DCT** (`imwatermark`): SD 1.x `bytes` "StableDiffusionV1" (136 bits); SD 2.x "SDV2" (32 bits); SDXL 48-bit `0b101100111110110010010000011110111011000110011110`; FLUX.1/FLUX.2 reference code 48-bit `0b001010101111111010000111100111001111010100101110` (note that Python `bin()[2:]` drops the two leading zeros, so it is effectively 46 bits) | Stability reference scripts and `diffusers` SDXL (when `invisible-watermark` is installed), BFL FLUX reference inference. **Not** applied by default in A1111/Forge/ComfyUI. Hosted APIs may differ. | image | **Yes**. Fixed public payloads, no key. | **None usable on npm.** The npm `invisible-watermark` package is unrelated. Write our own port of the `dwtDct` decoder: BGR→YUV (OpenCV coefficients), 1-level Haar DWT on U/V, 4×4 block DCT, threshold coefficient mod scale (36), majority vote. Roughly 200 lines of plain JS; no WASM needed. `dwtDctSvd` needs a 4×4 SVD, which is also small. | Python original **MIT**. Our port MIT. Bundle OK. | **Fragile.** Per the project README, dwtDct does not survive resize, crop, rotation or large brightness changes; mild JPEG is often OK. Images <256 px are not marked. Use a Hamming threshold (≤ 4 of 48 bits) to control false positives. |
| **Google SynthID** (image, video, audio, text) | Google Gemini/Imagen/Veo/Lyria/NotebookLM; **OpenAI images (since 2026-05-19) and audio (since 2026-07-31)**; ElevenLabs audio detector; Gemini text (since 2024) | all | **No**. Proprietary detector and secret keys. Verification is only through the Gemini app (about 10 checks a day), the SynthID Detector portal (waitlist), Google Search/Chrome "About this image"/Gemini-in-Chrome, and OpenAI's verification tool. | none | Proprietary. **Not bundleable.** | Designed to survive screenshots, resizing, compression (image) and light editing (text). |
| **SynthID-Text (open-source algorithm)** | Algorithm is in HF Transformers ≥4.46. **Anthropic Claude** uses a SynthID-Text-style scheme with *its own* key (announced 2026-08-14; new models from 2026-08-02, older ones by 2026-12-02). Gemini uses Google's key. | text | **No**. The detector needs the provider's secret key(s) and the tokenizer; without the key the output is noise. Anthropic's detection API is private preview for vetted organisations. | `google-deepmind/synthid-text` (Python/JAX) | Code **Apache-2.0**, but useless without keys. | Survives light edits; broken by full paraphrase or translation; weak on short/factual text. |
| **OpenAI text watermark** | Built in 2024 and **never shipped**. Still not deployed as of Aug–Sep 2026, despite OpenAI signing the EU Code. | text | **No** (does not exist in the wild) | none | n/a | n/a |
| **Kirchenbauer (green-list) / Aaronson (Gumbel) / other academic LLM watermarks** | No major provider deploys a *public-key* variant. Only self-hosted models configured by their operators. | text | **No** unless the operator publishes the key/hash scheme (none known for any major model) | `jwkirchenbauer/lm-watermarking` (Python, Apache-2.0) | n/a | varies |
| **Meta Content Seal** (proprietary production version) | Meta Muse Image (launched 2026-07-08); video planned | image (video later) | **No**. Checked only via meta.ai/identification (rate-limited). | none | Proprietary. Not bundleable. | Designed to survive crop, resize, compression and screenshots. |
| **Meta open-source Seal family**: VideoSeal / PixelSeal / ChunkySeal / AudioSeal | Research releases. No major provider is known to use the *public* weights/messages in production. | image/video, audio | **Technically yes** (needs ONNX export + onnxruntime-web), but it only helps if someone embeds with the public model, and a random 256-bit message can't be attributed without the provider's message registry. | `facebookresearch/videoseal` (VideoSeal TorchScript 228 MB); `facebookresearch/audioseal` (detector 35 MB); runtime `onnxruntime-web` (MIT, ~10–25 MB WASM) | **MIT (code and weights)**. Bundle OK licence-wise; too large for the store package, so it would need an on-demand download. | Robust to common edits by design. |
| **Stable Signature** | Research (Meta, 2023). Not a production scheme. | image | Technically possible | `facebookresearch/stable_signature` | **CC-BY-NC-4.0**. **Excluded**: non-commercial licence, not MIT-compatible. | n/a |
| **Tree-Ring / Gaussian Shading** and other latent-noise watermarks | Research | image | **No**. Detection needs DDIM inversion through the generating diffusion model (GBs, GPU minutes). | n/a | MIT code, but infeasible | n/a |
| **Adobe TrustMark** (C2PA soft binding / "durable Content Credentials") | Adobe (Firefly/CC durable credentials), others via C2PA soft-binding | image | **Partly.** Decoding the ID is local (ONNX); turning the ID into a manifest or "AI" verdict needs a **remote** Soft Binding Resolution API. The ID alone doesn't say "AI". | `adobe/trustmark` `js/` (onnxruntime-web; `decoder_Q.onnx` / `decoder_P.onnx` **47 MB each**, hosted on `cai-watermark.adobe.net`) | **MIT** (repo LICENSE). Bundle OK licence-wise; too large to ship, and the lookup is not local. **v2 at most, opt-in.** | Designed to survive re-encode and resize. |
| **Digimarc** watermark | Digimarc + C2PA durable credentials | image/video/audio | **No**. Proprietary detector and remote lookup. | none | Proprietary | Robust |
| **Hidden Unicode in text** (ZWSP U+200B, ZWNJ/ZWJ, WJ U+2060, BOM U+FEFF, NNBSP U+202F, NBSP, soft hyphen, tag chars U+E0000–E007F, bidi controls) | **No provider is confirmed to insert these as a watermark.** OpenAI said the 2025 o3/o4-mini NNBSP characters were an RL quirk, "not a watermark", and they stopped appearing. Anthropic says explicitly "there are no hidden characters". Google SynthID-Text is statistical. The only legitimate *intentional* invisible-character marking is C2PA text (above). | text | **Yes** (regex) | own code | MIT | Removed by any normaliser. Also common in human text (French typography uses NNBSP, CJK input, Word, copy from PDFs). **High false-positive risk.** |

## Provider summary (2026-09)

| Provider | Images | Video | Audio | Text | Locally checkable part |
|---|---|---|---|---|---|
| OpenAI | C2PA + SynthID (since 2026-05-19) + IPTC | Sora: C2PA (inconsistent) + visible moving mark | SynthID (since 2026-07-31) | **none** (watermark built, not shipped) | C2PA/IPTC only |
| Google | C2PA + IPTC (`Made with Google AI`) + SynthID | Veo: SynthID + visible "veo" mark (most tiers) + C2PA | SynthID | SynthID-Text (Gemini, keyed) | C2PA/IPTC only |
| Anthropic | C2PA on Claude-produced PNG/JPEG files (from 2026-08-02) | n/a | n/a | SynthID-Text-style keyed watermark (rolling out, all models by 2026-12-02); detection API private preview | C2PA on files only |
| Meta | Content Seal (Muse Image) + C2PA/IPTC (Imagine) | Content Seal planned | AudioSeal (research) | none known | C2PA/IPTC only |
| Microsoft | C2PA (Designer/Copilot, Azure OpenAI/Foundry) | C2PA | — | none known | C2PA |
| Adobe | C2PA (always) + TrustMark durable credentials | C2PA | C2PA | n/a | C2PA; TrustMark ID (remote lookup) |
| Midjourney | IPTC `trainedAlgorithmicMedia` + prompt/Job ID in XMP; **no C2PA, no known invisible mark** | same for video | — | — | XMP/IPTC |
| Stability / BFL (FLUX) | Hosted APIs: C2PA. Open weights: optional DWT-DCT invisible-watermark in reference code | — | — | — | C2PA, DWT-DCT, generator metadata |
| xAI (Grok) | Visible corner logo; C2PA/invisible **not confirmed**; did not sign the EU transparency code | — | — | none | visible mark only (not in scope) |
| Mistral | Signed EU code; no public marking shipped as of Aug 2026 | — | — | none | — |
| DeepSeek / Chinese providers | GB 45438-2025 visible + implicit metadata labels (`AIGC`) | same | same | visible label appended in chat UI; no published text watermark | `AIGC` metadata |
| ElevenLabs | — | — | SynthID-based detector + C2PA on paid tier | — | C2PA (audio) |

## Recommended v1 feature set

**Pipeline.** Content script → collect candidate media (`img.currentSrc`, CSS
backgrounds optional, `<video>`/`<audio>` `src` with a size cap) → send URLs to the
background → the background fetches the bytes → run parsers in a worker → results go back
to the content script for badges.

1. **C2PA check (images first; audio/video behind a size cap).**
   * Library: `@contentauth/c2pa-web` (MIT). Use the separate `.wasm` file shipped inside the
     extension (not the 11.7 MB `inline` build). Pass
     `wasmSrc: chrome.runtime.getURL('c2pa_bg.wasm')` and
     `workerSrc: new URL(chrome.runtime.getURL('c2pa_worker.js'))`. The `workerSrc` option
     exists specifically for strict CSPs that forbid `blob:` workers, as MV3 extension pages do.
   * Settings: `verify.verifyTrust: true`; `trust.trustAnchors` = bundled
     `C2PA-TRUST-LIST.pem` (CC-BY-4.0, attribute it). Optionally also bundle the frozen
     Interim Trust List for pre-2026 assets. **Disable remote manifest fetching and OCSP
     fetching** so nothing leaves the browser.
   * Output: signer (cert CN/O), `claim_generator`, `c2pa.actions` with
     `digitalSourceType` (`trainedAlgorithmicMedia` → "AI-generated",
     `compositeWithTrainedAlgorithmicMedia` → "edited with AI"), validation state (valid /
     untrusted signer / tampered), and the ingredient chain.
2. **Metadata check (images).** ExifReader (MPL-2.0) with `expanded: true`, plus a small
   PNG chunk walker. Flag the IPTC DigitalSourceType values, `Credit: Made with Google AI`,
   the `AIGC` TC260 label, and generator keys (`parameters`, `prompt`, `workflow`,
   `invokeai_metadata`, NovelAI `Comment`/`Software`, Midjourney `Description`/Job ID,
   EXIF `Software` matching a known generator list). Label all of these **"unsigned claim"**.
3. **Invisible watermark check (images ≥256×256, PNG/JPEG/WebP).** Our own MIT JS port of
   the `imwatermark` `dwtDct` decoder, tested against Python-generated fixtures. Match the
   SD1/SD2/SDXL/FLUX payloads with a Hamming threshold. Also decode NovelAI stealth-alpha.
   Both need decoded pixels, via `createImageBitmap` + `OffscreenCanvas` on the fetched
   bytes. Never draw the page's `<img>`, because cross-origin images taint the canvas.
4. **Text checks.**
   * C2PA text manifest detection with `c2pa-text` (MIT), run on selected text or on page text
     nodes. If c2pa-web can't validate the extracted manifest bytes, report
     "C2PA text manifest present (signature not verified)".
   * Hidden-character report (ZW*, U+FEFF outside a C2PA wrapper, tag characters, bidi
     controls, NNBSP counts) shown as **"unusual invisible characters: not evidence of AI"**.
     Never feed this into an AI score.
5. **UI honesty.** Every result is one of: *Provenance found (verified signer)*,
   *Provenance found (untrusted/unknown signer)*, *Unsigned AI metadata claim*,
   *Open-source watermark detected*, *Nothing found (this does not mean human-made)*.

## Label explicitly as "cannot be checked locally"

Show a static info panel listing these, with the official checkers named as
**user-initiated external links only** (off by default, never automatic uploads):

* **Google SynthID** (image/video/audio/text; also OpenAI images/audio, ElevenLabs audio).
  Checker: Gemini app / SynthID Detector / Chrome "About this image".
* **Anthropic Claude text watermark.** Detector is private preview for vetted organisations.
* **Gemini text watermark** (SynthID-Text, Google's key).
* **Meta Content Seal** (Muse Image). Checker: meta.ai/identification.
* **Digimarc**, and **TrustMark ID → manifest lookup** (needs a remote resolver).
* **OpenAI text**: there is no watermark to check (not shipped).
* **Midjourney, xAI Grok**: no invisible watermark is publicly known, so only metadata
  (Midjourney) or nothing (Grok).
* Any keyed academic LLM watermark (Kirchenbauer/Aaronson) whose key isn't published.

## Extension-specific notes

* **CSP (both browsers):** `"content_security_policy": {"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"}`.
  In MV3, `script-src` may only contain `'self'` and `'wasm-unsafe-eval'` (Firefox docs;
  Chrome ≥103). Load c2pa's worker from a packaged file (`workerSrc`), not `blob:`.
* **Where WASM runs:** Chrome MV3 background is a service worker, which **cannot create
  `Worker`s**. Run c2pa-web in an **offscreen document** (`chrome.offscreen.createDocument`,
  reason `WORKERS`/`BLOBS`) or call the WASM directly in the service worker without its
  worker wrapper. Firefox MV3 uses event pages (background scripts with a DOM), which can
  spawn Workers directly. Keep one code path by abstracting "get a c2pa handle".
* **Fetching cross-origin bytes:** content-script `fetch` is subject to the page's CORS,
  so do it in the background/offscreen context with `host_permissions: ["<all_urls>"]`
  (or `optional_host_permissions` + `permissions.request` per site for a privacy-friendly
  default). Chrome grants host permissions at install. **Firefox ≥127** shows and grants
  `host_permissions` at install, but users can revoke them per site, so check
  `permissions.contains` and degrade gracefully. Use `credentials: 'omit'` by default: it
  avoids sending cookies and matches what a CDN would serve anyway. Some images (signed
  URLs, auth-gated, `blob:` URLs) will only work from the content script, so fall back to
  reading `blob:`/`data:` URLs there and transferring the `ArrayBuffer`.
* **The bytes you fetch are not the bytes the user saw.** CDNs and social sites serve
  re-encoded variants (WebP/AVIF, resized) that have usually lost C2PA/XMP. Prefer the
  largest `srcset` candidate and, where known, the "original" URL pattern. Say so in the UI.
* **Size and performance limits:** cap image fetches at about 25 MB and video/audio at about
  50 MB (or skip them unless the user clicks). For JPEG, C2PA (APP11) and XMP (APP1) are
  in the header, so a `Range: bytes=0-262143` request often suffices. PNG `caBX`/`iTXt`
  normally come before `IDAT` but aren't guaranteed to. MP4 may put the manifest `uuid`
  box at the end. Queue work (2–4 concurrent), dedupe by URL, cache results by URL +
  ETag in `chrome.storage.session`, only scan images ≥ 128 px displayed (≥256 px for
  DWT-DCT), and scan lazily via `IntersectionObserver`. c2pa-web startup
  (compile 8.8 MB WASM) takes roughly 100–300 ms once per background lifetime, so keep
  the offscreen document alive while a scan runs. The DWT-DCT decode on a 1024² image is
  a few ms of typed-array maths.
* **Package size:** c2pa WASM ~8.8 MB (3.2 MB compressed in the .crx/.xpi) + ExifReader
  ~133 KB + c2pa-text ~100 KB + own code. Well under store limits. Don't bundle ONNX
  models in v1.

## Licence summary for bundled components

| Component | Licence | Bundle in MIT extension? | Notes |
|---|---|---|---|
| `@contentauth/c2pa-web` (+ `@contentauth/c2pa-wasm`, c2pa-rs) | MIT (c2pa-rs MIT OR Apache-2.0) | Yes | include licence notices |
| C2PA Trust List PEM (`c2pa-org/conformance-public`) | CC-BY-4.0 | Yes | attribution required |
| `exifreader` | MPL-2.0 | Yes | keep MPL notice; modifications to its files must stay MPL |
| `c2pa-text` (Encypher) | MIT | Yes | |
| Own DWT-DCT port (from `ShieldMnt/invisible-watermark`) | MIT (original MIT) | Yes | credit original |
| Own NovelAI stealth decoder (from `NovelAI/novelai-image-metadata`) | MIT | Yes | |
| `onnxruntime-web` (v2 only) | MIT | Yes | large |
| VideoSeal / AudioSeal weights (v2 only) | MIT | Yes | too large to bundle; download on demand |
| TrustMark code + ONNX decoders (v2 only, opt-in) | MIT | Yes (licence) | needs remote resolver to be useful, so it breaks "local only" |
| Stable Signature | CC-BY-NC-4.0 | **No** | excluded |
| SynthID (image/audio/video), Meta Content Seal, Digimarc | Proprietary | **No** | not locally checkable |
| SynthID-Text code | Apache-2.0 | Yes, but pointless | production keys are secret |

## Sources

* c2pa-js / c2pa-web: <https://github.com/contentauth/c2pa-js>, <https://github.com/contentauth/c2pa-js/tree/main/packages/c2pa-web>, <https://www.npmjs.com/package/@contentauth/c2pa-web>, <https://opensource.contentauthenticity.org/docs/c2pa-js/packages/c2pa-web/> (sizes, `workerSrc` and trust settings verified from the published 0.15.2 / c2pa-utilities 0.3.1 packages)
* C2PA trust list and conformance: <https://github.com/c2pa-org/conformance-public/tree/main/trust-list>, <https://c2pa.org/conformance/>, <https://spec.c2pa.org/conformance-explorer/>
* C2PA spec 2.4 (incl. unstructured text): <https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html>; soft binding: <https://spec.c2pa.org/specifications/specifications/2.2/softbinding/Decoupled.html>
* c2pa-text: <https://github.com/encypherai/c2pa-text>, <https://www.npmjs.com/package/c2pa-text>
* OpenAI provenance (C2PA + SynthID, 2026-05-19; audio 2026-07-31): <https://openai.com/index/advancing-content-provenance/>, <https://help.openai.com/en/articles/8912793-c2pa-and-synthid-in-openai-generated-images>, <https://thenextweb.com/news/openai-c2pa-synthid-ai-image-detection-watermark>, <https://www.resultsense.com/news/2026-05-20-openai-c2pa-synthid-content-provenance/>
* OpenAI text watermark not shipped: <https://www.layer3labs.io/guides/does-chatgpt-watermark-text>, <https://writehuman.ai/blog/does-chatgpt-watermark-text>
* NNBSP episode: <https://www.rumidocs.com/newsroom/new-chatgpt-models-seem-to-leave-watermarks-on-text>
* Anthropic text watermark and C2PA: <https://www.anthropic.com/news/claude-text-watermark>, <https://support.claude.com/en/articles/16266773-how-claude-marks-ai-generated-content>, <https://techcrunch.com/2026/08/11/anthropic-says-it-will-watermark-text-generated-by-its-ai-models/>
* EU Code of Practice on transparency: <https://digital-strategy.ec.europa.eu/en/news/strong-backing-code-practice-transparency-ai-generated-content>, <https://www.techpolicy.press/the-eus-ai-transparency-code-of-practice-explained/>, <https://www.mofo.com/resources/insights/260911-full-transparency-organizations-sign-eu-code>
* SynthID: <https://deepmind.google/models/synthid/>, <https://ai.google.dev/responsible/docs/safeguards/synthid>, <https://github.com/google-deepmind/synthid-text>, <https://blog.google/innovation-and-ai/products/identifying-ai-generated-media-online/>, <https://www.lumethic.com/en/articles/synthid-detector-portal>
* Generator survey: <https://www.lumethic.com/en/articles/ai-generators-c2pa-watermarks>, <https://c2paviewer.com/articles/ai-tools-c2pa-support>
* Google IPTC: <https://iptc.org/news/google-ai-transparency-based-on-iptc-standards/>, <https://iptc.org/news/google-announces-use-of-iptc-metadata-for-generative-ai-images/>
* Midjourney metadata: <https://www.numonic.ai/blog/midjourney-metadata-what-survives>
* Microsoft: <https://learn.microsoft.com/en-us/azure/foundry-classic/openai/concepts/content-credentials>, <https://support.microsoft.com/en-us/designer/frequently-asked-questions-about-microsoft-designer>
* Meta Content Seal: <https://www.engadget.com/2210223/meta-built-an-ai-detection-tool-to-id-images-and-video-created-with-its-new-models/>, <https://www.siliconreport.com/meta-deploys-invisible-watermark-content-seal-for-ai-generated-images-c8511d47>; open-source Seal family: <https://github.com/facebookresearch/content-seal>, <https://github.com/facebookresearch/videoseal>, <https://github.com/facebookresearch/audioseal>
* Stable Signature licence (CC-BY-NC): <https://github.com/facebookresearch/stable_signature/blob/main/LICENSE>
* xAI: <https://www.cityam.com/chatgpt-might-follow-claudes-watermark-pledge-but-grok-to-swerve-it/>, <https://www.aiwatermarkremoval.com/is-grok-watermarked>
* DeepSeek / China: <https://watermarkcheck.com/deepseek-watermark/>, <https://github.com/StarPluckerZ/AigcTotal>, <https://www.hsfkramer.com/notes/tmt/2025-posts/China-Releases-Laws-to-Mandate-Labelling-of-AIGC>
* Veo / ElevenLabs: <https://www.bgr.com/tech/those-amazing-veo-3-videos-will-finally-tell-you-they-were-made-with-ai/>, <https://elevenlabs.io/docs/eleven-creative/audio-tools/audio-detector>
* invisible-watermark: <https://github.com/ShieldMnt/invisible-watermark>; SDXL payload: <https://github.com/huggingface/diffusers/blob/main/src/diffusers/pipelines/stable_diffusion_xl/watermark.py>; FLUX.2 payload: <https://github.com/black-forest-labs/flux2/blob/main/src/flux2/watermark.py>; SD v1 payload: <https://medium.com/@steinsfu/stable-diffusion-the-invisible-watermark-in-generated-images-2d68e2ab1241>
* NovelAI stealth metadata: <https://github.com/NovelAI/novelai-image-metadata>
* TrustMark: <https://github.com/adobe/trustmark>, <https://opensource.contentauthenticity.org/docs/trustmark/js/>; model sizes measured from `cai-watermark.adobe.net/watermarking/trustmark-models/` (decoder_Q/P ≈ 47 MB)
* Digimarc C2PA extension (reference architecture): <https://github.com/digimarc-corp/c2pa-content-credentials-extension>
* ExifReader: <https://github.com/mattiasw/ExifReader>
* MV3: <https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/>, <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_Security_Policy>
