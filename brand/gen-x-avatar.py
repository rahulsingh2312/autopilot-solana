#!/usr/bin/env python3
"""Builds out/x-avatar*.png — the profile picture, on paper rather than ink.

The tab icon (web/src/app/icon.png) is the mark everyone already recognises:
the cat on --paper, with a teal wash in one corner and a lilac one in the
other. This renders that same framing at avatar scale, with two changes X
forces:

  full bleed  — X crops the upload to a circle, so the tab icon's rounded
                square would only survive as four clipped stubs. The paper
                runs to the edge instead and the crop never touches artwork.
  a little
  more zoom   — the corners are thrown away by that crop, so the mark can sit
                larger in the square than it does in a favicon and still keep
                the same visual margin once it is round.

Everything drawn comes from web/public/brand/copycat-dark.png, which is the
same artwork the site header uses — including the sparkle, so the avatar and
the header mark cannot drift apart.

    python3 brand/gen-x-avatar.py

out/x-avatar-400.png is the file to upload; the 1024 is there for anywhere
that resamples it itself, and out/x-avatar-preview.png is the circle crop as
X will actually draw it.
"""

import numpy as np
from PIL import Image, ImageDraw

from palette import OUT, WEB

S = 2048

PAPER = (250, 250, 248)
# The two washes, sampled off the tab icon at the corner they peak in.
WASH_TL = (222, 249, 237)
WASH_BR = (241, 220, 246)
# Where a wash starts fading and where it is gone, as a fraction of the side.
WASH_NEAR, WASH_FAR, WASH_FALLOFF = 0.10, 0.44, 1.3

# The mark fills 0.90 of the square. Below this the cat reads as a sticker on a
# field; above it the whiskers start grazing the circle.
FILL = 0.90


def _ground(size=S):
    """Paper, with the wash bleeding out of the top-left and bottom-right."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32) / size
    field = np.empty((size, size, 3), np.float32)
    field[:] = PAPER

    for (cx, cy), wash in (((0.0, 0.0), WASH_TL), ((1.0, 1.0), WASH_BR)):
        d = np.hypot(x - cx, y - cy)
        t = np.clip((WASH_FAR - d) / (WASH_FAR - WASH_NEAR), 0, 1) ** WASH_FALLOFF
        field += t[:, :, None] * (np.float32(wash) - field)

    return Image.fromarray(field.round().astype(np.uint8), "RGB").convert("RGBA")


def _disc(im):
    """The upload as X shows it: cropped to the inscribed circle."""
    size = im.width
    mask = Image.new("L", (size * 2, size * 2), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size * 2 - 1, size * 2 - 1], fill=255)
    out = im.convert("RGBA")
    out.putalpha(mask.resize((size, size), Image.LANCZOS))
    return out


def build(mark=None):
    mark = mark or WEB / "public/brand/copycat-dark.png"
    art = Image.open(mark).convert("RGBA").resize((round(S * FILL),) * 2, Image.LANCZOS)

    canvas = _ground()
    canvas.alpha_composite(art, ((S - art.width) // 2,) * 2)
    canvas = canvas.convert("RGB")

    OUT.mkdir(exist_ok=True)
    paths = []
    for name, size in (("x-avatar", 1024), ("x-avatar-400", 400)):
        path = OUT / f"{name}.png"
        canvas.resize((size, size), Image.LANCZOS).save(path)
        paths.append(path)

    preview = OUT / "x-avatar-preview.png"
    _disc(canvas.resize((512, 512), Image.LANCZOS)).save(preview)
    paths.append(preview)
    return paths


if __name__ == "__main__":
    for p in build():
        print(p)
