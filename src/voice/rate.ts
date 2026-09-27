// Which sampling rate to use. The Quick/Deep tiers work (branch `tiers`) may
// add a top-level `tier` setting; it is read defensively here, so this works
// with or without it:
//   an explicit non-default rate preset always wins;
//   otherwise tier "quick" -> Light, "deep" -> Thorough;
//   otherwise Normal.
// The battery saver's forced Light is applied later (schedule.effectiveRate).

import type { VoiceRate } from "./schedule";
import { sanitizeVoice, type VoiceSettings } from "./settings";

export function resolveVoiceRate(settings: { voice?: Partial<VoiceSettings> } & Record<string, unknown>): VoiceRate {
  const v = sanitizeVoice(settings.voice);
  if (v.rate !== "normal") return v.rate;
  const tier = typeof settings.tier === "string" ? settings.tier.toLowerCase() : undefined;
  if (tier === "quick") return "light";
  if (tier === "deep") return "thorough";
  return "normal";
}
