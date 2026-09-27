// Shared metric helpers for the T7 eval/fit scripts.

export const sigmoid = (x) => 1 / (1 + Math.exp(-x));
export const logit = (p) => {
  const q = Math.min(1 - 1e-7, Math.max(1e-7, p));
  return Math.log(q / (1 - q));
};

/** AUROC via rank statistics (ties count half). */
export function auroc(scores, labels) {
  const idx = scores.map((s, i) => [s, labels[i]]).filter(([s]) => Number.isFinite(s));
  idx.sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  let nPos = 0;
  let nNeg = 0;
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j < idx.length && idx[j][0] === idx[i][0]) j++;
    const avg = (i + j + 1) / 2;
    for (let k = i; k < j; k++) {
      if (idx[k][1] === 1) {
        rankSum += avg;
        nPos++;
      } else nNeg++;
    }
    i = j;
  }
  if (!nPos || !nNeg) return NaN;
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** Score at which a fraction `fpr` of the negatives score strictly higher. */
export function thresholdAtFpr(scores, labels, fpr) {
  const neg = scores.filter((s, i) => labels[i] === 0 && Number.isFinite(s)).sort((a, b) => b - a);
  if (!neg.length) return NaN;
  const k = Math.floor(fpr * neg.length);
  return neg[Math.min(k, neg.length - 1)] + 1e-9;
}

export function rates(scores, labels, thr) {
  let tp = 0, fp = 0, pos = 0, neg = 0;
  scores.forEach((s, i) => {
    if (!Number.isFinite(s)) return;
    if (labels[i] === 1) {
      pos++;
      if (s >= thr) tp++;
    } else {
      neg++;
      if (s >= thr) fp++;
    }
  });
  return {
    tpr: pos ? tp / pos : NaN,
    fpr: neg ? fp / neg : NaN,
    precision: tp + fp ? tp / (tp + fp) : NaN,
    pos,
    neg,
  };
}

/** TPR at the threshold giving `fpr` on these same labels. */
export function tprAtFpr(scores, labels, fpr) {
  return rates(scores, labels, thresholdAtFpr(scores, labels, fpr)).tpr;
}

/** Pool-adjacent-violators isotonic regression; returns blocks {x (weighted mean), y, w}. */
export function isotonic(xs, ys) {
  const pts = xs.map((x, i) => ({ x, y: ys[i] })).filter((p) => Number.isFinite(p.x));
  pts.sort((a, b) => a.x - b.x);
  const blocks = [];
  for (const p of pts) {
    blocks.push({ sy: p.y, sx: p.x, w: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sy / a.w < b.sy / b.w) break;
      blocks.splice(blocks.length - 2, 2, { sy: a.sy + b.sy, sx: a.sx + b.sx, w: a.w + b.w });
    }
  }
  return blocks.map((b) => ({ x: b.sx / b.w, y: b.sy / b.w, w: b.w }));
}

/**
 * Isotonic fit as a piecewise-linear curve through the blocks' centroids.
 * Blocks with under `minFrac` of the data are merged into a neighbour, each
 * block's rate is shrunk a little towards 50% (`priorWeight` pseudo-texts),
 * and the ends are held flat and clamped to [lo, hi].
 */
export function displayCurve(xs, ys, { minFrac = 0.03, lo = 0.02, hi = 0.98, prior = 0.5, priorWeight = 3 } = {}) {
  let blocks = isotonic(xs, ys).map((b) => ({ sx: b.x * b.w, sy: b.y * b.w, w: b.w }));
  const total = blocks.reduce((a, b) => a + b.w, 0);
  const min = Math.max(5, minFrac * total);
  let merged = true;
  while (merged && blocks.length > 2) {
    merged = false;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].w >= min) continue;
      const j = i === 0 ? 1 : i === blocks.length - 1 ? i - 1 : blocks[i - 1].w < blocks[i + 1].w ? i - 1 : i + 1;
      const a = blocks[Math.min(i, j)];
      const b = blocks[Math.max(i, j)];
      blocks.splice(Math.min(i, j), 2, { sx: a.sx + b.sx, sy: a.sy + b.sy, w: a.w + b.w });
      merged = true;
      break;
    }
  }
  const knots = blocks.map((b) => ({ x: b.sx / b.w, y: (b.sy + prior * priorWeight) / (b.w + priorWeight) }));
  for (let i = 1; i < knots.length; i++) knots[i].y = Math.max(knots[i].y, knots[i - 1].y);
  const X = [];
  const Y = [];
  const push = (x, y) => {
    x = +x.toFixed(4);
    y = +Math.min(hi, Math.max(lo, y)).toFixed(4);
    if (X.length && x <= X[X.length - 1]) {
      Y[Y.length - 1] = Math.max(Y[Y.length - 1], y);
      return;
    }
    X.push(x);
    Y.push(y);
  };
  push(0, knots[0]?.y ?? prior);
  for (const k of knots) push(k.x, k.y);
  push(1, knots[knots.length - 1]?.y ?? prior);
  return { x: X, y: Y };
}

export function interp(curve, v) {
  const { x, y } = curve;
  if (v <= x[0]) return y[0];
  for (let i = 1; i < x.length; i++) {
    if (v <= x[i]) {
      const t = (v - x[i - 1]) / (x[i] - x[i - 1] || 1);
      return y[i - 1] + t * (y[i] - y[i - 1]);
    }
  }
  return y[y.length - 1];
}

/** Expected calibration error with `bins` equal-width bins, plus the reliability table. */
export function ece(probs, labels, bins = 10) {
  const b = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  probs.forEach((p, i) => {
    if (!Number.isFinite(p)) return;
    const k = Math.min(bins - 1, Math.floor(p * bins));
    b[k].n++;
    b[k].p += p;
    b[k].y += labels[i];
  });
  const n = b.reduce((a, x) => a + x.n, 0);
  let e = 0;
  const table = [];
  for (const x of b) {
    if (!x.n) continue;
    e += (x.n / n) * Math.abs(x.p / x.n - x.y / x.n);
    table.push({ meanP: x.p / x.n, fracAI: x.y / x.n, n: x.n });
  }
  return { ece: e, table };
}

/** Plain logistic regression (gradient descent, L2), returns {w: [...], b}. */
export function logreg(X, y, { lambda = 0.01, iters = 4000, lr = 0.2 } = {}) {
  const d = X[0].length;
  const mu = Array(d).fill(0);
  const sd = Array(d).fill(0);
  for (const r of X) r.forEach((v, j) => (mu[j] += v / X.length));
  for (const r of X) r.forEach((v, j) => (sd[j] += (v - mu[j]) ** 2 / X.length));
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
  let w = Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0);
    let gb = 0;
    Z.forEach((z, i) => {
      const e = sigmoid(b + z.reduce((a, v, j) => a + v * w[j], 0)) - y[i];
      gb += e;
      z.forEach((v, j) => (gw[j] += e * v));
    });
    b -= (lr * gb) / Z.length;
    w = w.map((wj, j) => wj - lr * (gw[j] / Z.length + lambda * wj));
  }
  const W = w.map((wj, j) => wj / sd[j]);
  return { w: W, b: b - W.reduce((a, wj, j) => a + wj * mu[j], 0) };
}

export const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "–");
export const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : "–");
