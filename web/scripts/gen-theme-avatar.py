#!/usr/bin/env python3
"""Draws avatar sources for trackers that are themes rather than people.

Every other tracker starts from a hand-framed headshot in public/avatars, which
gen-token-art.py then halftones and rings with the Solana gradient. A theme has
no face, and borrowing a photograph off the web for one would put an unlicensed
image on a token that lives in people's wallets forever.

So the source is drawn instead: a single bold glyph on white, sized and
weighted to survive being reduced to a five-pixel dot grid. The output lands in
public/avatars/<ticker>.png and is deliberately just another input — the dots
and the gradient ring still come from gen-token-art.py, so a theme token is the
same object as a portrait token rather than a second visual language.

    python3 scripts/gen-theme-avatar.py && python3 scripts/gen-token-art.py
"""

import pathlib
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("Pillow is required:  python3 -m pip install Pillow")

ROOT = pathlib.Path(__file__).resolve().parent.parent
SIZE = 1024

# Per theme, either a glyph to typeset or a shape to draw.
#
# Shapes are drawn rather than typed because a font that lacks the character
# silently renders a tofu box, and the first pass shipped a hollow rectangle
# where a diamond was meant to be. A glyph is only used where it is certainly
# present — digits and Latin letters — and anything else is geometry.
THEMES = {
    "mg7sol": {"glyph": "7"},
    "aisol": {"shape": "chip"},
}

# Candidate faces, heaviest first. A thin face vanishes when sampled at one
# pixel per dot cell; the mark has to be mostly ink to survive.
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/System/Library/Fonts/Supplemental/Impact.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if pathlib.Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


INK = (10, 10, 10)


def draw_chip(canvas):
    """A processor: solid die, pins on all four sides.

    Sized generously because the halftone samples one pixel per dot cell — a
    delicate outline disappears entirely at that resolution, so every element
    here is a filled mass at least a few cells thick.
    """
    c = SIZE / 2
    die = SIZE * 0.30           # half-width of the body
    pin_len = SIZE * 0.085
    pin_w = SIZE * 0.045
    gap = SIZE * 0.105          # spacing between pin centres

    canvas.rounded_rectangle(
        [c - die, c - die, c + die, c + die], radius=SIZE * 0.05, fill=INK
    )
    # Window in the die, so the mark is not one undifferentiated square.
    inner = die * 0.42
    canvas.rounded_rectangle(
        [c - inner, c - inner, c + inner, c + inner],
        radius=SIZE * 0.02, fill=(255, 255, 255),
    )

    for i in (-1, 0, 1):
        offset = i * gap
        # left / right
        canvas.rectangle([c - die - pin_len, c + offset - pin_w / 2,
                          c - die, c + offset + pin_w / 2], fill=INK)
        canvas.rectangle([c + die, c + offset - pin_w / 2,
                          c + die + pin_len, c + offset + pin_w / 2], fill=INK)
        # top / bottom
        canvas.rectangle([c + offset - pin_w / 2, c - die - pin_len,
                          c + offset + pin_w / 2, c - die], fill=INK)
        canvas.rectangle([c + offset - pin_w / 2, c + die,
                          c + offset + pin_w / 2, c + die + pin_len], fill=INK)


SHAPES = {"chip": draw_chip}


def draw(spec):
    # White ground, black ink: gen-token-art inverts luminance, so dark pixels
    # become the big dots.
    image = Image.new("RGB", (SIZE, SIZE), "white")
    canvas = ImageDraw.Draw(image)

    if "shape" in spec:
        SHAPES[spec["shape"]](canvas)
        return image

    glyph = spec["glyph"]
    font = load_font(int(SIZE * 0.62))
    box = canvas.textbbox((0, 0), glyph, font=font)
    # A missing glyph typesets as a tofu box of roughly square proportions and
    # no interior; refusing is better than shipping one to a wallet.
    if box[2] - box[0] < SIZE * 0.05 or box[3] - box[1] < SIZE * 0.05:
        sys.exit(f"glyph {glyph!r} did not render; pick another or draw a shape")

    canvas.text(
        ((SIZE - (box[2] - box[0])) / 2 - box[0],
         (SIZE - (box[3] - box[1])) / 2 - box[1]),
        glyph,
        font=font,
        fill=INK,
    )
    return image


def main():
    out = ROOT / "public" / "avatars"
    out.mkdir(parents=True, exist_ok=True)
    for slug, spec in THEMES.items():
        draw(spec).save(out / f"{slug}.png", "PNG", optimize=True)
        what = spec.get("glyph") or f"{spec['shape']} shape"
        print(f"  {slug:8} {what!r:14} -> avatars/{slug}.png")


if __name__ == "__main__":
    main()
