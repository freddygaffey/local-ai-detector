// Test-only helper: minimal PNG pixel decoder (8-bit RGB/RGBA/grey,
// non-interlaced) so vitest can feed fixture pixels to the decoders without a
// canvas. The extension itself decodes with createImageBitmap/OffscreenCanvas.

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import type { RgbaImage } from "../dwtdct";

export function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./${name}`, import.meta.url)));
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  while (off < bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error("unsupported PNG (test helper)");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  const total = idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let p = 0;
  for (const c of idat) {
    joined.set(c, p);
    p += c.length;
  }
  const raw = inflateSync(joined);
  const stride = width * channels;
  const out = new Uint8Array(width * height * channels);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let v = line[x]!;
      switch (filter) {
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: break;
      }
      cur[x] = v & 0xff;
    }
    out.set(cur, y * stride);
    prev = cur;
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    if (channels >= 3) {
      rgba[i * 4] = out[s]!;
      rgba[i * 4 + 1] = out[s + 1]!;
      rgba[i * 4 + 2] = out[s + 2]!;
      rgba[i * 4 + 3] = channels === 4 ? out[s + 3]! : 255;
    } else {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = out[s]!;
      rgba[i * 4 + 3] = channels === 2 ? out[s + 1]! : 255;
    }
  }
  return { data: rgba, width, height };
}
