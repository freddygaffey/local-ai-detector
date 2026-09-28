import { describe, expect, test } from "vitest";
import { parseMediaHeader, readUmpVarint, UmpAudioDemuxer, type AudioSegment } from "./ump";

function umpVarint(v: number): number[] {
  if (v < 0x80) return [v];
  if (v < 0x4000) return [0x80 | (v % 64), Math.floor(v / 64)];
  if (v < 0x200000) return [0xc0 | (v % 32), Math.floor(v / 32) % 256, Math.floor(v / 32 / 256)];
  return [0xf0, v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
}
function pbVarint(v: number): number[] {
  const out: number[] = [];
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}
const pbField = (field: number, v: number) => [...pbVarint(field * 8), ...pbVarint(v)];
const part = (type: number, data: number[]) => [...umpVarint(type), ...umpVarint(data.length), ...data];
const header = (id: number, itag: number, init = false, startMs = 0) =>
  part(20, [...pbField(1, id), ...pbField(3, itag), ...pbField(8, init ? 1 : 0), ...pbField(11, startMs), ...pbField(12, 5000)]);

describe("UMP", () => {
  test("varints of every length round-trip", () => {
    for (const v of [0, 1, 127, 128, 200, 5000, 16383, 70000, 2_000_000, 300_000_000]) {
      const b = new Uint8Array(umpVarint(v));
      expect(readUmpVarint(b, 0)).toEqual([v, b.length]);
    }
    expect(readUmpVarint(new Uint8Array([0x80]), 0)).toBeNull(); // incomplete
  });

  test("media header fields", () => {
    const h = parseMediaHeader(new Uint8Array([...pbField(1, 3), ...pbField(3, 251), ...pbField(8, 1), ...pbField(9, 7), ...pbField(11, 12000), ...pbField(12, 5000)]));
    expect(h).toEqual({ headerId: 3, itag: 251, isInit: true, sequence: 7, startMs: 12000, durationMs: 5000 });
  });

  test("demuxer keeps audio segments, drops video, survives arbitrary chunking", () => {
    const audio = Array.from({ length: 300 }, (_, i) => i % 256);
    const video = Array.from({ length: 500 }, () => 9);
    const stream = new Uint8Array([
      ...header(1, 251, true),
      ...part(21, [1, ...audio.slice(0, 10)]),
      ...part(22, [1]),
      ...header(2, 248), // video itag
      ...part(21, [2, ...video]),
      ...header(3, 251, false, 5000),
      ...part(21, [3, ...audio.slice(0, 150)]),
      ...part(22, [2]),
      ...part(21, [3, ...audio.slice(150)]),
      ...part(22, [3]),
    ]);
    for (const size of [1, 7, 64, stream.length]) {
      const got: AudioSegment[] = [];
      const d = new UmpAudioDemuxer((s) => got.push(s));
      for (let i = 0; i < stream.length; i += size) d.push(stream.subarray(i, i + size));
      expect(got.map((s) => [s.itag, s.isInit, s.startMs, s.bytes.length])).toEqual([
        [251, true, 0, 10],
        [251, false, 5000, 300],
      ]);
      expect([...got[1]!.bytes]).toEqual(audio);
    }
  });
});
