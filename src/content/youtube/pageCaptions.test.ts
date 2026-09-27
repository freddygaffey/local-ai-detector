import { describe, expect, test } from "vitest";
import { isPlayerCaptionUrl, pickTrack, trackUrl } from "./pageCaptions";

const PLAYER =
  "https://www.youtube.com/api/timedtext?v=abc&ei=x&caps=asr&sparams=ip,ipbits,expire,v&signature=S.1&key=yt8&lang=af&potc=1&pot=TOKEN&fmt=json3&c=WEB";

describe("pageCaptions", () => {
  test("pickTrack prefers uploaded English, then auto English, then uploaded, then first", () => {
    expect(pickTrack([{ languageCode: "en", kind: "asr" }, { languageCode: "en" }])).toEqual({ languageCode: "en" });
    expect(pickTrack([{ languageCode: "fr" }, { languageCode: "en", kind: "asr" }])).toEqual({ languageCode: "en", kind: "asr" });
    expect(pickTrack([{ languageCode: "de", kind: "asr" }, { languageCode: "fr" }])).toEqual({ languageCode: "fr" });
    expect(pickTrack([])).toBeNull();
  });

  test("trackUrl edits in place and never re-encodes signed params", () => {
    const u = trackUrl(PLAYER, { languageCode: "en" });
    expect(u).toContain("sparams=ip,ipbits,expire,v");
    expect(u).toContain("lang=en&");
    expect(u).not.toContain("kind=");
    expect(u).toContain("fmt=json3");
    const a = trackUrl(PLAYER.replace("fmt=json3", "fmt=srv3"), { languageCode: "en", kind: "asr" });
    expect(a).toContain("fmt=json3");
    expect(a.endsWith("&kind=asr")).toBe(true);
    expect(trackUrl(PLAYER + "&kind=asr&tlang=de", { languageCode: "en" })).not.toMatch(/kind=|tlang=/);
  });

  test("isPlayerCaptionUrl needs this video and a pot token", () => {
    expect(isPlayerCaptionUrl(PLAYER, "abc")).toBe(true);
    expect(isPlayerCaptionUrl(PLAYER, "other")).toBe(false);
    expect(isPlayerCaptionUrl(PLAYER.replace("&pot=TOKEN", ""), "abc")).toBe(false);
  });
});
