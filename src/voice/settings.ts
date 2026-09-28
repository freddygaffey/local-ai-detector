// Voice check (experimental) settings, T11. Merged into the shared Settings as
// `settings.voice` (src/shared/settings.ts). Pure.

import type { VoiceModelId, VoiceSensitivity } from "./aggregate";
import type { VoiceRate } from "./schedule";

/** "autoAll": any site's playing video (default); "autoYouTube": YouTube only, elsewhere on click. */
export type VoiceRun = "autoAll" | "autoYouTube" | "onClick";

export interface VoiceSettings {
  /** On by default (user decision): catches clean TTS narration. */
  enabled: boolean;
  model: VoiceModelId;
  run: VoiceRun;
  sensitivity: VoiceSensitivity;
  rate: VoiceRate;
}

export const DEFAULT_VOICE: VoiceSettings = {
  enabled: true,
  model: "voiceSpectraAasist3",
  run: "autoAll",
  sensitivity: "strict",
  rate: "normal",
};

const MODELS: readonly VoiceModelId[] = ["voiceSpectraAasist3", "voiceW2V2Aasist"];
const RUNS: readonly VoiceRun[] = ["autoAll", "autoYouTube", "onClick"];
const SENS: readonly VoiceSensitivity[] = ["strict", "balanced", "sensitive"];
const RATES: readonly VoiceRate[] = ["light", "normal", "thorough", "continuous"];

/** Fills missing/unknown fields (older or newer stored settings) with defaults. */
export function sanitizeVoice(v: Partial<VoiceSettings> | undefined): VoiceSettings {
  const pick = <T>(val: T | undefined, ok: readonly T[], d: T): T => (val !== undefined && ok.includes(val) ? val : d);
  return {
    enabled: typeof v?.enabled === "boolean" ? v.enabled : DEFAULT_VOICE.enabled,
    model: pick(v?.model, MODELS, DEFAULT_VOICE.model),
    run: pick(v?.run, RUNS, DEFAULT_VOICE.run),
    sensitivity: pick(v?.sensitivity, SENS, DEFAULT_VOICE.sensitivity),
    rate: pick(v?.rate, RATES, DEFAULT_VOICE.rate),
  };
}
