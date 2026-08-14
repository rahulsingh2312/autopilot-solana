#!/usr/bin/env python3
"""Builds out/x-banner*.png — the profile header for x.com.

The share card (public/og.png) already solved what this brand looks like when
it has to sell itself in one frame, so this is that composition re-cut for a
strip three times as wide as it is tall: pastel field, dot grid, fat serif
headline, and the halftone tracker coins the wallet already shows.

Rendered at 2x and handed to X at 3000x1000. X downsamples to fit, and a
downsample from twice the size is what keeps the serif's hairlines and the
halftone dots from crawling on a retina screen.

    python3 brand/gen-x-banner.py            # both headline cuts, plus a preview
"""

import base64
import math

from palette import FAINT, GRAD_A, GRAD_A_INK, GRAD_B, GRAD_B_INK, INK, WEB, write_svg
from typography import italic, mono, serif

W, H = 1500, 500
SCALE = 2  # ship 3000x1000; X downsamples, and downsampling is free sharpness

HEADLINE = ("Trade the trader,", "not the market.")
STRAPLINE = "TRACKER TOKENS · SOLANA · READ LIVE FROM THE CHAIN"
COINS = ["bwsol", "pltsol", "icsol", "cgsol", "rdsol"]

# Both numbers below are measured off live profile screenshots, not taken from
# the published guidance, which understates the first and omits the second.
#
# Desktop: the avatar disc lands at x 50..392 and y 330 down, so nothing that
# has to be read may sit left of AVATAR_X *and* below AVATAR_Y. An early cut
# put "not the market." straight behind the picture.
AVATAR_X, AVATAR_Y = 420, 310

# Mobile: the header keeps its height and loses its sides. A phone showed the
# wordmark reading "topilot." — "Au" gone — and sliced the sixth coin down the
# middle, which puts the crop at roughly 130–142px per edge. MARGIN clears the
# worst of that with room to spare, and costs one coin from the row.
MOBILE_CROP = 142
MARGIN = 180

# Instrument Serif Italic leans about 12°. A touch more slant on top of that
# pushes the payoff line further from the roman one it answers.
EXTRA_SLANT = 5


def coin_uri(ticker):
    """Inline the token art so the SVG stands alone once written."""
    art = (WEB / "public" / "tokens" / f"{ticker}.png").read_bytes()
    return f"data:image/png;base64,{base64.b64encode(art).decode()}"


def slanted(d, baseline, degrees=EXTRA_SLANT, **attrs):
    """Lean a path further right. skewX pivots on y=0, which would drag the
    line sideways, so translate back by the shift it applies at the baseline."""
    shift = baseline * math.tan(math.radians(degrees))
    attr = " ".join(f'{k.replace("_", "-")}="{v}"' for k, v in attrs.items())
    return (
        f'<g transform="translate({shift:.2f},0) skewX({-degrees})">'
        f'<path d="{d}" {attr}/></g>'
    )


def build(both_italic=False, slant=EXTRA_SLANT):
    wordmark, ww = serif.path("Autopilot", 40, x=MARGIN, y=84)
    dot, _ = serif.path(".", 40, x=MARGIN + ww, y=84)

    # The strapline shares the top rule with the wordmark. With the margins
    # widened for the phone crop there is less rule to share, so size it to
    # what is actually left rather than to a number that used to fit.
    strap_size = 18
    room = W - MARGIN - (MARGIN + ww + 60)
    while mono.width(STRAPLINE, strap_size, tracking=0.09) > room and strap_size > 13:
        strap_size -= 0.5
    strap_w = mono.width(STRAPLINE, strap_size, tracking=0.09)
    strap, _ = mono.path(STRAPLINE, strap_size, x=W - MARGIN - strap_w, y=82, tracking=0.09)

    # Instrument Serif has no bold, so the headline is stroked in its own
    # colour — the same way the share card gets its weight.
    size = 84
    face_one = italic if both_italic else serif
    base_one, base_two = 190, 284
    line1, _ = face_one.path(HEADLINE[0], size, x=MARGIN, y=base_one)
    line2, _ = italic.path(HEADLINE[1], size, x=MARGIN, y=base_two)
    ink = {"fill": INK, "stroke": INK, "stroke_width": size * 0.055, "stroke_linejoin": "round"}

    head = (
        slanted(line1, base_one, slant if both_italic else 0, **ink)
        + slanted(line2, base_two, slant, **ink)
    )

    d, gap, cy = 104, 20, 300
    row_w = len(COINS) * d + (len(COINS) - 1) * gap
    x0 = W - MARGIN - row_w
    coins = "".join(
        f'<image href="{coin_uri(t)}" x="{x0 + i * (d + gap)}" y="{cy - d / 2}" '
        f'width="{d}" height="{d}"/>'
        for i, t in enumerate(COINS)
    )

    more_w = italic.width("+ many more", 32)
    more, _ = italic.path("+ many more", 32, x=W - MARGIN - more_w, y=cy + d / 2 + 48)

    return f"""<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs>
  <radialGradient id="mint" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="{GRAD_A}" stop-opacity="0.30"/>
    <stop offset="1" stop-color="{GRAD_A}" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="violet" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="{GRAD_B}" stop-opacity="0.24"/>
    <stop offset="1" stop-color="{GRAD_B}" stop-opacity="0"/>
  </radialGradient>
  <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
    <circle cx="1.6" cy="1.6" r="1.15" fill="{INK}" fill-opacity="0.10"/>
  </pattern>
  <linearGradient id="accent" x1="{MARGIN}" y1="320" x2="{MARGIN + 620}" y2="150" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="{GRAD_A_INK}"/><stop offset="1" stop-color="{GRAD_B_INK}"/>
  </linearGradient>
</defs>
<rect width="{W}" height="{H}" fill="#ffffff"/>
<ellipse cx="30" cy="40" rx="640" ry="470" fill="url(#mint)"/>
<ellipse cx="{W + 30}" cy="{H - 20}" rx="600" ry="470" fill="url(#violet)"/>
<ellipse cx="{W - 180}" cy="-70" rx="430" ry="330" fill="url(#violet)"/>
<rect width="{W}" height="{H}" fill="url(#grid)"/>
<path d="{wordmark}" fill="{INK}"/>
<path d="{dot}" fill="url(#accent)"/>
<path d="{strap}" fill="{FAINT}"/>
{head}
{coins}
<path d="{more}" fill="{INK}"/>
</svg>"""


def preview(source_svg):
    """Drop everything X takes back over the banner — the avatar disc on
    desktop, the side crop on mobile — so a layout can be checked before it is
    uploaded rather than after."""
    overlay = f"""
<rect x="0" y="0" width="{MOBILE_CROP}" height="{H}" fill="#ff0044" fill-opacity="0.20"/>
<rect x="{W - MOBILE_CROP}" y="0" width="{MOBILE_CROP}" height="{H}" fill="#ff0044" fill-opacity="0.20"/>
<line x1="{MARGIN}" y1="0" x2="{MARGIN}" y2="{H}" stroke="#0aa" stroke-width="2" stroke-dasharray="8 8"/>
<line x1="{W - MARGIN}" y1="0" x2="{W - MARGIN}" y2="{H}" stroke="#0aa" stroke-width="2" stroke-dasharray="8 8"/>
<rect x="0" y="{AVATAR_Y}" width="{AVATAR_X}" height="{H - AVATAR_Y}" fill="#ff0044" fill-opacity="0.14"/>
<circle cx="221" cy="500" r="171" fill="#0a0a0a" fill-opacity="0.55"/>
<circle cx="221" cy="500" r="171" fill="none" stroke="#ff0044" stroke-width="3"/>
</svg>"""
    return source_svg.replace("</svg>", overlay)


if __name__ == "__main__":
    for name, kwargs in (
        ("x-banner", {"both_italic": False}),
        ("x-banner-italic", {"both_italic": True}),
    ):
        svg = build(**kwargs)
        print(write_svg(name, svg, W * SCALE, H * SCALE))
    print(write_svg("x-banner-preview", preview(build()), W, H))
