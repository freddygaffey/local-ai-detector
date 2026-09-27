// NovelAI "stealth pnginfo" decoder: generation metadata hidden in the least
// significant bits of the alpha channel (or of R,G,B), which survives
// metadata stripping but not lossy re-encoding or resizing.
//
// Our own TypeScript port (MIT), written from the reference implementation
// NovelAI/novelai-image-metadata (nai_meta.py, LSBExtractor; MIT License)
// https://github.com/NovelAI/novelai-image-metadata
// and the compatible A1111 "stealth-pnginfo" extension formats:
//   magic "stealth_pnginfo"  alpha LSB, plain UTF-8 JSON/text
//   magic "stealth_pngcomp"  alpha LSB, gzip-compressed JSON/text
//   magic "stealth_rgbinfo"  R,G,B LSBs, plain
//   magic "stealth_rgbcomp"  R,G,B LSBs, gzip
// Bits are read column by column (the row index advances fastest), MSB
// first; after the 15-byte magic comes a 32-bit big-endian payload length
// in *bits*, then the payload.

import type { RgbaImage } from "./dwtdct";

export type StealthMode = "stealth_pnginfo" | "stealth_pngcomp" | "stealth_rgbinfo" | "stealth_rgbcomp";

export interface StealthResult {
  mode: StealthMode;
  /** Parsed JSON if the payload is JSON (NovelAI), else undefined. */
  metadata?: Record<string, unknown>;
  /** Raw decoded text (A1111 copies store the "parameters" text). */
  text: string;
}

const MAGIC_LEN = 15;
/** Refuse absurd payload lengths (bytes). */
const MAX_PAYLOAD = 4 * 1024 * 1024;

class LsbReader {
  private x = 0;
  private y = 0;
  private c = 0;
  constructor(
    private readonly img: RgbaImage,
    private readonly channels: readonly number[],
  ) {}

  private nextBit(): number | undefined {
    const { width, height, data } = this.img;
    if (this.x >= width) return undefined;
    const bit = data[(this.y * width + this.x) * 4 + this.channels[this.c]!]! & 1;
    this.c++;
    if (this.c === this.channels.length) {
      this.c = 0;
      this.y++;
      if (this.y === height) {
        this.y = 0;
        this.x++;
      }
    }
    return bit;
  }

  readBytes(n: number): Uint8Array | undefined {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let byte = 0;
      for (let b = 0; b < 8; b++) {
        const bit = this.nextBit();
        if (bit === undefined) return undefined;
        byte = (byte << 1) | bit;
      }
      out[i] = byte;
    }
    return out;
  }
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function capacityBits(img: RgbaImage, perPixel: number): number {
  return img.width * img.height * perPixel;
}

/** Returns the decoded stealth metadata, or null if none is present. */
export async function decodeStealthMetadata(img: RgbaImage): Promise<StealthResult | null> {
  const tries: Array<{ channels: number[]; modes: StealthMode[] }> = [
    { channels: [3], modes: ["stealth_pnginfo", "stealth_pngcomp"] },
    { channels: [0, 1, 2], modes: ["stealth_rgbinfo", "stealth_rgbcomp"] },
  ];
  const latin1 = new TextDecoder("latin1");
  for (const t of tries) {
    if (capacityBits(img, t.channels.length) < (MAGIC_LEN + 4) * 8) continue;
    const reader = new LsbReader(img, t.channels);
    const magicBytes = reader.readBytes(MAGIC_LEN);
    if (!magicBytes) continue;
    const magic = latin1.decode(magicBytes) as StealthMode;
    if (!t.modes.includes(magic)) continue;
    const lenBytes = reader.readBytes(4);
    if (!lenBytes) return null;
    const bitLen = ((lenBytes[0]! << 24) | (lenBytes[1]! << 16) | (lenBytes[2]! << 8) | lenBytes[3]!) >>> 0;
    const byteLen = Math.floor(bitLen / 8);
    if (byteLen <= 0 || byteLen > MAX_PAYLOAD) return null;
    if (capacityBits(img, t.channels.length) < (MAGIC_LEN + 4 + byteLen) * 8) return null;
    const payload = reader.readBytes(byteLen);
    if (!payload) return null;
    let raw = payload;
    if (magic.endsWith("comp")) {
      try {
        raw = await gunzip(payload);
      } catch {
        return null;
      }
    }
    const text = new TextDecoder("utf-8").decode(raw);
    let metadata: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
        if (typeof metadata.Comment === "string") {
          try {
            metadata.Comment = JSON.parse(metadata.Comment);
          } catch {
            // leave as string
          }
        }
      }
    } catch {
      // not JSON (A1111 copies store plain "parameters" text)
    }
    return { mode: magic, metadata, text };
  }
  return null;
}
