#!/usr/bin/env python3
"""Offline punctuation + truecasing for the transcript eval (docs/calibration.md
"Transcripts"): runs 1-800-BAD-CODE/punctuation_fullstop_truecase_english
(Apache-2.0, ONNX, ~210 MB) via the `punctuators` package over the normalised
(lowercase, unpunctuated) eval texts, and writes a word list per item aligned
1:1 with the input words (items whose word count changes are dropped).

  pip install punctuators
  python restore-punctuation.py norm.json restored.json
"""
import json
import sys

from punctuators.models import PunctCapSegModelONNX

src, dst = sys.argv[1], sys.argv[2]
norm = json.load(open(src))
m = PunctCapSegModelONNX.from_pretrained("pcs_en")  # = 1-800-BAD-CODE/punctuation_fullstop_truecase_english
ids = list(norm)
texts = [" ".join(norm[i]) for i in ids]
out, dropped = {}, 0
for k in range(0, len(texts), 16):
    res = m.infer(texts[k : k + 16], apply_sbd=False)
    for i, r in zip(ids[k : k + 16], res):
        words = (r if isinstance(r, str) else " ".join(r)).split()
        if len(words) == len(norm[i]):
            out[i] = words
        else:
            dropped += 1
json.dump(out, open(dst, "w"))
print(f"restored {len(out)}, dropped {dropped}", file=sys.stderr)
