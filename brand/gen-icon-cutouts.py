#!/usr/bin/env python3
"""Lifts the figures in sources/ onto the gradient tile.

Read sources/README.md before shipping any of these — they are found images.

Two treatments, because no single one fits every source:

  badge  — circle-crop the shot as it is and ring it in the gradient. Needs no
           keying, works even where the subject is darker than its ground, and
           the disc gives the eye one shape to hold at favicon size. It is
           also the object the token art already is.
  cutout — key the near-black ground out on luminance, keeping haze and sparks
           in a soft edge, and set the bare figure on the tile. Handsome at
           512, noise at 16: there is no containing shape.

Either can be re-lit first. gradient_map drives a mint-to-violet ramp off
luminance, which keeps a figure's form while stopping its original lighting
from arguing with the tile.

    python3 brand/gen-icon-cutouts.py
"""

import numpy as np
from PIL import Image, ImageDraw

from palette import OUT, RGB_A, RGB_B, SOURCES

S = 512

# Luminance to brand colour. The dark end stays near-black so a silhouette
# survives, the mid takes the mint, and only true highlights reach violet and
# white — which is where a chrome render keeps its sparkle.
BRAND_RAMP = [
    (0.00, (5, 5, 9)),
    (0.28, (10, 40, 45)),
    (0.55, (0, 200, 140)),
    (0.78, (120, 190, 255)),
    (0.92, (200, 90, 240)),
    (1.00, (255, 255, 255)),
]


def luminance(rgb):
    a = np.asarray(rgb.convert("RGB")).astype(np.float32) / 255
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


def _bloom(shape, cx, cy, radius, rgb, alpha):
    """One radial tint, falling off linearly the way an SVG radialGradient
    does, so the tile matches the banner's field exactly."""
    h, w = shape
    y, x = np.mgrid[0:h, 0:w]
    r = np.sqrt(((x - cx * w) / (radius * w)) ** 2 + ((y - cy * h) / (radius * h)) ** 2)
    return np.clip(1 - r, 0, 1)[..., None] * alpha * np.array(rgb, np.float32)


def tile(size=S, ground="soft"):
    """The field an icon sits on.

    soft — the banner's pastel wash and dot grid. Same material as the header,
           which is the point: the avatar and the banner behind it read as one
           surface instead of two designs that happen to share a hue.
    grad — the gradient at full strength. Louder in a tab strip, but it fights
           anything photographic laid over it.
    ink  — near-black, for marks that need a dark ground to rim-light against.
    """
    if ground == "ink":
        return Image.new("RGB", (size, size), (10, 10, 10))
    if ground == "grad":
        y, x = np.mgrid[0:size, 0:size]
        t = np.clip((x + (size - y)) / (2 * size), 0, 1)[..., None]
        field = np.array(RGB_A) * (1 - t) + np.array(RGB_B) * t
        return Image.fromarray(field.astype(np.uint8), "RGB")

    field = np.full((size, size, 3), 255.0, np.float32)
    field -= _bloom((size, size), 0.02, 0.02, 0.95, (255 - np.array(RGB_A)), 0.30)
    field -= _bloom((size, size), 1.02, 1.02, 0.92, (255 - np.array(RGB_B)), 0.24)

    # The dot grid at the same pitch the banner uses, scaled with the tile so
    # 512 and 800 look identical side by side.
    pitch = size * 20 / 512
    y, x = np.mgrid[0:size, 0:size]
    d = np.sqrt(((x % pitch) - 1.6) ** 2 + ((y % pitch) - 1.6) ** 2)
    dots = np.clip(1.15 - d + 0.5, 0, 1)[..., None]
    field = field * (1 - dots * 0.10)
    return Image.fromarray(np.clip(field, 0, 255).astype(np.uint8), "RGB")


def gradient_map(im, stops=BRAND_RAMP):
    lum = luminance(im)
    pos = np.array([s[0] for s in stops], np.float32)
    cols = np.array([s[1] for s in stops], np.float32)
    out = np.stack([np.interp(lum, pos, cols[:, i]) for i in range(3)], -1)
    return Image.fromarray(out.astype(np.uint8), "RGB")


def key_out(im, lo=0.10, hi=0.34):
    """Alpha ramps with luminance and is smoothstepped, so the matte has no
    hard line and glow stays attached to the figure."""
    alpha = np.clip((luminance(im) - lo) / (hi - lo), 0, 1)
    alpha = alpha * alpha * (3 - 2 * alpha)
    out = im.convert("RGBA")
    out.putalpha(Image.fromarray((alpha * 255).astype(np.uint8), "L"))
    return out


def ring(size, thickness):
    """The gradient ring the token art wears, so a badge matches the coins."""
    y, x = np.mgrid[0:size, 0:size]
    t = np.clip((x + (size - y)) / (2 * size), 0, 1)[..., None]
    col = (np.array(RGB_A) * (1 - t) + np.array(RGB_B) * t).astype(np.uint8)
    grad = Image.fromarray(np.dstack([col, np.full((size, size, 1), 255, np.uint8)]), "RGBA")
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([1, 1, size - 2, size - 2], outline=255, width=thickness)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def badge(name, source, zoom=1.0, shift=0.0, ground="soft", tone=False, size=S):
    """zoom crops in on the subject; shift moves the crop down the frame as a
    fraction of its height (negative rides up, which is where heads are)."""
    im = Image.open(SOURCES / source).convert("RGB")
    if tone:
        im = gradient_map(im)
    w, h = im.size
    side = min(w, h) / zoom
    cx, cy = w / 2, h / 2 + shift * h
    im = im.crop((round(cx - side / 2), round(cy - side / 2),
                  round(cx + side / 2), round(cy + side / 2)))

    d = round(size * 0.80)
    im = im.resize((d, d), Image.LANCZOS)
    # Draw the mask big and shrink it: a circle rasterised at 1x has stair-steps.
    mask = Image.new("L", (d * 4, d * 4), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, d * 4 - 1, d * 4 - 1], fill=255)
    disc = im.convert("RGBA")
    disc.putalpha(mask.resize((d, d), Image.LANCZOS))
    disc = Image.alpha_composite(disc, ring(d, round(d * 0.035)))

    base = tile(size, ground).convert("RGBA")
    base.alpha_composite(disc, ((size - d) // 2, (size - d) // 2))
    OUT.mkdir(exist_ok=True)
    base.convert("RGB").save(OUT / f"{name}.png")


def cutout(name, source, ground="soft", fill=0.90, size=S, **kw):
    fig = key_out(Image.open(SOURCES / source).convert("RGB"), **kw)
    box = fig.split()[3].point(lambda v: 255 if v > 40 else 0).getbbox()
    if box:
        fig = fig.crop(box)
    k = size * fill / max(fig.size)
    fig = fig.resize((max(1, round(fig.width * k)), max(1, round(fig.height * k))), Image.LANCZOS)

    base = tile(size, ground).convert("RGBA")
    base.alpha_composite(fig, ((size - fig.width) // 2, (size - fig.height) // 2))
    OUT.mkdir(exist_ok=True)
    base.convert("RGB").save(OUT / f"{name}.png")


# zoom/shift were dialled in by eye per source — heads sit high in every one.
FRAMING = {
    "disco.png": (1.6, -0.10),
    "blueghost.png": (1.5, -0.06),
    "greenglass.png": (1.25, -0.05),
    "rimbust.png": (1.35, -0.08),
    "xray.png": (1.1, 0.0),
    "eyes.png": (1.2, -0.06),
    "crystal.png": (1.15, -0.05),
    "spartan.png": (1.35, -0.12),
}

# 512 is the favicon master; 800 is the X avatar at retina, which X downsamples
# to the 400 it displays.
OUTPUT_SIZES = ((512, ""), (800, "-800"))

if __name__ == "__main__":
    for src, (zoom, shift) in FRAMING.items():
        stem = src.removesuffix(".png")
        for size, suffix in OUTPUT_SIZES:
            badge(f"badge-{stem}{suffix}", src, zoom, shift, size=size)
            badge(f"badge-{stem}-brand{suffix}", src, zoom, shift, tone=True, size=size)

    # Only the near-black grounds key cleanly; the rest keep their own frame.
    for src in ("xray.png", "eyes.png", "crystal.png", "spartan.png"):
        stem = src.removesuffix(".png")
        cutout(f"cutout-{stem}", src)
        cutout(f"cutout-{stem}-ink", src, ground="ink")

    print(f"wrote badges and cutouts to {OUT}")
