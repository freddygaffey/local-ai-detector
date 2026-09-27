// SVG radial gauge: pure geometry helpers (unit-tested) plus a small DOM
// builder/updater. The dial sweeps 270° clockwise from the lower-left to the
// lower-right, leaving a 90° gap at the bottom — an instrument-panel dial,
// not a decorative ring. Animation is done with CSS `stroke-dashoffset`
// transitions (see src/ui/styles.css), which `prefers-reduced-motion: reduce`
// disables automatically; the geometry math below has nothing to do with
// motion, so it needs no reduced-motion branch itself.

export const GAUGE_SIZE = 200;
export const GAUGE_RADIUS = 82;
export const GAUGE_STROKE = 14;
export const GAUGE_SWEEP_DEG = 270;
/** Degrees clockwise from straight up (12 o'clock) to the dial's start (needle at 0%). */
export const GAUGE_START_DEG = -225;

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** A point on a circle of radius `r` centred at (cx, cy), `angleDeg` clockwise from 12 o'clock. */
export function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** SVG arc path `d` for a circle segment from `startDeg` to `endDeg` (clockwise, from 12 o'clock). */
export function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const start = polarToCartesian(cx, cy, r, startDeg);
  const end = polarToCartesian(cx, cy, r, endDeg);
  const largeArc = endDeg - startDeg <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

/** Total path length of a `sweepDeg`-wide arc of radius `r`. */
export function arcLength(r: number, sweepDeg: number): number {
  return r * (sweepDeg * Math.PI) / 180;
}

/** 0..1 score -> the angle (degrees, clockwise from 12 o'clock) of the dial's fill end. */
export function angleForScore(score: number): number {
  return GAUGE_START_DEG + clamp01(score) * GAUGE_SWEEP_DEG;
}

/**
 * The `stroke-dashoffset` to apply to the fill arc so it visually reaches
 * `score` (0..1) of the way around the track. The dash array is set to
 * `[length, length]` once, so offset `length` = empty, `0` = full.
 */
export function dashOffsetForScore(score: number, length: number): number {
  return length * (1 - clamp01(score));
}

export interface GaugeElements {
  svg: SVGSVGElement;
  fill: SVGPathElement;
  valueText: HTMLElement;
}

/** Builds the gauge's static SVG markup once. Call `updateGauge` to animate it. */
export function buildGaugeSvg(): SVGSVGElement {
  const cx = GAUGE_SIZE / 2;
  const cy = GAUGE_SIZE / 2 + 6;
  const start = GAUGE_START_DEG;
  const end = GAUGE_START_DEG + GAUGE_SWEEP_DEG;
  const d = describeArc(cx, cy, GAUGE_RADIUS, start, end);
  const len = arcLength(GAUGE_RADIUS, GAUGE_SWEEP_DEG);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", `0 0 ${GAUGE_SIZE} ${GAUGE_SIZE}`);
  svg.setAttribute("class", "gauge");
  svg.setAttribute("role", "img");

  const track = document.createElementNS("http://www.w3.org/2000/svg", "path");
  track.setAttribute("class", "gauge-track");
  track.setAttribute("d", d);
  track.setAttribute("stroke-width", String(GAUGE_STROKE));
  track.setAttribute("fill", "none");
  svg.appendChild(track);

  // Three static tick marks for the band boundaries (35% / 65%), so the dial
  // reads like an instrument even before the fill animates in.
  for (const boundary of [0, 0.35, 0.65, 1]) {
    const angle = angleForScore(boundary);
    const inner = polarToCartesian(cx, cy, GAUGE_RADIUS - GAUGE_STROKE, angle);
    const outer = polarToCartesian(cx, cy, GAUGE_RADIUS + GAUGE_STROKE * 0.4, angle);
    const tick = document.createElementNS("http://www.w3.org/2000/svg", "line");
    tick.setAttribute("class", "gauge-tick");
    tick.setAttribute("x1", String(inner.x));
    tick.setAttribute("y1", String(inner.y));
    tick.setAttribute("x2", String(outer.x));
    tick.setAttribute("y2", String(outer.y));
    svg.appendChild(tick);
  }

  const fill = document.createElementNS("http://www.w3.org/2000/svg", "path");
  fill.setAttribute("class", "gauge-fill");
  fill.setAttribute("d", d);
  fill.setAttribute("stroke-width", String(GAUGE_STROKE));
  fill.setAttribute("fill", "none");
  fill.setAttribute("stroke-dasharray", `${len} ${len}`);
  fill.setAttribute("stroke-dashoffset", String(len));
  fill.setAttribute("pathLength", String(len));
  svg.appendChild(fill);

  return svg;
}

/** Animates the fill arc to `score` (0..1) and colours it by `bandClass` (e.g. "band-ai"). */
export function updateGauge(svg: SVGSVGElement, score: number, bandClass: string): void {
  const fill = svg.querySelector<SVGPathElement>(".gauge-fill");
  if (!fill) return;
  const len = arcLength(GAUGE_RADIUS, GAUGE_SWEEP_DEG);
  fill.setAttribute("stroke-dashoffset", String(dashOffsetForScore(score, len)));
  fill.setAttribute("class", `gauge-fill ${bandClass}`);
}
