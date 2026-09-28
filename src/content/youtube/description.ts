// YouTube video descriptions, scored for AI writing like a short article.
// The full description comes from the player's own data in the page world
// (./pageCaptions.ts: the page shows it truncated until "more"). Links,
// chapter timestamps and hashtag lines are dropped first: they're boilerplate,
// not prose, and would only dilute the score.

import { fusionForTier } from "../../engine/models";
import { sendMessage } from "../../shared/messages";
import type { Settings } from "../../shared/settings";
import { displayScore } from "../../ui/probability";
import { segmentSentences } from "../segment";
import { DESCRIPTION_REQUEST, DESCRIPTION_RESPONSE, type DescriptionResponse } from "./pageCaptions";

/** Fewer words than this after cleaning: too short to judge. */
export const MIN_DESCRIPTION_WORDS = 40;

/** Prose only: no links, chapter lists, hashtag lines or @handles-only lines. Pure. */
export function cleanDescription(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/https?:\/\/|www\.|\.(com|net|org|io|ly|gg|tv)\b\/?/i.test(l))
    .filter((l) => !/^\(?\d{1,2}:\d{2}(:\d{2})?\)?\b/.test(l)) // "0:00 Intro" chapter lines
    .filter((l) => !/^([#@][\w-]+\s*)+$/.test(l)) // "#tag #tag", "@handle"
    .join("\n")
    .trim();
}

export const wordCount = (s: string): number => (s.match(/\S+/g) ?? []).length;

function requestDescription(videoId: string, timeoutMs = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const done = (v: string | null) => {
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve(v);
    };
    const onMsg = (e: MessageEvent) => {
      const d = e.data as Partial<DescriptionResponse> | null;
      if (e.source === window && d?.source === DESCRIPTION_RESPONSE && d.id === id) done(typeof d.description === "string" ? d.description : null);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    window.addEventListener("message", onMsg);
    window.postMessage({ source: DESCRIPTION_REQUEST, id, videoId }, location.origin);
  });
}

/**
 * P(AI) of this video's description (Quick detector set), null when it's too
 * short to judge, undefined when there's no description to read.
 */
export async function scoreDescription(videoId: string, settings: Settings): Promise<number | null | undefined> {
  const raw = await requestDescription(videoId);
  if (raw === null) return undefined;
  const text = cleanDescription(raw);
  if (wordCount(text) < MIN_DESCRIPTION_WORDS) return null;
  const quick = fusionForTier("quick", settings.tiers);
  const result = await sendMessage("analyze", {
    tabId: -1,
    mode: "ensemble",
    fusionOverride: quick.detectors,
    tier: "quick",
    blocks: [{ id: `yt-desc-${videoId}`, text, sentences: segmentSentences(text) }],
  });
  return displayScore(result);
}
