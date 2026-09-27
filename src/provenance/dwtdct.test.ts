import { describe, expect, it } from "vitest";
import { decodePng, readFixture } from "./__fixtures__/decode-png";
import expected from "./__fixtures__/expected.json";
import {
  KNOWN_PAYLOADS,
  blockVotes,
  computeU,
  decodeBits,
  detectInvisibleWatermark,
} from "./dwtdct";

type Exp = Record<
  string,
  { bits?: number[]; pythonDecoded?: number[]; pythonVotes?: string; pythonDecoded48?: number[]; payload?: string | null }
>;
const EXP = expected as unknown as Exp;

function hamming(a: number[], b: readonly number[]): number {
  return a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0);
}

describe("invisible-watermark dwtDct port", () => {
  it("payload constants match the reference encoder's bit strings", () => {
    for (const file of ["sd1_bytes.png", "sd2_bytes.png", "sdxl_diffusers.png", "flux_ref.png"]) {
      const e = EXP[file]!;
      const p = KNOWN_PAYLOADS.find((k) => k.id === e.payload)!;
      expect(p.bits).toEqual(e.bits);
    }
    expect(KNOWN_PAYLOADS.find((p) => p.id === "flux")!.bits.length).toBe(46);
  });

  it.each(["sd1_bytes.png", "sd2_bytes.png", "sdxl_diffusers.png", "flux_ref.png"])(
    "reproduces the Python reference decoder for %s (uint8 BGR path, as cv2.imread)",
    (file) => {
      const e = EXP[file]!;
      const img = decodePng(readFixture(file));
      const votes = blockVotes(computeU(img, "bgr", "uint8"), img.width, img.height);
      // Per-block votes must be identical, except on blocks that are exact
      // ties (two equal max coefficients, or val % 36 == 18 exactly), which
      // pywt's float rounding breaks in a platform-dependent way.
      const py = e.pythonVotes!;
      expect(votes.length).toBe(py.length);
      const U = computeU(img, "bgr", "uint8");
      const W = img.width;
      const bCols = Math.floor((Math.floor(W / 4) * 2) / 4);
      let nonTieMismatches = 0;
      for (let k = 0; k < votes.length; k++) {
        if (String(votes[k]) === py[k]) continue;
        const bi = Math.floor(k / bCols);
        const bj = k % bCols;
        const abs: number[] = [];
        for (let u = 0; u < 4; u++) {
          for (let v = 0; v < 4; v++) {
            if (u === 0 && v === 0) continue;
            const y0 = (bi * 4 + u) * 2;
            const x0 = (bj * 4 + v) * 2;
            abs.push(Math.abs((U[y0 * W + x0]! + U[y0 * W + x0 + 1]! + U[(y0 + 1) * W + x0]! + U[(y0 + 1) * W + x0 + 1]!) / 2));
          }
        }
        const m = Math.max(...abs);
        const tie = abs.filter((a) => a === m).length > 1 || m % 36 === 18;
        if (!tie) nonTieMismatches++;
      }
      expect(nonTieMismatches).toBe(0);
      // Majority bits: ties (even vote counts) can flip on those few blocks.
      const bits = decodeBits(votes, e.bits!.length);
      expect(hamming(bits, e.pythonDecoded!)).toBeLessThanOrEqual(Math.ceil(e.bits!.length * 0.05));
    },
  );

  it.each([
    ["sd1_bytes.png", "sd1"],
    ["sd2_bytes.png", "sd2"],
    ["sdxl_diffusers.png", "sdxl"],
    ["flux_ref.png", "flux"],
  ])("detects the watermark in %s as %s", (file, id) => {
    const img = decodePng(readFixture(file));
    const det = detectInvisibleWatermark(img);
    expect(det.status).toBe("found");
    expect(det.payload?.id).toBe(id);
  });

  it("uses the swapped-channel float variant for diffusers SDXL output", () => {
    const det = detectInvisibleWatermark(decodePng(readFixture("sdxl_diffusers.png")));
    expect(det.best?.orientation).toBe("rgb");
    expect(det.best?.mode).toBe("float");
  });

  it("does not report a watermark on the clean control image", () => {
    const det = detectInvisibleWatermark(decodePng(readFixture("clean.png")));
    expect(det.status).toBe("not-found");
    expect(det.best!.z).toBeLessThan(5);
  });

  it("does not report on random noise or flat images", () => {
    const w = 512;
    const h = 512;
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 0xff;
    const noise = new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : rnd()));
    expect(detectInvisibleWatermark({ data: noise, width: w, height: h }).status).toBe("not-found");
    const flat = new Uint8ClampedArray(w * h * 4).fill(200);
    expect(detectInvisibleWatermark({ data: flat, width: w, height: h }).status).toBe("not-found");
  });

  it("skips images below 256x256 like the reference encoder", () => {
    const img = { data: new Uint8ClampedArray(200 * 200 * 4), width: 200, height: 200 };
    expect(detectInvisibleWatermark(img).status).toBe("skipped");
  });

  it("is destroyed by a 3-pixel crop (fragile: a miss means nothing)", () => {
    const src = decodePng(readFixture("sd1_bytes.png"));
    const cut = 3;
    const w = src.width - cut;
    const h = src.height - cut;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const from = ((y + cut) * src.width + cut) * 4;
      out.set(src.data.subarray(from, from + w * 4), y * w * 4);
    }
    expect(detectInvisibleWatermark({ data: out, width: w, height: h }).status).toBe("not-found");
  });
});
