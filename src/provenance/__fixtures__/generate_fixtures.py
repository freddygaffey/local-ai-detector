#!/usr/bin/env python3
"""Generates the test fixtures in this directory with the *reference* Python
`invisible-watermark` package (imwatermark, MIT, ShieldMnt/invisible-watermark),
so the TypeScript port in ../dwtdct.ts is tested against the real encoder.

Not run by the build or tests; the generated files are committed. To
regenerate (needs no torch/onnx, the dwtDct path is pure numpy/OpenCV):

    python3 -m venv venv
    ./venv/bin/pip install --no-deps invisible-watermark==0.2.0
    ./venv/bin/pip install opencv-python-headless PyWavelets numpy Pillow
    # imwatermark/__init__ imports rivaGan (torch); stub it if torch is absent:
    ./venv/bin/python generate_fixtures.py

Each fixture mimics how a real pipeline calls the encoder:
  * sd1_bytes.png     SD 1.x txt2img.py: uint8 RGB->BGR, bytes b"StableDiffusionV1"
  * sd2_bytes.png     SD 2.x scripts: uint8 BGR, bytes b"SDV2"
  * sdxl_diffusers.png diffusers SDXL: float32 *RGB* array passed as if BGR,
                       48-bit SDXL payload, then clamp + round to uint8
  * flux_ref.png      BFL FLUX reference: float32 RGB->BGR, 46-bit payload
                       (bin() drops two leading zeros), clamp + truncate
  * clean.png         same base image, no watermark (negative control)
  * novelai_stealth.png  RGBA with NovelAI "stealth_pngcomp" alpha-LSB metadata
  * expected.json     payloads + the reference Python decoder's own output
"""

import gzip
import json
import os
import sys
import types

import numpy as np

# Avoid importing torch/onnxruntime via imwatermark.rivaGan (unused here).
try:
    import torch  # noqa: F401
except ImportError:  # pragma: no cover
    stub = types.ModuleType("imwatermark.rivaGan")

    class RivaWatermark:  # minimal stand-in, never used for dwtDct
        pass

    stub.RivaWatermark = RivaWatermark
    sys.modules["imwatermark.rivaGan"] = stub

import cv2  # noqa: E402
from PIL import Image  # noqa: E402
from PIL.PngImagePlugin import PngInfo  # noqa: E402
from imwatermark import WatermarkDecoder, WatermarkEncoder  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

SDXL_BITS = [int(b) for b in bin(0b101100111110110010010000011110111011000110011110)[2:]]
FLUX_BITS = [int(b) for b in bin(0b001010101111111010000111100111001111010100101110)[2:]]
assert len(SDXL_BITS) == 48 and len(FLUX_BITS) == 46


def base_image(h=256, w=320, seed=7):
    """Deterministic, photo-ish RGB uint8 image (smooth colour fields + texture)."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    r = 128 + 80 * np.sin(x / 37.0) * np.cos(y / 53.0) + 30 * np.sin((x + y) / 11.0)
    g = 110 + 70 * np.cos(x / 29.0 + 1.3) + 40 * np.sin(y / 17.0)
    b = 140 + 60 * np.sin((x - y) / 41.0) + 25 * np.cos(x / 7.0) * np.sin(y / 9.0)
    img = np.stack([r, g, b], axis=-1) + rng.normal(0, 6, (h, w, 3))
    return np.clip(img, 0, 255).round().astype(np.uint8)


def bits_of(payload):
    return [int(b) for b in np.unpackbits(np.frombuffer(payload, dtype=np.uint8))]


def py_decode(bgr_uint8, n_bits):
    dec = WatermarkDecoder("bits", n_bits)
    return [int(b) for b in dec.decode(bgr_uint8, "dwtDct")]


def py_votes(bgr_uint8):
    """Per-block votes of the reference decoder (uint8 BGR path), as a 0/1 string."""
    from imwatermark.maxDct import EmbedMaxDct
    import pywt

    row, col, _ = bgr_uint8.shape
    yuv = cv2.cvtColor(bgr_uint8, cv2.COLOR_BGR2YUV)
    ca, _ = pywt.dwt2(yuv[: row // 4 * 4, : col // 4 * 4, 1], "haar")
    scores = [[]]
    EmbedMaxDct(watermarks=[], wmLen=1).decode_frame(ca, 36, scores)
    return "".join(str(int(v)) for v in scores[0])


def main():
    rgb = base_image()
    Image.fromarray(rgb).save(os.path.join(HERE, "clean.png"), optimize=True)
    expected = {}

    # --- SD 1.x (uint8 BGR, proper channel order) + A1111-style text chunk ---
    enc = WatermarkEncoder()
    enc.set_watermark("bytes", b"StableDiffusionV1")
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    out = enc.encode(bgr, "dwtDct")
    out_rgb = out[:, :, ::-1]
    info = PngInfo()
    info.add_text(
        "parameters",
        "a lighthouse at dusk\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, "
        "Size: 320x256, Model: v1-5-pruned-emaonly",
    )
    Image.fromarray(out_rgb).save(os.path.join(HERE, "sd1_bytes.png"), pnginfo=info, optimize=True)
    rt = cv2.imread(os.path.join(HERE, "sd1_bytes.png"))
    expected["sd1_bytes.png"] = {
        "payload": "sd1",
        "bits": bits_of(b"StableDiffusionV1"),
        "pythonDecoded": py_decode(rt, 136),
        "pythonVotes": py_votes(rt),
    }

    # --- SD 2.x (uint8 BGR) ---
    enc = WatermarkEncoder()
    enc.set_watermark("bytes", b"SDV2")
    out = enc.encode(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), "dwtDct")
    Image.fromarray(np.ascontiguousarray(out[:, :, ::-1])).save(os.path.join(HERE, "sd2_bytes.png"), optimize=True)
    rt = cv2.imread(os.path.join(HERE, "sd2_bytes.png"))
    expected["sd2_bytes.png"] = {
        "payload": "sd2",
        "bits": bits_of(b"SDV2"),
        "pythonDecoded": py_decode(rt, 32),
        "pythonVotes": py_votes(rt),
    }

    # --- SDXL via diffusers: float32 RGB passed straight in (no BGR swap) ---
    enc = WatermarkEncoder()
    enc.set_watermark("bits", SDXL_BITS)
    f = rgb.astype(np.float32)
    out = enc.encode(f, "dwtDct")
    out_u8 = np.clip(out, 0, 255).round().astype(np.uint8)  # still RGB order
    Image.fromarray(out_u8).save(os.path.join(HERE, "sdxl_diffusers.png"), optimize=True)
    rt = cv2.imread(os.path.join(HERE, "sdxl_diffusers.png"))
    expected["sdxl_diffusers.png"] = {
        "payload": "sdxl",
        "bits": SDXL_BITS,
        "pythonDecoded": py_decode(rt, 48),
        "pythonVotes": py_votes(rt),
        "pythonDecodedRgbAsBgr": py_decode(np.ascontiguousarray(rt[:, :, ::-1]), 48),
    }

    # --- FLUX reference: float32, RGB->BGR, 46 bits, truncating uint8 cast ---
    enc = WatermarkEncoder()
    enc.set_watermark("bits", FLUX_BITS)
    f = np.ascontiguousarray(rgb.astype(np.float32)[:, :, ::-1])
    out = enc.encode(f, "dwtDct")
    out_rgb = np.ascontiguousarray(out[:, :, ::-1])
    x = 2.0 * np.clip(out_rgb / 255.0, 0.0, 1.0) - 1.0
    out_u8 = (127.5 * (x + 1.0)).astype(np.uint8)
    Image.fromarray(out_u8).save(os.path.join(HERE, "flux_ref.png"), optimize=True)
    rt = cv2.imread(os.path.join(HERE, "flux_ref.png"))
    expected["flux_ref.png"] = {
        "payload": "flux",
        "bits": FLUX_BITS,
        "pythonDecoded": py_decode(rt, 46),
        "pythonVotes": py_votes(rt),
    }

    # --- Negative control ---
    rt = cv2.imread(os.path.join(HERE, "clean.png"))
    expected["clean.png"] = {
        "payload": None,
        "pythonDecoded48": py_decode(rt, 48),
    }

    # --- NovelAI stealth_pngcomp (alpha LSB, column-major, gzip JSON) ---
    meta = {
        "Software": "NovelAI",
        "Source": "NovelAI Diffusion V4.5 4BDE2A90",
        "Comment": json.dumps({"prompt": "a lighthouse at dusk", "steps": 28, "scale": 5.0}),
    }
    payload = gzip.compress(json.dumps(meta).encode("utf-8"), mtime=0)
    data = b"stealth_pngcomp" + (len(payload) * 8).to_bytes(4, "big") + payload
    bits = np.unpackbits(np.frombuffer(data, dtype=np.uint8))
    h, w = 64, 64
    assert len(bits) <= h * w
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[:, :, :3] = base_image(h, w, seed=3)
    alpha = np.full((h, w), 255, dtype=np.uint8)
    # column-major: row index increments fastest
    flat = alpha.T.reshape(-1).copy()
    flat[: len(bits)] = (flat[: len(bits)] & 0xFE) | bits
    alpha = flat.reshape(w, h).T
    rgba[:, :, 3] = alpha
    Image.fromarray(rgba, "RGBA").save(os.path.join(HERE, "novelai_stealth.png"), optimize=True)
    expected["novelai_stealth.png"] = {"mode": "stealth_pngcomp", "metadata": meta}

    with open(os.path.join(HERE, "expected.json"), "w") as fh:
        json.dump(expected, fh, indent=1)
        fh.write("\n")
    print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk != "metadata"} for k, v in expected.items()}))


if __name__ == "__main__":
    main()
