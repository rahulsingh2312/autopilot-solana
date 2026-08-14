#!/usr/bin/env python3
"""Builds out/profile-preview*.png — the banner as each device actually shows it.

A header only fails once it is uploaded, which is a slow way to find out. Both
previews composite a candidate banner with a candidate avatar at positions
measured off live @AutopilotxSOL screenshots.

    python3 brand/gen-profile-preview.py x-banner-italic badge-crystal-brand

Desktop and mobile fail in completely different places, so both are drawn:

  desktop — full width, and the avatar disc punched into the bottom-left
  mobile  — the header keeps its height and loses roughly 142px off each
            side, and the avatar drops below it instead of into it
"""

import sys

from PIL import Image, ImageDraw

from palette import OUT

W, H = 1500, 500

# In banner coordinates: the disc spans x 50..392 and starts at y 330, running
# off the bottom edge. The published safe-area guidance is more optimistic.
AVATAR_CX, AVATAR_CY, AVATAR_R = 221, 500, 171
RING = 10

# What a phone trims from each edge, read back off the wordmark and the coin
# row in a screenshot. See MOBILE_CROP in gen-x-banner.py.
MOBILE_CROP = 142


def _disc(avatar, diameter):
    pic = Image.open(OUT / f"{avatar}.png").convert("RGB").resize((diameter, diameter), Image.LANCZOS)
    mask = Image.new("L", (diameter * 4, diameter * 4), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, diameter * 4 - 1, diameter * 4 - 1], fill=255)
    pic = pic.convert("RGBA")
    pic.putalpha(mask.resize((diameter, diameter), Image.LANCZOS))
    return pic


def build_mobile(banner="x-banner-italic", avatar="badge-crystal-brand"):
    """The phone view: sides gone, avatar sitting under the header."""
    full = Image.open(OUT / f"{banner}.png").convert("RGB").resize((W, H), Image.LANCZOS)
    cropped = full.crop((MOBILE_CROP, 0, W - MOBILE_CROP, H))

    width = cropped.width
    canvas = Image.new("RGB", (width, cropped.height + 300), (0, 0, 0))
    canvas.paste(cropped, (0, 0))

    d = 300
    pic = _disc(avatar, d)
    x, y = 60, cropped.height - 40
    ImageDraw.Draw(canvas).ellipse([x - 12, y - 12, x + d + 12, y + d + 12], fill=(0, 0, 0))
    canvas.paste(pic, (x, y), pic)

    path = OUT / "profile-preview-mobile.png"
    canvas.save(path)
    return path


def build(banner="x-banner-italic", avatar="badge-crystal-brand"):
    base = Image.open(OUT / f"{banner}.png").convert("RGB").resize((W, H), Image.LANCZOS)
    # Everything below the header is the page, not the banner.
    canvas = Image.new("RGB", (W, H + 180), (0, 0, 0))
    canvas.paste(base, (0, 0))

    d = AVATAR_R * 2
    pic = _disc(avatar, d)

    draw = ImageDraw.Draw(canvas)
    draw.ellipse(
        [AVATAR_CX - AVATAR_R - RING, AVATAR_CY - AVATAR_R - RING,
         AVATAR_CX + AVATAR_R + RING, AVATAR_CY + AVATAR_R + RING],
        fill=(0, 0, 0),
    )
    canvas.paste(pic, (AVATAR_CX - AVATAR_R, AVATAR_CY - AVATAR_R), pic)

    path = OUT / "profile-preview.png"
    canvas.save(path)
    return path


if __name__ == "__main__":
    args = sys.argv[1:]
    print(build(*args))
    print(build_mobile(*args))
