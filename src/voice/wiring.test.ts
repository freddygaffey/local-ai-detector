import { describe, expect, test } from "vitest";
import { resolveVoiceRate } from "./rate";
import { toggleVoiceModel, voiceChecklistRows } from "./checklist";
import { DEFAULT_VOICE, sanitizeVoice } from "./settings";
import { voiceLabel, formatClock } from "./ui";
import { youTubeVideoId } from "./content";
import { encodePcm, decodePcm } from "./protocol";
import { aggregate } from "./aggregate";
import type { VoiceState } from "./capture";

describe("voice settings", () => {
  test("defaults and sanitising", () => {
    expect(DEFAULT_VOICE).toMatchObject({ enabled: true, model: "voiceSpectraAasist3", run: "autoYouTube", sensitivity: "strict", rate: "normal" });
    expect(sanitizeVoice({ rate: "bogus" as never, enabled: false })).toMatchObject({ rate: "normal", enabled: false });
  });
  test("rate: explicit preset wins, else tier, else normal", () => {
    expect(resolveVoiceRate({})).toBe("normal");
    expect(resolveVoiceRate({ tier: "quick" })).toBe("light");
    expect(resolveVoiceRate({ tier: "Deep" })).toBe("thorough");
    expect(resolveVoiceRate({ tier: "deep", voice: { rate: "light" } })).toBe("light");
  });
});

describe("checklist rows", () => {
  test("Spectra ticked, W2V2 unticked by default; sizes shown", () => {
    const rows = voiceChecklistRows(undefined, () => {});
    expect(rows.map((r) => [r.key, r.checked, r.sizeBytes])).toEqual([
      ["voiceSpectraAasist3", true, 364_036_647],
      ["voiceW2V2Aasist", false, 357_368_277],
    ]);
  });
  test("rows act like radio buttons", () => {
    const on = toggleVoiceModel(DEFAULT_VOICE, "voiceW2V2Aasist", true);
    expect(on).toMatchObject({ enabled: true, model: "voiceW2V2Aasist" });
    expect(toggleVoiceModel(on, "voiceSpectraAasist3", false)).toEqual(on);
    expect(toggleVoiceModel(on, "voiceW2V2Aasist", false).enabled).toBe(false);
  });
});

describe("chip label", () => {
  const st = (over: Partial<VoiceState>): VoiceState => ({ status: "listening", clips: [], agg: { p: null, clips: 0 }, durationS: 60, ...over });
  test("states", () => {
    expect(voiceLabel(null).text).toBe("Voice");
    expect(voiceLabel(st({ status: "unavailable" })).text).toBe("Voice: —");
    expect(voiceLabel(st({ status: "downloading", download: 0.42 })).text).toBe("Voice: model 42%");
    const clips = Array.from({ length: 14 }, (_, i) => ({ atS: i * 10, p: 0.72 }));
    expect(voiceLabel(st({ clips, agg: aggregate(clips) }))).toMatchObject({ text: "Voice: AI 72% · 14 clips", muted: false });
    expect(formatClock(3725)).toBe("1:02:05");
  });
});

describe("misc", () => {
  test("YouTube ids", () => {
    expect(youTubeVideoId("https://www.youtube.com/watch?v=abc123XYZ")).toBe("abc123XYZ");
    expect(youTubeVideoId("https://m.youtube.com/shorts/abcdefg")).toBe("abcdefg");
    expect(youTubeVideoId("https://music.youtube.com/watch?v=abc123")).toBeNull();
    expect(youTubeVideoId("https://example.com/watch?v=x")).toBeNull();
  });
  test("pcm round trip", () => {
    const x = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const y = decodePcm(encodePcm(x));
    x.forEach((v, i) => expect(y[i]).toBeCloseTo(v, 3));
  });
});
