#!/usr/bin/env python3
"""Builds the icon candidates in out/ — every one a square gradient tile.

The tile is the constant: --grad-a bottom-left to --grad-b top-right, run at
full strength rather than the washed-out version the first icon used. What
sits on it is the variable, and the only real test is the last one in each
row of the contact sheet: a favicon is 16 pixels, and a mark that needs more
than that is not a mark.

Letterforms come from the wordmark; the drawn marks are alternatives for when
the letter is not wanted. Photographic marks live in gen-icon-cutouts.py.

    python3 brand/gen-icons.py
"""

import math

from palette import GRAD_A, GRAD_B, INK, tile_gradient, write_svg
from typography import serif

S = 512


def tile(name, inner, ground="grad", size=S):
    """Lay `inner` on the icon field. ground='ink' flips to near-black."""
    defs = (
        tile_gradient(0, size, size, 0, "bg")
        + tile_gradient(0, size, size, 0, "fg")
    )
    fill = "url(#bg)" if ground == "grad" else INK
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {size} {size}"><defs>{defs}</defs>'
        f'<rect width="{size}" height="{size}" fill="{fill}"/>{inner}</svg>'
    )
    return write_svg(name, svg, size, size)


def letter(name, text="A.", ground="grad", height=0.62, size=S):
    """The wordmark's initial, centred on its ink rather than its metrics.

    The hairline stroke matters: Instrument Serif is a high-contrast face, and
    without thickening, its thin strokes vanish entirely when a browser
    resamples 512 pixels down to 16."""
    probe = 1000
    x0, y0, x1, y1 = serif.bounds(text, probe)
    fs = probe * (height * size) / (y1 - y0)
    x0, y0, x1, y1 = serif.bounds(text, fs)
    d, _ = serif.path(text, fs, x=(size - (x1 - x0)) / 2 - x0, y=(size - (y1 - y0)) / 2 - y0)
    paint = INK if ground == "grad" else "url(#fg)"
    return tile(
        name,
        f'<path d="{d}" fill="{paint}" stroke="{paint}" '
        f'stroke-width="{0.016 * size}" stroke-linejoin="round"/>',
        ground,
        size,
    )


def _box(points, size=S, inset=0.19):
    """Map a shape authored in a 0..100 box onto the tile."""
    span = size * (1 - 2 * inset)
    o = size * inset
    return " ".join(
        c if isinstance(c, str) else f"{o + c[0] / 100 * span:.2f},{o + c[1] / 100 * span:.2f}"
        for c in points
    )


def plane(name, ground="grad", size=S):
    """A paper dart. Autopilot is a flight word and the hero's CTA already
    lifts a plane off; three flat faces survive any resampling."""
    paint = INK if ground == "grad" else "url(#fg)"
    wing = _box(["M", (98, 3), "L", (2, 48), "L", (44, 63), "Z"], size)
    body = _box(["M", (98, 3), "L", (44, 63), "L", (60, 97), "Z"], size)
    return tile(
        name,
        f'<path d="{wing}" fill="{paint}"/>'
        f'<path d="{body}" fill="{paint}" fill-opacity="0.62"/>',
        ground,
        size,
    )


def orb(name, ground="grad", pitch=17, size=S):
    """A sphere built from halftone dots — the language src/components/ui/
    halftone.tsx and the token art already speak, with nobody's face in it."""
    paint = INK if ground == "grad" else "url(#fg)"
    c, radius = size / 2, size * 0.355
    dots = []
    for iy in range(int(size / pitch) + 2):
        for ix in range(int(size / pitch) + 2):
            x, y = (ix + 0.5) * pitch, (iy + 0.5) * pitch
            dx, dy = (x - c) / radius, (y - c) / radius
            falloff = dx * dx + dy * dy
            if falloff > 1:
                continue
            # Lambert shading off an upper-left key, so dots swell toward the
            # terminator and the ball turns instead of reading as a flat disc.
            z = math.sqrt(max(0.0, 1 - falloff))
            lit = max(0.0, -dx * 0.55 - dy * 0.55 + z * 0.63)
            r = (pitch * 0.52) * math.sqrt(max(0.0, min(1.0, 1 - lit)))
            if r > 0.35:
                dots.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.2f}"/>')
    return tile(name, f'<g fill="{paint}">{"".join(dots)}</g>', ground, size)


if __name__ == "__main__":
    for size, suffix in ((S, ""), (800, "-800")):
        letter(f"icon-letter{suffix}", size=size)
        letter(f"icon-letter-ink{suffix}", ground="ink", size=size)
        plane(f"icon-plane{suffix}", size=size)
        orb(f"icon-orb{suffix}", size=size)
        orb(f"icon-orb-ink{suffix}", ground="ink", size=size)
    print("wrote icon-letter, icon-letter-ink, icon-plane, icon-orb, icon-orb-ink (512 and 800)")
