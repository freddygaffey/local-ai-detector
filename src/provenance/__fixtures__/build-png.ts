// Test-only helper: builds tiny PNG files with arbitrary chunks.

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  out.set(typeBytes, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const latin1 = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));
const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export const tEXt = (k: string, v: string) => chunk("tEXt", concat(latin1(k), new Uint8Array([0]), latin1(v)));
export const zTXt = (k: string, v: string) =>
  chunk("zTXt", concat(latin1(k), new Uint8Array([0, 0]), new Uint8Array(deflateSync(latin1(v)))));
export const iTXt = (k: string, v: string, compressed = false) =>
  chunk(
    "iTXt",
    concat(
      latin1(k),
      new Uint8Array([0, compressed ? 1 : 0, 0]),
      new Uint8Array([0]), // empty language tag
      new Uint8Array([0]), // empty translated keyword
      compressed ? new Uint8Array(deflateSync(utf8(v))) : utf8(v),
    ),
  );

/** 1x1 RGBA PNG with the given extra chunks before IDAT. */
export function buildPng(extra: Uint8Array[]): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, 1);
  dv.setUint32(4, 1);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array([0, 255, 0, 0, 255]))));
  return concat(sig, chunk("IHDR", ihdr), ...extra, idat, chunk("IEND", new Uint8Array()));
}

/** Minimal JPEG (SOI + APP1 XMP + EOI); enough for metadata scanners. */
export function jpegWithXmp(xmp: string): Uint8Array {
  const ns = utf8("http://ns.adobe.com/xap/1.0/\0");
  const body = concat(ns, utf8(xmp));
  const seg = new Uint8Array(4 + body.length);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  new DataView(seg.buffer).setUint16(2, body.length + 2);
  seg.set(body, 4);
  return concat(new Uint8Array([0xff, 0xd8]), seg, new Uint8Array([0xff, 0xd9]));
}
