// Static list of watermark/provenance schemes that CANNOT be checked locally
// (docs/watermarks.md "Label explicitly as 'cannot be checked locally'").
// The UI shows these in an info panel. Checker links are user-initiated
// external links only: never opened or uploaded to automatically.

import type { UncheckableScheme } from "./types";

export const UNCHECKABLE_SCHEMES: readonly UncheckableScheme[] = [
  {
    id: "synthid",
    name: "Google SynthID (image, video, audio)",
    usedBy: "Google Gemini/Imagen/Veo/Lyria; OpenAI images (since May 2026) and audio; ElevenLabs audio",
    media: "image, video, audio",
    why: "Proprietary detector with secret keys. There is no public or offline decoder.",
    checker: { label: "SynthID Detector", url: "https://deepmind.google/models/synthid/" },
  },
  {
    id: "openai-verify",
    name: "OpenAI image/audio provenance (SynthID-based)",
    usedBy: "ChatGPT / OpenAI API images and audio",
    media: "image, audio",
    why: "OpenAI's invisible mark is checked only by OpenAI's own tool. We still read OpenAI's C2PA Content Credentials locally when they survive.",
    checker: { label: "OpenAI verification tool", url: "https://openai.com/verify" },
  },
  {
    id: "synthid-text",
    name: "Gemini text watermark (SynthID-Text)",
    usedBy: "Google Gemini",
    media: "text",
    why: "Detection needs Google's secret key. Without it the statistic is noise.",
    checker: { label: "Gemini app", url: "https://gemini.google.com/" },
  },
  {
    id: "claude-text",
    name: "Anthropic Claude text watermark",
    usedBy: "Claude models (rolling out from Aug 2026)",
    media: "text",
    why: "Keyed statistical watermark; Anthropic's detector is a private preview for vetted organisations.",
    checker: { label: "Anthropic announcement", url: "https://www.anthropic.com/news/claude-text-watermark" },
  },
  {
    id: "meta-content-seal",
    name: "Meta Content Seal",
    usedBy: "Meta Muse Image (video planned)",
    media: "image",
    why: "Proprietary detector, checked only through Meta's rate-limited portal.",
    checker: { label: "Meta identification", url: "https://www.meta.ai/identification" },
  },
  {
    id: "digimarc",
    name: "Digimarc watermark",
    usedBy: "Digimarc customers; C2PA durable credentials",
    media: "image, video, audio",
    why: "Proprietary detector and remote lookup.",
  },
  {
    id: "trustmark",
    name: "Adobe TrustMark (durable Content Credentials)",
    usedBy: "Adobe Firefly / Creative Cloud durable credentials",
    media: "image",
    why: "The decoded ID means nothing on its own: it must be resolved through a remote soft-binding service, which breaks 'local only'.",
  },
  {
    id: "openai-text",
    name: "OpenAI text",
    usedBy: "ChatGPT",
    media: "text",
    why: "OpenAI built a text watermark but has not shipped it, so there is nothing to check.",
  },
  {
    id: "keyed-llm",
    name: "Keyed academic LLM watermarks (Kirchenbauer, Aaronson, ...)",
    usedBy: "Self-hosted models configured by their operators",
    media: "text",
    why: "Detection needs the operator's key or hash scheme, which no major model publishes.",
  },
  {
    id: "midjourney-grok",
    name: "Midjourney / xAI Grok invisible marks",
    usedBy: "Midjourney, Grok",
    media: "image",
    why: "No invisible watermark is publicly known. Midjourney metadata (IPTC/XMP) is checked locally when present; Grok has only a visible logo.",
  },
];

/** Standard honesty wording for the UI. */
export const NO_SIGNALS_WORDING =
  "No provenance signals found. This does not mean the image is human-made: most sites strip metadata and Content Credentials, and invisible watermarks are fragile.";

export const WATERMARK_MISS_WORDING =
  "Open-source invisible watermark: not found (fragile: resizing, cropping or re-encoding removes it, so this is not evidence of anything).";
