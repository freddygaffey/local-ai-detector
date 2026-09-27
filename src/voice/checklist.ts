// Voice-check rows for the model download checklist (src/ui/modelChecklist.ts
// `extraRows`). One row per voice model; they act like radio buttons: ticking
// one turns the voice check on with that model, unticking the active one
// turns the voice check off. Defaults: Spectra ticked, W2V2 unticked.

import { VOICE_MODELS, VOICE_MODEL_IDS } from "../engine/voiceModels";
import type { ExtraChecklistRow } from "../ui/modelChecklist";
import type { VoiceModelId } from "./aggregate";
import { sanitizeVoice, type VoiceSettings } from "./settings";

/** Pure: the voice settings after ticking/unticking `id`. */
export function toggleVoiceModel(voice: VoiceSettings, id: VoiceModelId, checked: boolean): VoiceSettings {
  if (checked) return { ...voice, enabled: true, model: id };
  if (voice.model === id) return { ...voice, enabled: false };
  return voice;
}

export function voiceChecklistRows(
  voiceIn: Partial<VoiceSettings> | undefined,
  onChange: (next: VoiceSettings) => void,
  cached: Partial<Record<VoiceModelId, boolean>> = {},
): ExtraChecklistRow[] {
  const voice = sanitizeVoice(voiceIn);
  return VOICE_MODEL_IDS.map((id) => {
    const spec = VOICE_MODELS[id];
    return {
      key: id,
      label: spec.label,
      role: `Voice check (experimental)${id === "voiceSpectraAasist3" ? "; training data undisclosed" : ""}.`,
      sizeBytes: spec.bytes,
      checked: voice.enabled && voice.model === id,
      cached: cached[id] === true,
      onToggle: (checked: boolean) => onChange(toggleVoiceModel(voice, id, checked)),
    };
  });
}
