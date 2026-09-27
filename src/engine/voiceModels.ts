// Voice-check (T11) model registry. Kept apart from the text registry
// (./models.ts): these are raw onnxruntime-web models (not transformers.js
// pipelines), one ONNX file each, with no tokenizer and no dtype variants.
// Both load straight from the authors' Hugging Face repos, pinned to an exact
// commit; the sha256 (the file's Git LFS oid at that commit, and checked
// against the T11 spike's local copies) is verified while downloading.
//
// Input `wav[B,64600]` (4.04 s at 16 kHz), output `logits[B,2]`, index 1 =
// bona fide. Pure module: the options/popup UI imports it for sizes/labels.

import type { VoiceModelId } from "../voice/aggregate";

export interface VoiceModelSpec {
  id: VoiceModelId;
  label: string;
  repo: string;
  revision: string;
  file: string;
  sha256: string;
  bytes: number;
  license: string;
  /** Short note shown next to the model in settings. */
  note: string;
  /** Spectra-AASIST3 expects 0.97 preemphasis on the waveform. */
  preemphasis: boolean;
}

export const VOICE_MODELS: Record<VoiceModelId, VoiceModelSpec> = {
  voiceSpectraAasist3: {
    id: "voiceSpectraAasist3",
    label: "Spectra-AASIST3 (voice)",
    repo: "lab260/Spectra-AASIST3",
    revision: "bc0ded888080ddad493177bb53aa6f5b95219d7c",
    file: "spectra-aasist3.onnx",
    sha256: "5f05c29a01ad80c702b32654db87c2aa6e467c11c67b6d47f2fac873f846cae9",
    bytes: 1_279_022_864,
    license: "apache-2.0",
    note: "training data undisclosed",
    preemphasis: true,
  },
  voiceW2V2Aasist: {
    id: "voiceW2V2Aasist",
    label: "W2V2-AASIST (voice)",
    repo: "SpeechAntiSpoofingBenchmarks/W2V2-AASIST",
    revision: "196128e5a5101d5cb6ac7701597891bc7de7e7b5",
    file: "w2v2-aasist.onnx",
    sha256: "837169def567cd68d94f7b5a6bd7ef55a7b64ea9cec61364944bcb66521e92d3",
    bytes: 1_264_789_106,
    license: "mit",
    note: "ASVspoof 2019 (ODC-BY); misses most modern TTS at Strict",
    preemphasis: false,
  },
};

export const DEFAULT_VOICE_MODEL: VoiceModelId = "voiceSpectraAasist3";
export const VOICE_MODEL_IDS = Object.keys(VOICE_MODELS) as VoiceModelId[];

/** Same key shape transformers.js uses, so the model-cache admin (cachePrefix) sees these files too. */
export function voiceModelUrl(spec: VoiceModelSpec): string {
  return `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${spec.file}`;
}
