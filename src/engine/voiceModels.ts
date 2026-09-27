// Voice-check (T11) model registry. Kept apart from the text registry
// (./models.ts): these are raw onnxruntime-web models (not transformers.js
// pipelines), one ONNX file each, with no tokenizer and no dtype variants.
//
// The files are int8 dynamic-quantised exports of the upstream fp32 ONNX
// (made in the T11 spike, docs/voice-spike.md; same scores within ±1.5 pt
// EER), hosted as GitHub Release assets of this project (release
// `models-v1`). Integrity: the exact byte count and sha256 are checked while
// downloading, and the session is never created on a mismatch.
// `upstream`/`upstreamRevision` record the source for attribution.
//
// Input `wav[B,64600]` (4.04 s at 16 kHz), output `logits[B,2]`, index 1 =
// bona fide. Pure module: the options/popup UI imports it for sizes/labels.

import type { VoiceModelId } from "../voice/aggregate";

export interface VoiceModelSpec {
  id: VoiceModelId;
  label: string;
  url: string;
  sha256: string;
  bytes: number;
  license: string;
  upstream: string;
  upstreamRevision: string;
  /** Short note shown next to the model in settings. */
  note: string;
  /** Spectra-AASIST3 expects 0.97 preemphasis on the waveform. */
  preemphasis: boolean;
}

const RELEASE = "https://github.com/freddygaffey/local-ai-detector/releases/download/models-v1/";

export const VOICE_MODELS: Record<VoiceModelId, VoiceModelSpec> = {
  voiceSpectraAasist3: {
    id: "voiceSpectraAasist3",
    label: "Spectra-AASIST3 (voice)",
    url: RELEASE + "spectra-aasist3.int8.onnx",
    sha256: "444f832d306a2be4f823119f84e698e8821db6a1aab248593d4b05b7a9a48108",
    bytes: 364_036_647,
    license: "apache-2.0",
    upstream: "lab260/Spectra-AASIST3",
    upstreamRevision: "bc0ded888080ddad493177bb53aa6f5b95219d7c",
    note: "training data undisclosed",
    preemphasis: true,
  },
  voiceW2V2Aasist: {
    id: "voiceW2V2Aasist",
    label: "W2V2-AASIST (voice)",
    url: RELEASE + "w2v2-aasist.int8.onnx",
    sha256: "e3b7a3202479a07c27e15a375d36c41428f11a1d3653670ff3b5396857738d56",
    bytes: 357_368_277,
    license: "mit",
    upstream: "SpeechAntiSpoofingBenchmarks/W2V2-AASIST",
    upstreamRevision: "196128e5a5101d5cb6ac7701597891bc7de7e7b5",
    note: "ASVspoof 2019 data (ODC-BY); misses most modern TTS at Strict",
    preemphasis: false,
  },
};

export const DEFAULT_VOICE_MODEL: VoiceModelId = "voiceSpectraAasist3";
export const VOICE_MODEL_IDS = Object.keys(VOICE_MODELS) as VoiceModelId[];

/** Download URL, also the cache key. */
export function voiceModelUrl(spec: VoiceModelSpec): string {
  return spec.url;
}
