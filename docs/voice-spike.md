# T11 spike: AI voice detection in page audio

Investigated 2026-09-27. The evidence comes from Hugging Face API listings and model cards, the
GitHub licence API, and a local prototype. The prototype ran onnxruntime 1.30 on CPU, plus
Playwright Chromium 153 and Firefox 155 for audio capture. The scripts and data are in the
session scratchpad (`t11/`) and are not committed.

## Verdict: **ship as experimental, on click only, behind a separate opt-in download**

- **Model:** `lab260/Spectra-AASIST3` (Apache-2.0), dynamically quantised to int8 (364 MB), run
  with onnxruntime-web directly.
- **Chip wording:** `Voice: AI 72%`. The tooltip should say:
  `Experimental. Misses some AI voices, esp. with music.`
- **Scope:** analyse a sample of about 30 s from the current playback position, then stop. Never
  run it continuously or automatically.

Why experimental and not "ship":
1. The test set is small and the TTS is open-source only. We could not test ElevenLabs, OpenAI,
   or other commercial voices without paid access. These are what most YouTube AI voice-overs
   use, so real-world recall is **unknown**. The best public data point is not encouraging:
   open detectors lose about 48% AUC on in-the-wild 2024 audio deepfakes
   ([Deepfake-Eval-2024](https://arxiv.org/abs/2503.02857)).
2. Background music or noise at 10–15 dB SNR halves recall at the default threshold
   (100% → 42–69% for Kokoro).
3. The recommended model's **training data is undisclosed**. It is an unpublished model and its
   sibling `lab260/AASIST3` was trained on MLAAD, which is CC-BY-NC. Before shipping, ask the
   author (contact is on the card) to confirm the training-data licences. If the answer is
   non-commercial data, fall back to W2V2-AASIST (below). That fallback is noticeably worse.
4. The download is heavy: 364 MB, more than the whole text stack (about 211 MB).

It is not "drop" because the recommended model had **0% false positives on human speech** in
every condition, and it survives YouTube's codecs and loudness normalisation untouched. A
positive result is therefore meaningful. A negative result is not, and the UI must not imply
that one is.

## 1. Candidate models

The EERs are from the reproducible [Speech Anti-Spoofing Arena](https://huggingface.co/spaces/SpeechAntiSpoofingBenchmarks/SpeechAntiSpoofingArena).
In-domain means ASVspoof2019 LA. Every one of these ONNX exports takes `wav[B,64600]` (4.04 s at
16 kHz) and returns `logits[B,2]`, with index 1 = bona fide. **None is a transformers.js pipeline
model.** Load them with the `onnxruntime-web` that transformers.js already bundles.

| Model (HF) | Arch | Weights licence | Training data (licence) | ONNX | Arena EER: ITW / 21DF / CD-ADD / ASV5 | Status |
|---|---|---|---|---|---|---|
| [`lab260/Spectra-AASIST3`](https://huggingface.co/lab260/Spectra-AASIST3) | XLS-R 300M + KAN-AASIST, 319M params | Apache-2.0 | **Undisclosed** (unpublished model) | yes, 1.28 GB fp32; int8 364 MB (made here) | **1.20 / 4.30 / 0.00 / 15.1** | **Recommended**, pending data check |
| [`SpeechAntiSpoofingBenchmarks/W2V2-AASIST`](https://huggingface.co/SpeechAntiSpoofingBenchmarks/W2V2-AASIST) ([code](https://github.com/TakHemlata/SSL_Anti-spoofing), MIT) | XLS-R 300M + AASIST | MIT | ASVspoof2019 LA ([ODC-BY](https://zenodo.org/records/6906306)) | yes, 1.26 GB; int8 357 MB | 11.2 / 8.3 / 38.6 / 16.3 | Clean-provenance fallback |
| [`SpeechAntiSpoofingBenchmarks/XLSR-SLS`](https://huggingface.co/SpeechAntiSpoofingBenchmarks/XLSR-SLS) | XLS-R 300M + SLS | MIT on HF; upstream [repo](https://github.com/QiShanZhang/SLSforASVspoof-2021-DF) has **no licence** | ASVspoof2019 LA (ODC-BY) | yes, 1.36 GB | 7.5 / 3.9 / 9.8 / 18.8 | Tested, but worst on our set |
| [`SpeechAntiSpoofingBenchmarks/AASIST`](https://huggingface.co/SpeechAntiSpoofingBenchmarks/AASIST) ([clovaai](https://github.com/clovaai/aasist), MIT) | AASIST (raw waveform) | MIT | ASVspoof2019 LA (ODC-BY) | yes, **1.6 MB** | weak out of domain | Tested; too many false positives |
| [`SpeechAntiSpoofingBenchmarks/Nes2Net`](https://huggingface.co/SpeechAntiSpoofingBenchmarks/Nes2Net), `WhisperMFCCMesoNet`, `RawTFNet` | various | MIT on HF (Nes2Net upstream has no licence) | ASVspoof | yes | WhisperMFCCMesoNet ITW 26.7 | Not tested |
| [`garystafford/wav2vec2-deepfake-voice-detector`](https://huggingface.co/garystafford/wav2vec2-deepfake-voice-detector) | wav2vec2-large-XLSR | Apache-2.0 | 1.9k clips incl. ElevenLabs, Kokoro; CC-BY-4.0, but "real" = 14 YouTube videos | no (exportable with optimum) | self-reported only | Not tested: tiny data, leakage risk |
| [`facebook/audioseal`](https://huggingface.co/facebook/audioseal) / [`synath/audioseal-onnx`](https://huggingface.co/synath/audioseal-onnx) | watermark detector | MIT | n/a | yes, detector 35 MB | n/a (see §2.3) | Works, but almost no content carries it |
| **Excluded:** [`Speech-Arena-2025/DF_Arena_*`](https://huggingface.co/Speech-Arena-2025/DF_Arena_1B_V_1) (ITW 0.91) | XLS-R 1B / 500M | **non-commercial** | incl. MLAAD | none | | licence |
| **Excluded:** `nii-yamagishilab/*-anti-deepfake` (`SpeechAntiSpoofingBenchmarks/*-AntiDeepfake`) | wav2vec2/XLS-R/MMS | **CC-BY-NC-SA-4.0** | | yes | | licence |
| **Excluded:** [`lab260/AASIST3`](https://huggingface.co/lab260/AASIST3) | | **CC-BY-NC-4.0** | MLAAD (CC-BY-NC), ASVspoof5 | yes | | licence |
| **Excluded:** `eliya/forensics_0.3B_wavlm_oc_softmax…` | WavLM-large | **CC-BY-NC-4.0** | | | | licence |
| **Excluded:** `mo-thecreator/*`, `MelodyMachine/*`, `Vansh180/*` (+ `ai8shiro/…-ONNX`), `abhishtagatya/*` | wav2vec2-base | Apache/MIT or none | undocumented, or ASVspoof-PA / ITW (CC-BY-SA-4.0) | some | none reproducible | Unknown data, no credible eval |

Dataset licences: ASVspoof 2019 and ASVspoof 5 are ODC-BY ([Zenodo](https://zenodo.org/records/14498691)),
In-the-Wild is CC-BY-SA-4.0, and MLAAD is **CC-BY-NC-4.0**.

## 2. Prototype results

### 2.1 Test set (small by design)
- **Human, 60 clips:** 24 LibriSpeech test-clean clips (CC-BY-4.0, 22 speakers) and 36 LibriVox
  clips (public domain, 12 books, 8 s each). All are read speech, not vlog-style.
- **AI, 108 clips:** 36 texts, 24 from LibriSpeech transcripts plus 12 YouTube-style narration
  lines, each voiced by three systems:
  - Kokoro-82M int8 (Apache-2.0, StyleTTS2-class, 2025), 8 voices
  - Piper (VITS), 3 voices
  - macOS `say`, 6 voices
- **Conditions:**
  - clean
  - AAC 128k and AAC 64k, re-encoded at 48 kHz
  - Opus 64k
  - loudnorm (−14 LUFS) + AAC 128k
  - public-domain music (Musopen) at 15 dB and 10 dB SNR + AAC 128k
  - pink noise at 10 dB SNR + AAC 128k
- **Scoring:** up to three 4.04 s windows per clip (one "10 s chunk"). The score is the mean
  spoof−bona-fide logit margin; `p>0.5` means that margin is > 0.

### 2.2 Results

**Spectra-AASIST3** (int8 gives identical numbers, within ±1.5 pt EER):

| Condition | EER | AUROC | Human flagged (p>0.5) | AI caught (p>0.5), Kokoro / Piper / say |
|---|---|---|---|---|
| clean | 2.7% | 0.987 | **0%** | 100 / 83 / 100% |
| AAC 128k | 2.2% | 0.989 | 0% | 100 / 81 / 100% |
| AAC 64k | 1.8% | 0.990 | 0% | 94 / 78 / 100% |
| Opus 64k | 2.2% | 0.989 | 0% | 97 / 75 / 100% |
| loudnorm + AAC | 1.4% | 0.992 | 0% | 97 / 75 / 100% |
| music 15 dB | 11.9% | 0.967 | 0% | 64 / 50 / 100% |
| music 10 dB | 10.9% | 0.961 | 0% | 69 / 53 / 100% |
| noise 10 dB | 9.6% | 0.969 | 0% | 42 / 56 / 100% |

**Other models (EER / human false-positive rate at p>0.5):**

| Condition | W2V2-AASIST | XLSR-SLS | AASIST (1.6 MB) |
|---|---|---|---|
| clean | 7.0% / 37% | 20.2% / 22% | 10.9% / 22% |
| AAC 64k | 8.8% / 37% | 18.4% / 25% | 8.4% / 22% |
| Opus 64k | 6.6% / 38% | 21.6% / 23% | 9.6% / 23% |
| loudnorm + AAC | 8.3% / 55% | 17.1% / 17% | 25.0% / 63% |
| music 10 dB | 9.6% / 42% | 22.3% / 26% | 11.4% / 63% |
| noise 10 dB | 10.9% / 65% | 18.4% / 30% | 11.4% / 57% |

Recalibrating W2V2-AASIST to 5% FPR on clean audio gives about 90% recall. The FPR then rises to
25% under loudnorm or noise. That makes it usable only with a strict threshold and wording that
leans towards "uncertain".

What the results mean:
- **Codecs do not hurt.** Loudness normalisation badly hurts the small and older models. Music
  and noise are the real problem: Spectra's EER goes from about 2% to 10–12%.
- **Human false positives drive the ranking.** Only Spectra-AASIST3 never flagged a human.
- **Caveats:**
  - About 10–30 clips per cell, so each percentage point is roughly one clip. Treat the numbers
    as directional.
  - The human set is clean read speech. YouTube vlogs (room reverb, phone mics, heavy mastering)
    are untested and are likely to raise false positives.
  - Spectra's perfect Kokoro score may reflect Kokoro-like data in its undisclosed training set.
- **Commercial TTS is untested.** We could not test ElevenLabs, OpenAI or other commercial TTS
  without paid access. The public evidence (Deepfake-Eval-2024, and SONAR at 24% EER for
  XLSR-SLS) says recall on these drops sharply. Expect the feature to **miss** many real AI
  voice-overs. Its useful property is a low false-alarm rate, not coverage.

### 2.3 AudioSeal (MIT watermark)
Tested on 12 watermarked Kokoro clips and 12 unwatermarked human clips. Detection means a mean
frame score > 0.5.

| Condition | Watermarked, detected | Unwatermarked, false alarm |
|---|---|---|
| clean | 100% | 0% |
| AAC 128k / 64k | 100% | 0% |
| Opus 64k | 100% | 0% |
| loudnorm + AAC | 100% | 0% |
| music 15 dB | 54% | 0% |
| music 10 dB | 38% | 0% |
| noise 10 dB | 8% | 0% |

- It is cheap: 35 MB and 0.02 s CPU per audio second.
- Inputs must be padded to a multiple of 320 samples.
- Only audio made with AudioSeal-enabled generators (Meta research models) carries the mark, so
  it would almost never fire on YouTube. Keep it v2, as the plan says.

### 2.4 Runtime (CPU, native onnxruntime, 4 threads, Apple M5 shared with other heavy jobs)

| Model | Per 4 s window | Per 10 s chunk (3 windows) |
|---|---|---|
| Spectra-AASIST3 fp32 | 0.47 s | ~1.4 s |
| Spectra-AASIST3 int8 | 0.38–0.48 s | ~1.2–1.4 s |
| W2V2-AASIST | 0.29 s | ~0.9 s |
| XLSR-SLS | 0.24 s | ~0.7 s |
| AASIST | 0.10 s | 0.3 s |

In-browser WASM was not timed. A benchmark harness is written but was not run, to keep the spike
short. Expect WASM to be 2–4× slower: about 3–5 s per 10 s chunk on Chrome with threads, and
more on Firefox, which is single-threaded (bug 1673477). WebGPU should bring this under 1 s.

The cost is fine for a 30 s sample on click, and too high for continuous analysis, both for
battery and because of the 364 MB of RAM for weights.

## 3. Browser mechanics (measured in Playwright Chromium 153 / Firefox 155)

| Case | Chrome `captureStream()` | Firefox `captureStream()` / `mozCaptureStream()` |
|---|---|---|
| Same-origin file | audio OK | audio OK |
| **MSE `blob:` source (how YouTube plays)** | audio OK | audio OK |
| MSE with segments fetched cross-origin with CORS (YouTube's googlevideo) | audio OK | audio OK |
| Cross-origin file, no CORS | **throws `SecurityError`** | **silent track** (RMS 0) |
| Cross-origin file with CORS + `crossOrigin=anonymous` | OK | OK |
| Element muted by capture? | no | no (the old muting bug [1178751](https://bugzilla.mozilla.org/show_bug.cgi?id=1178751) no longer reproduces) |

- Firefox exposes unprefixed `captureStream()` since
  [Firefox 149](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/149).
  `mozCaptureStream` still exists; feature-detect both.
- EME/DRM media (paid films) yields no usable audio. Handle it as "Voice: unavailable".
- **Recommended capture path, both browsers:**
  1. On click, the content script calls `video.captureStream()`.
  2. It feeds the stream into `new AudioContext({sampleRate: 16000})`, which is verified to
     resample natively in both browsers, so no manual resampler is needed.
  3. An AudioWorklet collects 64,600-sample windows.
  4. The windows go as transferable/`Float32Array` → plain-array or base64 messages to the
     offscreen doc (Chrome) or worker (Firefox).

  This needs no new permission and shows no indicator. Messaging copies about 250 KB per 4 s
  window, which is acceptable.
- **`chrome.tabCapture` (fallback, Chrome only)** covers audio that `captureStream` cannot reach,
  such as Web Audio players and cross-origin iframes.
  - Needs the `tabCapture` permission (install-time warning) and a user gesture on the action.
  - Flow: `chrome.tabCapture.getMediaStreamId()` in the SW → offscreen doc
    (reason `USER_MEDIA`, Chrome 116+) → `getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',…}}})`.
  - **The tab goes silent while captured.** Re-route it with
    `ctx.createMediaStreamSource(s).connect(ctx.destination)`.
  - Chrome shows its tab capture indicator (not verified here).

  Sources: [tabCapture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture),
  [screen-capture how-to](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture).
  The extra permission is not worth it for v0.2; skip it.
- **Firefox** has no tabCapture equivalent
  ([1443484](https://bugzilla.mozilla.org/show_bug.cgi?id=1443484) closed as a duplicate) and no
  `getDisplayMedia` audio ([1541425](https://bugzilla.mozilla.org/show_bug.cgi?id=1541425), NEW).
  `captureStream` is the only route.

## 4. If built: pipeline

1. **Click.** The user presses "Check voice". The first time, a consent dialog shows the
   364 MB download.
2. **Capture.** `captureStream` → 16 kHz AudioContext → AudioWorklet. Collect about 30 s of
   playback, skipping silence with an RMS gate.
3. **Windows.** Send 4.04 s windows with a 3 s hop to the offscreen doc/worker.
   - Apply preemphasis 0.97, which Spectra requires.
   - Run onnxruntime-web (WebGPU, falling back to WASM).
   - Compute `p = sigmoid(logit_spoof − logit_bonafide)` per window.
4. **Aggregate.** Take the median p over speech windows. Show
   `Voice: AI 72%` or `Voice: likely human`. Show `Voice: unclear` if there are fewer than 3
   speech windows or music dominates.
5. **Pin and credit.** Pin the model revision. Credit lab260 (Apache-2.0) in THIRD_PARTY.md.

## 5. Playback speed (measured 2026-09-28)

Spectra-AASIST3 int8, audio captured the extension's way (`captureStream`,
16 kHz, pitch preserved), AAC 128k, 60 single-voice streams (1,929 s human
incl. 24 held-out LibriVox segments, 681 s Kokoro/Piper/`say`), one window
per 4.04 s, speech-gated, Strict operating point.

| Speed | EER | AUROC | Human windows flagged | Human videos flagged (trimmed mean) | AI videos flagged |
|---|---|---|---|---|---|
| 1× | 5.0% | 0.986 | 4.3% | 0/39 | 19/20 |
| 1.25× | 3.2% | 0.989 | 7.2% | 0/38 | 20/20 |
| 1.5× | 2.6% | 0.987 | 5.5% | 0/37 | 19/20 |
| 2× | 4.9% | 0.971 | 12.5% | 0/37 | 19/19 |
| 2.5× | 17.4% | 0.854 | 33.8% | 11/38 | 18/18 |
| 3× | 43.1% | 0.593 | 68.4% | 24/37 | 20/20 |
| 2× → undone to 1× (WSOLA) | 41.3% | 0.630 | 72.8% | 32/39 | 19/19 |
| 3× → undone to 1× (WSOLA) | 41.3% | 0.599 | 91.0% | 37/37 | 20/20 |

- Played audio is usable up to 2×. From 2.5× the browser's pitch-preserving
  time-stretch reads as synthetic.
- Stretching it back to 1× makes it worse (a second set of stretch
  artefacts), so the extension never does that.
- **Design:** on YouTube the clips come from the audio the player itself
  downloads: a read-only page-world tap of its `videoplayback` responses
  (UMP parts, `src/voice/ump.ts`; `src/content/youtube/audioTap.ts`),
  decoded at original speed (`src/voice/sourceAudio.ts`). Independent of
  playback speed; verified in real Chrome (TED talk: 4 clips, Voice 22%).
  Other sites: the played audio, at 0.75–2× (`voiceRateOk`); outside that the
  card says so.
