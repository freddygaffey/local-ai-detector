// Options -> "Voice check (experimental)" section (T11). The options page
// passes its own row/control builders so this matches the other sections.

import { VOICE_MODELS, VOICE_MODEL_IDS } from "../engine/voiceModels";
import { sanitizeVoice, type VoiceSettings } from "./settings";
import { resolveVoiceRate } from "./rate";

export interface OptionsKit {
  h: (tag: string, attrs: Record<string, unknown> | null, ...children: (Node | string | null)[]) => HTMLElement;
  fieldRow(label: string, hint: string, control: HTMLElement): HTMLElement;
  selectControl(options: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLElement;
  toggleControl(checked: boolean, onChange: (checked: boolean) => void): HTMLElement;
}

export function renderVoiceSection(
  kit: OptionsKit,
  settings: { voice?: Partial<VoiceSettings> } & Record<string, unknown>,
  save: (voice: VoiceSettings) => void,
): HTMLElement {
  const v = sanitizeVoice(settings.voice);
  const set = (p: Partial<VoiceSettings>) => save({ ...v, ...p });
  const effective = resolveVoiceRate(settings);
  const list = kit.h(
    "div",
    { class: "settings-list" },
    kit.fieldRow("On", "Probability, not proof. Misses some AI voices, esp. with music.", kit.toggleControl(v.enabled, (c) => set({ enabled: c }))),
    kit.fieldRow(
      "Model",
      VOICE_MODELS[v.model].note,
      kit.selectControl(
        VOICE_MODEL_IDS.map((id) => ({ value: id, label: `${VOICE_MODELS[id].label.replace(" (voice)", "")} · ${Math.round(VOICE_MODELS[id].bytes / 1e6)} MB` })),
        v.model,
        (x) => set({ model: x as VoiceSettings["model"] }),
      ),
    ),
    kit.fieldRow(
      "Run",
      "On click: right-click a video → Check voice, or click the Voice chip.",
      kit.selectControl(
        [
          { value: "autoYouTube", label: "Auto on YouTube" },
          { value: "onClick", label: "On click" },
        ],
        v.run,
        (x) => set({ run: x as VoiceSettings["run"] }),
      ),
    ),
    kit.fieldRow(
      "Sensitivity",
      "Strict: no human voice flagged in our tests.",
      kit.selectControl(
        [
          { value: "strict", label: "Strict" },
          { value: "balanced", label: "Balanced" },
          { value: "sensitive", label: "Sensitive" },
        ],
        v.sensitivity,
        (x) => set({ sensitivity: x as VoiceSettings["sensitivity"] }),
      ),
    ),
    kit.fieldRow(
      "Rate",
      `4 s clips of watched playback, denser in the first 2 min. Battery saver uses Light.${effective !== v.rate ? ` Now: ${effective} (tier).` : ""}`,
      kit.selectControl(
        [
          { value: "light", label: "Light · 1 per 2 min" },
          { value: "normal", label: "Normal · 1 per min" },
          { value: "thorough", label: "Thorough · 1 per 20 s" },
          { value: "continuous", label: "Continuous" },
        ],
        v.rate,
        (x) => set({ rate: x as VoiceSettings["rate"] }),
      ),
    ),
  );
  return kit.h("section", { id: "voice" }, kit.h("h2", null, "Voice check (experimental)"), list);
}
