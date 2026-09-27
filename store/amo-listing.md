# addons.mozilla.org (AMO) listing text

For the AMO submission form (listed or unlisted — see
[`../docs/release.md`](../docs/release.md) for the difference and the exact
submission steps). Permission justifications and the
`data_collection_permissions` declaration are in
[`permissions.md`](permissions.md). Screenshots:
[`../docs/screenshots/`](../docs/screenshots/) (the Firefox-specific ones:
`firefox-popup.png`, `firefox-options.jpg`, `firefox-page-heatmap.jpg`).

## Category

**Privacy & Security** is the best fit (AMO's category list is separate from
Chrome's) — the extension's whole value proposition is a privacy-respecting,
fully local alternative to cloud AI-detection services. **Web Development**
or a general "Other" category are reasonable alternates if that category
doesn't exist or fit by the time you submit.

## Summary (AMO's short "Add-on Description" summary field, ~250 characters)

```
Filter AI-generated content. Runs on your device. Scores text, comments and
images for AI-generated writing/watermarks entirely locally — no servers, no
API keys, no data collection.
```

## Full description

```
Local AI Detector analyzes the text and images on the page you're reading
for signs of AI generation — entirely on your device, with no servers, no
API keys, no accounts, and no data collection.

FEATURES

• Five detector modes: Ensemble (default), Classifier, Classifier-lite,
  Perplexity, and experimental Binoculars — all on-device ML, no cloud API.
• Three highlight styles for flagged sentences: heatmap, flagged-only, or
  underline.
• A hidden/invisible-Unicode-character report, always shown separately from
  the AI score.
• Image provenance and watermark checks: C2PA Content Credentials (verified
  against a bundled, attributed trust list), unsigned generator metadata,
  and open-source Stable Diffusion/SDXL/FLUX invisible watermarks — with an
  honest list of schemes that CAN'T be checked locally (Google SynthID,
  Anthropic's and Gemini's text watermarks, Meta Content Seal, and others)
  rather than pretending they don't exist.
• Model updates you control: check for newer model revisions, see their
  licence before updating, and roll back if needed. Bring your own custom
  Hugging Face model per detector slot.

PRIVACY

Every analysis runs locally, in your browser. The only network requests are:
downloading/updating AI models directly from huggingface.co (once you
consent, or when you ask to check for updates), and — only for a website
you've explicitly granted permission to, one site at a time — fetching a
single image's bytes to check its provenance. See our privacy policy (linked
from the extension's Options page and its source repository) for the
complete, exact accounting. This add-on declares no data collection to
Mozilla, because it collects none.

ACCURACY, HONESTLY

This is a small, transparently-documented project, not a commercial
forensic tool. It's calibrated to rarely flag real human writing (about a 1%
false-positive rate on a held-out benchmark), which means it misses a
substantial share of AI-generated text too, especially anything paraphrased
or lightly edited. Full methodology, numbers, and caveats are published in
the source repository rather than a vague marketing accuracy claim.

OPEN SOURCE

MIT-licensed. Every bundled library and model is under an open licence
(MIT/Apache-2.0/MPL-2.0) — nothing gated or non-commercial. Source code,
architecture notes, and the full calibration methodology are linked from the
extension's Options page.
```

## Notes for whoever fills in the AMO form

- **Source code is always required** for this add-on: it bundles built/
  minified JavaScript and WebAssembly, which AMO's automated check flags for
  mandatory source review regardless of listed/unlisted status. Upload
  `release/local-ai-detector-<version>-sources.zip` (built by
  `npm run package`) when prompted — see
  [`../docs/release.md`](../docs/release.md) for exactly where that happens
  in the submission flow, and [`../BUILD_FROM_SOURCE.md`](../BUILD_FROM_SOURCE.md)
  (included in that zip) for the reviewer-facing build instructions.
- License field on AMO: **MIT**.
- Support/homepage URL: the source repository.
- Privacy policy: paste in the text of, or a stable link to,
  [`../PRIVACY.md`](../PRIVACY.md).
