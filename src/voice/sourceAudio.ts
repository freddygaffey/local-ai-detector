// The voice check's original-audio source on YouTube: segments the player
// downloaded, passed over by the page-world tap (src/content/youtube/audioTap.ts),
// decoded here at their own speed -- so a video watched at 3x is scored on
// its 1x audio. Keeps the format's init segment plus a short window of recent
// media segments (memory stays small); a clip is decoded on request.

import { AUDIO_TAP_SOURCE, type AudioTapMessage } from "../content/youtube/audioTap";
import { CLIP_SAMPLES, SAMPLE_RATE } from "./schedule";

interface Seg {
  startMs?: number;
  durationMs?: number;
  bytes: Uint8Array;
  at: number;
}

const MAX_SEGMENTS = 24;

let itag: number | null = null;
let init: Uint8Array | null = null;
let segs: Seg[] = [];
let listening = false;

function onMessage(e: MessageEvent): void {
  const m = e.data as Partial<AudioTapMessage> | null;
  if (e.source !== window || m?.source !== AUDIO_TAP_SOURCE || !(m.bytes instanceof ArrayBuffer) || typeof m.itag !== "number") return;
  // A new format (quality switch, next video): start over for it.
  if (m.itag !== itag && m.isInit) {
    itag = m.itag;
    segs = [];
  }
  if (m.itag !== itag) return;
  const bytes = new Uint8Array(m.bytes);
  if (m.isInit) {
    // A different init segment (next video, new format): older segments don't belong to it.
    if (!init || init.length !== bytes.length || init.some((b, k) => b !== bytes[k])) segs = [];
    init = bytes;
  } else {
    segs.push({ startMs: m.startMs, durationMs: m.durationMs, bytes, at: Date.now() });
    if (segs.length > MAX_SEGMENTS) segs.shift();
  }
}

/** Starts listening for tapped audio (YouTube pages only). */
export function startSourceAudio(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", onMessage);
}

/** Forget everything (the video changed). */
export function resetSourceAudio(): void {
  itag = null;
  init = null;
  segs = [];
}

/** True once an init segment and at least one media segment are held. */
export function sourceAudioReady(): boolean {
  return !!init && segs.length > 0;
}

async function decode(bytes: Uint8Array): Promise<Float32Array | null> {
  try {
    const ctx = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);
    const buf = await ctx.decodeAudioData(bytes.slice().buffer);
    if (buf.numberOfChannels === 1) return buf.getChannelData(0);
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i]! += ch[i]! / buf.numberOfChannels;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * One model clip (CLIP_SAMPLES at 16 kHz) of original-speed audio near
 * playback position `atS`, or null if the tap has nothing usable (yet).
 */
export async function sourceClip(atS: number): Promise<Float32Array | null> {
  if (!init || !segs.length) return null;
  const atMs = atS * 1000;
  // The segment playing now if timestamps are known, else the newest.
  let i = segs.findIndex((s) => s.startMs !== undefined && s.durationMs !== undefined && atMs >= s.startMs && atMs < s.startMs + s.durationMs);
  if (i < 0) i = segs.length - 1;
  // Enough segments from there for one clip (segments are usually 5-10 s).
  const pick: Seg[] = [];
  let ms = 0;
  for (let j = i; j < segs.length && ms < 5000; j++) {
    pick.push(segs[j]!);
    ms += segs[j]!.durationMs ?? 5000;
  }
  for (let j = i - 1; j >= 0 && ms < 5000; j--) {
    pick.unshift(segs[j]!);
    ms += segs[j]!.durationMs ?? 5000;
  }
  const total = init.length + pick.reduce((a, s) => a + s.bytes.length, 0);
  const file = new Uint8Array(total);
  file.set(init);
  let o = init.length;
  for (const s of pick) {
    file.set(s.bytes, o);
    o += s.bytes.length;
  }
  const pcm = await decode(file);
  if (!pcm || pcm.length < CLIP_SAMPLES) return null;
  // Start at the playback position within the first picked segment when known.
  const first = pick[0]!;
  const offset = first.startMs !== undefined ? Math.round(((atMs - first.startMs) / 1000) * SAMPLE_RATE) : 0;
  const start = Math.min(Math.max(0, offset), pcm.length - CLIP_SAMPLES);
  return pcm.slice(start, start + CLIP_SAMPLES);
}
