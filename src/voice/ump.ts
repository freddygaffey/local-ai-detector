// YouTube's streaming container ("UMP", application/vnd.yt-ump): the web
// player now fetches audio and video interleaved in one response, as a
// sequence of parts [type varint][size varint][payload]. The voice check only
// needs the audio: MEDIA_HEADER parts say which itag (format) a header id
// carries, MEDIA parts carry that header's bytes, MEDIA_END closes it.
// Pure; used by the page-world audio tap (src/content/youtube/audioTap.ts).

export const PART_MEDIA_HEADER = 20;
export const PART_MEDIA = 21;
export const PART_MEDIA_END = 22;

/** Audio-only YouTube itags (Opus in WebM, AAC in MP4). */
export const AUDIO_ITAGS = new Set([139, 140, 141, 171, 172, 249, 250, 251, 256, 258, 325, 327, 328, 338, 380, 599, 600]);

/** UMP's own varint (not protobuf's): the first byte's leading 1-bits give the length. Returns [value, bytesRead] or null if incomplete. */
export function readUmpVarint(b: Uint8Array, at: number): [number, number] | null {
  if (at >= b.length) return null;
  const b0 = b[at]!;
  const len = b0 < 0x80 ? 1 : b0 < 0xc0 ? 2 : b0 < 0xe0 ? 3 : b0 < 0xf0 ? 4 : 5;
  if (at + len > b.length) return null;
  switch (len) {
    case 1:
      return [b0, 1];
    case 2:
      return [(b0 & 0x3f) + 64 * b[at + 1]!, 2];
    case 3:
      return [(b0 & 0x1f) + 32 * (b[at + 1]! + 256 * b[at + 2]!), 3];
    case 4:
      return [(b0 & 0x0f) + 16 * (b[at + 1]! + 256 * (b[at + 2]! + 256 * b[at + 3]!)), 4];
    default:
      return [(b[at + 1]! | (b[at + 2]! << 8) | (b[at + 3]! << 16)) + b[at + 4]! * 2 ** 24, 5];
  }
}

export interface UmpPart {
  type: number;
  data: Uint8Array;
}

/** Splits complete parts off the front of `b`; returns them and how many bytes they used. */
export function readUmpParts(b: Uint8Array): { parts: UmpPart[]; used: number } {
  const parts: UmpPart[] = [];
  let at = 0;
  for (;;) {
    const t = readUmpVarint(b, at);
    if (!t) break;
    const s = readUmpVarint(b, at + t[1]);
    if (!s) break;
    const start = at + t[1] + s[1];
    if (start + s[0] > b.length) break;
    parts.push({ type: t[0], data: b.subarray(start, start + s[0]) });
    at = start + s[0];
  }
  return { parts, used: at };
}

/** Minimal protobuf reader: field number -> first varint value / bytes. */
function protoFields(b: Uint8Array): Map<number, number | Uint8Array> {
  const out = new Map<number, number | Uint8Array>();
  let at = 0;
  const varint = (): number => {
    let v = 0;
    let mul = 1;
    for (let i = 0; i < 10 && at < b.length; i++) {
      const x = b[at++]!;
      v += (x & 0x7f) * mul;
      if (!(x & 0x80)) break;
      mul *= 128;
    }
    return v;
  };
  while (at < b.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) {
      const v = varint();
      if (!out.has(field)) out.set(field, v);
    } else if (wire === 2) {
      const n = varint();
      if (!out.has(field)) out.set(field, b.subarray(at, at + n));
      at += n;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else break;
  }
  return out;
}

export interface MediaHeader {
  headerId: number;
  itag?: number;
  isInit: boolean;
  sequence?: number;
  startMs?: number;
  durationMs?: number;
}

/** MEDIA_HEADER payload (protobuf): 1 header id, 3 itag, 8 is-init, 9 sequence, 11 start ms, 12 duration ms, 13 format id {1 itag}. */
export function parseMediaHeader(data: Uint8Array): MediaHeader {
  const f = protoFields(data);
  const num = (k: number) => (typeof f.get(k) === "number" ? (f.get(k) as number) : undefined);
  let itag = num(3);
  const fmt = f.get(13);
  if (itag === undefined && fmt instanceof Uint8Array) {
    const g = protoFields(fmt).get(1);
    if (typeof g === "number") itag = g;
  }
  return { headerId: num(1) ?? 0, itag, isInit: num(8) === 1, sequence: num(9), startMs: num(11), durationMs: num(12) };
}

/** A finished audio segment from the stream. */
export interface AudioSegment {
  itag: number;
  isInit: boolean;
  sequence?: number;
  startMs?: number;
  durationMs?: number;
  bytes: Uint8Array;
}

/**
 * Incremental UMP demuxer that keeps only audio: push() response chunks as
 * they arrive; completed audio segments come out of `onSegment`.
 */
export class UmpAudioDemuxer {
  private buf = new Uint8Array(0);
  private headers = new Map<number, MediaHeader>();
  private chunks = new Map<number, Uint8Array[]>();

  constructor(private onSegment: (s: AudioSegment) => void) {}

  push(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const { parts, used } = readUmpParts(merged);
    this.buf = merged.slice(used);
    for (const p of parts) this.part(p);
  }

  private part(p: UmpPart): void {
    if (p.type === PART_MEDIA_HEADER) {
      const h = parseMediaHeader(p.data);
      if (h.itag !== undefined && AUDIO_ITAGS.has(h.itag)) {
        this.headers.set(h.headerId, h);
        this.chunks.set(h.headerId, []);
      }
    } else if (p.type === PART_MEDIA) {
      const id = p.data[0]!;
      this.chunks.get(id)?.push(p.data.slice(1));
    } else if (p.type === PART_MEDIA_END) {
      const id = p.data[0]!;
      const h = this.headers.get(id);
      const parts = this.chunks.get(id);
      this.headers.delete(id);
      this.chunks.delete(id);
      if (!h || !parts?.length || h.itag === undefined) return;
      const n = parts.reduce((a, c) => a + c.length, 0);
      const bytes = new Uint8Array(n);
      let o = 0;
      for (const c of parts) {
        bytes.set(c, o);
        o += c.length;
      }
      this.onSegment({ itag: h.itag, isInit: h.isInit, sequence: h.sequence, startMs: h.startMs, durationMs: h.durationMs, bytes });
    }
  }
}
