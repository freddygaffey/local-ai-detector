// Minimal PNG chunk walker (our own code, MIT). Collects the text chunks that
// AI generators use (tEXt / zTXt / iTXt), and notes C2PA (`caBX`) and EXIF
// (`eXIf`) chunks. It never touches pixel data.

export interface PngTextChunk {
  type: "tEXt" | "zTXt" | "iTXt";
  keyword: string;
  text: string;
}

export interface PngInfo {
  width: number;
  height: number;
  colorType: number;
  /** Colour type with alpha, or a tRNS chunk. */
  hasAlpha: boolean;
  texts: PngTextChunk[];
  /** A `caBX` chunk (C2PA manifest store) is present. */
  hasC2pa: boolean;
  hasExif: boolean;
  /** Chunk parsing stopped early (truncated or malformed). */
  truncated: boolean;
}

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Cap on decompressed text per chunk (zip-bomb guard). */
const MAX_TEXT = 2 * 1024 * 1024;

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIG.every((b, i) => bytes[i] === b);
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  // PNG uses zlib-wrapped deflate ("deflate" in the Compression Streams API).
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_TEXT) {
      await reader.cancel();
      throw new Error("PNG text chunk too large");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");

function nul(bytes: Uint8Array, from: number): number {
  const i = bytes.indexOf(0, from);
  return i < 0 ? bytes.length : i;
}

export async function parsePng(bytes: Uint8Array): Promise<PngInfo | null> {
  if (!isPng(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info: PngInfo = {
    width: 0,
    height: 0,
    colorType: 0,
    hasAlpha: false,
    texts: [],
    hasC2pa: false,
    hasExif: false,
    truncated: false,
  };
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off);
    const type = latin1.decode(bytes.subarray(off + 4, off + 8));
    const start = off + 8;
    const end = start + len;
    if (end + 4 > bytes.length) {
      info.truncated = true;
      break;
    }
    const data = bytes.subarray(start, end);
    try {
      switch (type) {
        case "IHDR":
          info.width = view.getUint32(start);
          info.height = view.getUint32(start + 4);
          info.colorType = data[9] ?? 0;
          info.hasAlpha = info.colorType === 4 || info.colorType === 6;
          break;
        case "tRNS":
          info.hasAlpha = true;
          break;
        case "caBX":
          info.hasC2pa = true;
          break;
        case "eXIf":
          info.hasExif = true;
          break;
        case "tEXt": {
          const k = nul(data, 0);
          info.texts.push({ type, keyword: latin1.decode(data.subarray(0, k)), text: latin1.decode(data.subarray(k + 1)) });
          break;
        }
        case "zTXt": {
          const k = nul(data, 0);
          // data[k + 1] = compression method (0 = zlib)
          const text = latin1.decode(await inflate(data.subarray(k + 2)));
          info.texts.push({ type, keyword: latin1.decode(data.subarray(0, k)), text });
          break;
        }
        case "iTXt": {
          const k = nul(data, 0);
          const compressed = data[k + 1] === 1;
          const langEnd = nul(data, k + 3);
          const transEnd = nul(data, langEnd + 1);
          const body = data.subarray(transEnd + 1);
          const text = utf8.decode(compressed ? await inflate(body) : body);
          info.texts.push({ type, keyword: latin1.decode(data.subarray(0, k)), text });
          break;
        }
        case "IEND":
          return info;
        default:
          break;
      }
    } catch {
      // Skip a malformed/oversized chunk but keep walking.
    }
    off = end + 4; // skip CRC
  }
  return info;
}
