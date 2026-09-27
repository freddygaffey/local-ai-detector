// Decoder for the open-source `invisible-watermark` "dwtDct" method, as used
// by Stable Diffusion 1.x/2.x reference scripts, diffusers' SDXL pipeline and
// Black Forest Labs' FLUX reference code.
//
// This is our own TypeScript port (MIT, part of this project), written from
// the reference Python implementation:
//   ShieldMnt/invisible-watermark, imwatermark/maxDct.py (EmbedMaxDct) and
//   imwatermark/watermark.py (WatermarkDecoder), v0.2.0
//   https://github.com/ShieldMnt/invisible-watermark
//   Copyright (c) 2020 Qingquan Wang; MIT License.
//
// The reference algorithm, exactly as the Python code does it (note: despite
// the name, "dwtDct" performs NO DCT; it works on raw DWT coefficients):
//   1. yuv = cv2.cvtColor(bgr, COLOR_BGR2YUV)
//   2. scales = [0, 36, 36] and `for channel in range(2)` => only channel 1
//      (U) is used; channel 0 has scale 0 and channel 2 (V) is never reached.
//   3. ca = pywt.dwt2(U[:rows//4*4, :cols//4*4], 'haar') approximation band.
//   4. Walk ca in 4x4 blocks, row-major; block number `num` carries bit
//      `num % wmLen`.
//   5. Per block: pos = argmax(|block.flatten()[1:]|) + 1 (first max wins),
//      val = |block[pos]|, vote = 1 if (val % 36) > 18 else 0.
//   6. Bit = mean(votes for that bit) * 255 > 127.
// Encoding sets the chosen coefficient to (val//36 + 0.25 + 0.5*bit) * 36.
//
// Two real-world quirks we handle by trying decode "variants":
//   * diffusers' SDXL watermarker passes an RGB array where the library
//     expects BGR, so the channels are swapped ("rgb" orientation).
//   * diffusers/FLUX pass float32 arrays; OpenCV's float BGR->YUV uses a
//     chroma offset of 0.5 instead of 128 and no rounding ("float" mode),
//     which changes which coefficient is the block maximum.
//
// Detection. The Python decoder's majority bits are fragile on small images
// (our fixtures show the reference decoder itself getting 5-20% of bits
// wrong), so besides the faithful bit decode + Hamming distance we also use
// the per-block vote agreement with the known payload, compared against the
// agreement expected by chance, as a z-score. Either test passing counts as
// a hit. A miss means nothing: this watermark does not survive resizing,
// cropping or most re-encoding.

export interface RgbaImage {
  /** RGBA, row-major, 4 bytes per pixel (ImageData.data layout). */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export type Orientation = "bgr" | "rgb";
export type ChromaMode = "uint8" | "float";

export interface KnownPayload {
  id: "sd1" | "sd2" | "sdxl" | "flux";
  provider: string;
  bits: readonly number[];
  /** Max Hamming distance of the majority-decoded bits for a hit. */
  maxHamming: number;
  source: string;
}

function bytesToBits(ascii: string): number[] {
  const bits: number[] = [];
  for (let i = 0; i < ascii.length; i++) {
    const c = ascii.charCodeAt(i);
    for (let b = 7; b >= 0; b--) bits.push((c >> b) & 1); // np.unpackbits: MSB first
  }
  return bits;
}

function binStringToBits(s: string): number[] {
  return [...s].map((c) => (c === "1" ? 1 : 0));
}

export const KNOWN_PAYLOADS: readonly KnownPayload[] = [
  {
    id: "sd1",
    provider: "Stable Diffusion 1.x",
    bits: bytesToBits("StableDiffusionV1"), // 136 bits
    maxHamming: 12,
    source: "CompVis/stable-diffusion scripts/txt2img.py (bytes 'StableDiffusionV1')",
  },
  {
    id: "sd2",
    provider: "Stable Diffusion 2.x",
    bits: bytesToBits("SDV2"), // 32 bits
    maxHamming: 2,
    source: "Stability-AI/stablediffusion scripts (bytes 'SDV2')",
  },
  {
    id: "sdxl",
    provider: "Stable Diffusion XL (diffusers)",
    // diffusers/pipelines/stable_diffusion_xl/watermark.py WATERMARK_MESSAGE
    bits: binStringToBits("101100111110110010010000011110111011000110011110"), // 48 bits
    maxHamming: 4,
    source: "huggingface/diffusers stable_diffusion_xl/watermark.py",
  },
  {
    id: "flux",
    provider: "FLUX (Black Forest Labs reference code)",
    // 0b001010101111111010000111100111001111010100101110; Python's bin()[2:]
    // drops the two leading zeros, so the embedded payload is 46 bits.
    bits: binStringToBits("1010101111111010000111100111001111010100101110"),
    maxHamming: 4,
    source: "black-forest-labs/flux(2) src/*/watermark.py",
  },
];

const SCALE = 36;
const BLOCK = 4;

/**
 * U (chroma) plane exactly as cv2.cvtColor(img, COLOR_BGR2YUV)[:, :, 1] would
 * compute it for the array the encoder saw.
 *  - uint8: OpenCV's fixed-point path (verified bit-exact against OpenCV 5.0).
 *  - float: OpenCV's float path (U = 0.492 (B - Y) + 0.5, no rounding).
 */
export function computeU(img: RgbaImage, orientation: Orientation, mode: ChromaMode): Float64Array {
  const { data, width, height } = img;
  const n = width * height;
  const out = new Float64Array(n);
  // Channel the encoder treated as B / G / R, in our RGBA layout.
  const bOff = orientation === "bgr" ? 2 : 0;
  const rOff = orientation === "bgr" ? 0 : 2;
  if (mode === "uint8") {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const B = data[p + bOff]!;
      const G = data[p + 1]!;
      const R = data[p + rOff]!;
      const Y = (B * 1868 + G * 9617 + R * 4899 + 8192) >> 14;
      let U = ((B - Y) * 8061 + (128 << 14) + 8192) >> 14;
      if (U < 0) U = 0;
      else if (U > 255) U = 255;
      out[i] = U;
    }
  } else {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const B = data[p + bOff]!;
      const G = data[p + 1]!;
      const R = data[p + rOff]!;
      const Y = 0.299 * R + 0.587 * G + 0.114 * B;
      out[i] = 0.492 * (B - Y) + 0.5;
    }
  }
  return out;
}

/**
 * Per-block votes (0/1) in the reference decoder's block order, for one
 * plane of size width x height.
 */
export function blockVotes(plane: Float64Array, width: number, height: number): Uint8Array {
  const rows = Math.floor(height / 4) * 4;
  const cols = Math.floor(width / 4) * 4;
  const caRows = rows / 2;
  const caCols = cols / 2;
  const bRows = Math.floor(caRows / BLOCK);
  const bCols = Math.floor(caCols / BLOCK);
  const votes = new Uint8Array(bRows * bCols);
  const block = new Float64Array(16);
  let num = 0;
  for (let bi = 0; bi < bRows; bi++) {
    for (let bj = 0; bj < bCols; bj++) {
      // Haar approximation coefficients for this 4x4 block of `ca`.
      for (let u = 0; u < BLOCK; u++) {
        const y0 = (bi * BLOCK + u) * 2;
        const r0 = y0 * width;
        const r1 = (y0 + 1) * width;
        for (let v = 0; v < BLOCK; v++) {
          const x0 = (bj * BLOCK + v) * 2;
          // Haar approximation = (a + b + c + d) / 2, computed exactly.
          // (pywt's own float rounding at exact ties is platform dependent:
          // its arm64 wheels use FMA, so +-1 ulp differs between machines.)
          block[u * BLOCK + v] =
            (plane[r0 + x0]! + plane[r0 + x0 + 1]! + (plane[r1 + x0]! + plane[r1 + x0 + 1]!)) * 0.5;
        }
      }
      // argmax(|block.flatten()[1:]|) + 1, first occurrence on ties.
      let pos = 1;
      let best = Math.abs(block[1]!);
      for (let k = 2; k < 16; k++) {
        const a = Math.abs(block[k]!);
        if (a > best) {
          best = a;
          pos = k;
        }
      }
      const val = Math.abs(block[pos]!);
      votes[num++] = val % SCALE > 0.5 * SCALE ? 1 : 0;
    }
  }
  return votes;
}

/** Faithful WatermarkDecoder bit reconstruction: mean(votes) * 255 > 127. */
export function decodeBits(votes: Uint8Array, wmLen: number): number[] {
  const sums = new Float64Array(wmLen);
  const counts = new Float64Array(wmLen);
  for (let k = 0; k < votes.length; k++) {
    const b = k % wmLen;
    sums[b] = sums[b]! + votes[k]!;
    counts[b] = counts[b]! + 1;
  }
  const bits: number[] = [];
  for (let b = 0; b < wmLen; b++) {
    const c = counts[b]!;
    // np.mean([]) is NaN and NaN > 127 is False -> 0.
    bits.push(c > 0 && (sums[b]! / c) * 255 > 127 ? 1 : 0);
  }
  return bits;
}

export interface PayloadScore {
  payloadId: KnownPayload["id"];
  orientation: Orientation;
  mode: ChromaMode;
  hamming: number;
  wmLen: number;
  /** Fraction of blocks whose vote equals the payload bit they carry. */
  agreement: number;
  /** Agreement expected by chance given the vote/payload bit balance. */
  expected: number;
  z: number;
  blocks: number;
  hit: boolean;
}

/** Hit thresholds for the vote-agreement test (conservative; see header). */
export const AGREEMENT_MIN = 0.62;
export const Z_MIN = 8;

export function scorePayload(
  votes: Uint8Array,
  payload: KnownPayload,
  orientation: Orientation,
  mode: ChromaMode,
): PayloadScore {
  const L = payload.bits.length;
  const N = votes.length;
  const decoded = decodeBits(votes, L);
  let hamming = 0;
  for (let i = 0; i < L; i++) if (decoded[i] !== payload.bits[i]) hamming++;
  let agree = 0;
  let ones = 0;
  let payloadOnes = 0;
  for (let k = 0; k < N; k++) {
    const want = payload.bits[k % L]!;
    const v = votes[k]!;
    if (v === want) agree++;
    ones += v;
    payloadOnes += want;
  }
  const agreement = N ? agree / N : 0;
  const q = N ? ones / N : 0;
  const f = N ? payloadOnes / N : 0;
  const expected = q * f + (1 - q) * (1 - f);
  const sd = Math.sqrt(Math.max(expected * (1 - expected), 1e-9) / Math.max(N, 1));
  const z = (agreement - expected) / sd;
  const enoughBlocks = N >= L * 3;
  const hit =
    enoughBlocks && (hamming <= payload.maxHamming || (agreement >= AGREEMENT_MIN && z >= Z_MIN));
  return { payloadId: payload.id, orientation, mode, hamming, wmLen: L, agreement, expected, z, blocks: N, hit };
}

export interface WatermarkDetection {
  /** "skipped" when the image is too small (the encoder refuses < 256x256) or too large. */
  status: "found" | "not-found" | "skipped";
  reason?: string;
  best?: PayloadScore;
  payload?: KnownPayload;
}

/** Pixels above this are skipped (decode cost / memory). */
export const MAX_PIXELS = 24_000_000;

/**
 * Runs the decoder for every known payload, both channel orientations and
 * both chroma modes, and reports the strongest hit (if any).
 */
export function detectInvisibleWatermark(img: RgbaImage): WatermarkDetection {
  const { width, height } = img;
  if (width * height < 256 * 256) {
    return { status: "skipped", reason: "image smaller than 256x256 (never watermarked)" };
  }
  if (width * height > MAX_PIXELS) {
    return { status: "skipped", reason: "image too large to decode" };
  }
  let best: PayloadScore | undefined;
  let bestHit: PayloadScore | undefined;
  for (const orientation of ["bgr", "rgb"] as const) {
    for (const mode of ["uint8", "float"] as const) {
      const votes = blockVotes(computeU(img, orientation, mode), width, height);
      for (const payload of KNOWN_PAYLOADS) {
        const s = scorePayload(votes, payload, orientation, mode);
        if (!best || s.z > best.z) best = s;
        if (s.hit && (!bestHit || s.z > bestHit.z)) bestHit = s;
      }
    }
  }
  if (bestHit) {
    return {
      status: "found",
      best: bestHit,
      payload: KNOWN_PAYLOADS.find((p) => p.id === bestHit.payloadId),
    };
  }
  return { status: "not-found", best };
}
