# Chrome Web Store listing text

For the Developer Dashboard's listing fields. Permission justifications and
the data-collection declaration are in [`permissions.md`](permissions.md)
(copy those into the dashboard's separate "Permissions justification" and
"Data usage" forms). Promo images: [`promo/`](promo/). Screenshots:
[`../docs/screenshots/`](../docs/screenshots/).

## Category

**Productivity** (or **Tools**, if Chrome's current category list splits
them differently by the time you submit — pick whichever is closest; this
isn't a niche pick specific to one category taxonomy version). Not
"Accessibility": it doesn't change how a page is rendered or read, only adds
an analysis overlay.

## Short description (132 characters max)

```
Filter AI-generated content. Runs on your device. Free, open-source, no servers, no API keys, no accounts.
```

(101 characters.)

## Single-purpose statement

See [`permissions.md`](permissions.md#single-purpose-statement-chrome-web-store).

## Long description

```
Local AI Detector analyzes the text and images on the page you're reading for
signs of AI generation — entirely on your device. No servers, no API keys, no
accounts, no data collection of any kind.

WHAT IT DOES

• Scores visible text sentence-by-sentence using an on-device AI-text
  classifier and/or a perplexity model (your choice: Ensemble, Classifier,
  Classifier-lite, Perplexity, or experimental Binoculars mode), and
  highlights flagged sentences directly on the page (heatmap, flagged-only,
  or underline style).
• Flags hidden/invisible Unicode characters in text (shown separately, never
  counted as "AI evidence" — ordinary typography and copy-pasting from Word
  or PDFs produce these too).
• Checks images for C2PA Content Credentials (cryptographically verified
  against a bundled trust list), unsigned generator metadata (Stable
  Diffusion, Midjourney, NovelAI, and others), and open-source invisible
  watermarks (Stable Diffusion/SDXL/FLUX). Clearly labels what CAN'T be
  checked locally too (e.g. Google SynthID, Anthropic's and Gemini's text
  watermarks) rather than staying silent about it.

WHY IT'S DIFFERENT

• 100% local. All analysis — text scoring, image checks — runs in your
  browser. The only network requests this extension ever makes are
  downloading AI models from Hugging Face (once, after you consent, ~130–210
  MB depending on mode) and, only for a site you've explicitly allowed,
  fetching one image's bytes to check it. Full accounting in our privacy
  policy.
• Honest about accuracy. This is not a forensic tool and doesn't pretend to
  be one. It's tuned to rarely flag real human writing (about 1 false
  positive per 100 human texts on a held-out benchmark) — which means it
  also misses a lot of AI-generated text, especially anything paraphrased.
  We publish the actual numbers and their limitations rather than a vague
  "99% accurate" claim.
• Fully open source (MIT licence). Every model and library it bundles is
  openly licensed (MIT/Apache-2.0/MPL-2.0); nothing gated, nothing
  non-commercial. Read the code, the calibration methodology, and the
  research behind every provenance signal it checks.

WHAT IT DOESN'T DO

It doesn't claim certainty. "No watermark found" is shown as exactly that —
not as proof of human authorship. It doesn't send your browsing or any page
content anywhere. It doesn't require an account, a subscription, or an API
key. It doesn't work by calling a cloud AI-detection API — everything runs
on your own machine.

Source code, full technical documentation (architecture, calibration
methodology, provenance research), and the privacy policy are linked from
the extension's own Options page and from its source repository.
```

## Notes for whoever fills in the dashboard

- Chrome's "Data usage" form: see
  [`permissions.md`](permissions.md#data-usage-disclosures-chrome-web-store-data-collection-form) —
  declare no data collection.
- Homepage / support URL: point at the source repository (or an issues page
  there) — there's no separate support site.
- Privacy policy URL: publish [`../PRIVACY.md`](../PRIVACY.md) somewhere with
  a stable URL (e.g. the repository's rendered file on GitHub) and paste that
  URL into the listing's privacy policy field.
