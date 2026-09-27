# Promo images

Generated tiles, ready to upload, plus their SVG sources so they can be
edited and re-rendered rather than redrawn from scratch.

| File | Size | Used for |
|---|---|---|
| `promo-small-440x280.png` | 440×280 | Chrome Web Store "Small promotional tile" (shown in search/category listings) |
| `promo-marquee-1400x560.png` | 1400×560 | Chrome Web Store "Marquee promotional tile" (optional; shown if your item is featured) |

Chrome Web Store also requires **at least one screenshot**, 1280×800 or
640×400 (PNG or JPEG, no alpha). Use the existing captures in
[`../../docs/screenshots/`](../../docs/screenshots/) (e.g. `popup-result.png`,
`page-heatmap.jpg`) — check each one is at least 640×400 before uploading; if
not, re-export at 1280×800 from the same source. AMO has no fixed promo-image
requirement beyond the icon and screenshots, which reuse the same
`docs/screenshots/` set.

## Regenerating

The `.svg` next to each `.png` is the source (plain SVG, no build step). Edit
the SVG, then re-render with [`rsvg-convert`](https://gitlab.gnome.org/GNOME/librsvg)
(or any SVG rasterizer — Inkscape's CLI, `resvg`, etc. work identically since
these are static shapes and system-font text, nothing exotic):

```sh
rsvg-convert -w 440  -h 280  promo-small-440x280.svg   -o promo-small-440x280.png
rsvg-convert -w 1400 -h 560  promo-marquee-1400x560.svg -o promo-marquee-1400x560.png
```

The icon mark inside each promo image is copied inline from
[`icon.svg`](../icon/icon.svg) (kept in sync manually — if the icon changes,
update both promo SVGs' `<g>` block to match).
