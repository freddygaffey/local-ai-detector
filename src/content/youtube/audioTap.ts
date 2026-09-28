// Page-world audio tap for the voice check (runs in YouTube's own JS world,
// see entrypoints/youtube-main.content.ts). The player downloads the audio
// itself; this keeps a read-only copy of the audio segments it fetches and
// hands them to the extension's content script, which decodes them at their
// original speed. So the voice check hears the original audio whatever the
// playback speed, and never records what is playing.
//
// Read-only: the player gets its own response untouched (we read a clone),
// nothing is fetched, nothing is sent anywhere but this page's own window.

import { AUDIO_ITAGS, UmpAudioDemuxer, type AudioSegment } from "../../voice/ump";

export const AUDIO_TAP_SOURCE = "lad-audio-tap";

export interface AudioTapMessage {
  source: typeof AUDIO_TAP_SOURCE;
  itag: number;
  isInit: boolean;
  startMs?: number;
  durationMs?: number;
  bytes: ArrayBuffer;
}

function post(s: AudioSegment): void {
  const bytes = s.bytes.slice().buffer;
  const msg: AudioTapMessage = { source: AUDIO_TAP_SOURCE, itag: s.itag, isInit: s.isInit, startMs: s.startMs, durationMs: s.durationMs, bytes };
  window.postMessage(msg, location.origin, [bytes]);
}

const isMediaUrl = (u: string) => /googlevideo\.com\/videoplayback/.test(u);

/** Old-style audio-only GET (mime=audio/..., one segment per response). */
function rawSegment(url: URL, bytes: Uint8Array): AudioSegment | null {
  const itag = Number(url.searchParams.get("itag"));
  if (!AUDIO_ITAGS.has(itag)) return null;
  const ebml = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  const ftyp = bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
  return { itag, isInit: ebml || ftyp, bytes };
}

async function readClone(res: Response, url: URL): Promise<void> {
  const type = res.headers.get("content-type") ?? "";
  const reader = res.body?.getReader();
  if (!reader) return;
  if (type.includes("vnd.yt-ump")) {
    const demux = new UmpAudioDemuxer(post);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      demux.push(value);
    }
  }
  if (!type.startsWith("audio/") && !/mime=audio/.test(url.search)) return void reader.cancel();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
  }
  const bytes = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  const seg = rawSegment(url, bytes);
  if (seg) post(seg);
}

export function startAudioTap(): void {
  const orig = window.fetch;
  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const p = orig.call(this, input, init);
    try {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (isMediaUrl(u)) {
        void p
          .then((res) => {
            if (res.ok) void readClone(res.clone(), new URL(u)).catch(() => {});
          })
          .catch(() => {});
      }
    } catch {
      // never break the player
    }
    return p;
  } as typeof window.fetch;
}
