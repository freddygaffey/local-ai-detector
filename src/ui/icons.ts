// Small inline SVG icons, built the same way as the gauge (no icon font, no
// external sprite — everything is local). Kept to the handful the UI
// actually needs, each doubling as a piece of the "instrument" identity
// rather than decoration.

function svg(viewBox: string, paths: string[], extra?: (svgEl: SVGSVGElement) => void): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
  el.setAttribute("viewBox", viewBox);
  el.setAttribute("width", "16");
  el.setAttribute("height", "16");
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("focusable", "false");
  for (const d of paths) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "currentColor");
    el.appendChild(p);
  }
  extra?.(el);
  return el;
}

/** The brand mark: a small dial with a needle, echoing the main gauge. */
export function brandMark(): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", "18");
  el.setAttribute("height", "18");
  el.setAttribute("class", "brand-mark");
  el.setAttribute("aria-hidden", "true");
  const arc = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arc.setAttribute("d", "M4.5 17.5a9 9 0 1 1 15 0");
  arc.setAttribute("fill", "none");
  arc.setAttribute("stroke", "currentColor");
  arc.setAttribute("stroke-width", "2");
  arc.setAttribute("stroke-linecap", "round");
  const needle = document.createElementNS("http://www.w3.org/2000/svg", "path");
  needle.setAttribute("d", "M12 17 L16 10");
  needle.setAttribute("stroke", "currentColor");
  needle.setAttribute("stroke-width", "2");
  needle.setAttribute("stroke-linecap", "round");
  const hub = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  hub.setAttribute("cx", "12");
  hub.setAttribute("cy", "17");
  hub.setAttribute("r", "1.6");
  hub.setAttribute("fill", "currentColor");
  el.append(arc, needle, hub);
  return el;
}

export function gearIcon(): SVGSVGElement {
  return svg("0 0 24 24", [
    "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8.94 2.6-1.64-.28a7.3 7.3 0 0 0-.5-1.2l.97-1.34a1 1 0 0 0-.1-1.29l-1.2-1.2a1 1 0 0 0-1.3-.1l-1.33.97a7.3 7.3 0 0 0-1.2-.5L14.36 4a1 1 0 0 0-1-.86h-1.7a1 1 0 0 0-1 .86l-.28 1.66a7.3 7.3 0 0 0-1.2.5L7.85 5.19a1 1 0 0 0-1.3.1l-1.2 1.2a1 1 0 0 0-.1 1.29l.97 1.33a7.3 7.3 0 0 0-.5 1.2l-1.66.29a1 1 0 0 0-.86 1v1.7a1 1 0 0 0 .86 1l1.66.28c.12.42.29.82.5 1.2l-.97 1.34a1 1 0 0 0 .1 1.29l1.2 1.2a1 1 0 0 0 1.3.1l1.33-.97c.38.21.78.38 1.2.5l.29 1.66a1 1 0 0 0 1 .86h1.7a1 1 0 0 0 1-.86l.28-1.66c.42-.12.82-.29 1.2-.5l1.34.97a1 1 0 0 0 1.29-.1l1.2-1.2a1 1 0 0 0 .1-1.3l-.97-1.33c.21-.38.38-.78.5-1.2l1.66-.28a1 1 0 0 0 .86-1v-1.7a1 1 0 0 0-.86-1Z",
  ], (el) => {
    // evenodd so the inner circle is cut out as the cog's hole instead of filled solid.
    el.querySelector("path")!.setAttribute("fill-rule", "evenodd");
  });
}

export function closeIcon(): SVGSVGElement {
  return svg("0 0 24 24", ["M6 6 18 18M18 6 6 18"], (el) => {
    const p = el.querySelector("path")!;
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2");
    p.setAttribute("stroke-linecap", "round");
  });
}

export function warnIcon(): SVGSVGElement {
  return svg("0 0 24 24", ["M12 3 22 20H2Zm0 5v6m0 3.2h.01"], (el) => {
    const p = el.querySelector("path")!;
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
  });
}

export function externalLinkIcon(): SVGSVGElement {
  return svg("0 0 24 24", ["M14 5h5v5M19 5 10 14M8 5H5v14h14v-3"], (el) => {
    const p = el.querySelector("path")!;
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.7");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
  });
}
