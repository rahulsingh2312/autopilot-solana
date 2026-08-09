#!/usr/bin/env python3
"""Regenerates public/tokens/<ticker>.png as dot-matrix halftone portraits.

The token mark a wallet shows should be the same object the site shows. The
site renders every portrait as ink dots (see src/components/ui/halftone.tsx),
so a glossy photo in the wallet was a second identity for the same asset.

Source is public/avatars/<ticker>.png, which are the original hand-framed
headshots. Deriving from those rather than re-cropping the full-bleed
portraits in public/portraits matters: those are red-carpet and stage shots
where the head can be a small patch near the top, and every attempt to find
it automatically produced somebody's shirt. The framing was already solved
once; this reuses it.

Mirrors halftone.tsx: sample at one pixel per dot cell, take luminance,
invert so dark areas get the big dots, radius = maxR * sqrt(strength). Drawn
at 4x and downsampled so the circles land smooth.

    python3 scripts/gen-token-art.py
"""

import json
import math
import pathlib
import subprocess
import sys

try:
    from PIL import Image, ImageDraw, ImageOps
except ImportError:
    sys.exit("Pillow is required:  python3 -m pip install Pillow")

ROOT = pathlib.Path(__file__).resolve().parent.parent

SIZE = 512          # final token image, square
PITCH = 5           # css px between dot centres, at SIZE
SUPERSAMPLE = 4     # draw big, shrink down: antialiasing for free
RING = 16           # gradient ring thickness at SIZE
# The source avatars carry a flat accent ring of about this thickness.
# Everything outside it is discarded so it cannot become dots.
SRC_RING = 20

# Most tokens derive from the hand-framed avatars. mbtSOL is the exception:
# its avatar frames Burry against the "THE BIG SHORT" backdrop panel, which
# halftones into a white slab across the disc. The raw red-carpet portrait
# cropped to these numbers reads better, so it wins.
#   ticker -> (portrait file, (centre x, centre y, zoom) in 0..1)
PORTRAIT_OVERRIDES = {
    "mbtSOL": ("burry.jpg", (0.48, 0.11, 0.42)),
}
INK = (10, 10, 10)

# The same pastel stops the primary button carries, so a token and the button
# that buys it are visibly the same family. Ordered as the button reads.
GRADIENT = [
    (0.00, (0xB6, 0xF2, 0xD8)),
    (0.17, (0xCF, 0xE6, 0xFB)),
    (0.34, (0xDE, 0xD0, 0xFA)),
    (0.50, (0xF8, 0xCF, 0xE9)),
    (0.66, (0xDE, 0xD0, 0xFA)),
    (0.83, (0xCF, 0xE6, 0xFB)),
    (1.00, (0xB6, 0xF2, 0xD8)),
]


def gradient_at(t):
    """Colour at 0..1 along the stop list."""
    for i in range(len(GRADIENT) - 1):
        p0, c0 = GRADIENT[i]
        p1, c1 = GRADIENT[i + 1]
        if p0 <= t <= p1:
            k = 0 if p1 == p0 else (t - p0) / (p1 - p0)
            return tuple(round(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
    return GRADIENT[-1][1]


def gradient_image(size):
    """A 100-degree linear sweep, matching .btn-grad's angle."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    # 100deg from vertical is close to left-to-right with a slight rise.
    dx, dy = math.cos(math.radians(-10)), math.sin(math.radians(-10))
    lo = min(0, size * dy)
    span = size * abs(dx) + size * abs(dy)
    for y in range(size):
        for x in range(size):
            t = ((x * dx + y * dy) - lo) / span
            px[x, y] = gradient_at(min(1, max(0, t)))
    return img


def manifest():
    """Ticker, portrait and accent straight out of config.ts."""
    script = (
        "const m = await import('./src/lib/config.ts');"
        "console.log(JSON.stringify(m.TRACKERS.map(t =>"
        "({ticker: t.ticker, portrait: t.portrait, accent: t.accent}))));"
    )
    out = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
        cwd=ROOT, capture_output=True, text=True,
    )
    line = next(
        (l for l in out.stdout.splitlines() if l.strip().startswith("[")), None
    )
    if not line:
        sys.exit(f"could not read config.ts:\n{out.stderr}")
    return json.loads(line)


def focus_crop(path, focus):
    """Square around a subject in a full-bleed portrait, per focus."""
    im = Image.open(path).convert("RGB")
    w, h = im.size
    cx, cy, zoom = focus
    side = int(min(w, h) * zoom)
    x = max(0, min(int(w * cx - side / 2), w - side))
    y = max(0, min(int(h * cy - side / 2), h - side))
    return im.crop((x, y, x + side, y + side)).resize((SIZE, SIZE), Image.LANCZOS)


def framed_disc(path):
    """The avatar's inner disc on white, scaled to fill a SIZE square."""
    im = Image.open(path).convert("RGBA")
    im = im.resize((SIZE, SIZE), Image.LANCZOS)

    flat = Image.new("RGB", (SIZE, SIZE), (255, 255, 255))
    flat.paste(im, (0, 0), im)

    inner = SIZE / 2 - SRC_RING
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).ellipse(
        (SIZE / 2 - inner, SIZE / 2 - inner, SIZE / 2 + inner, SIZE / 2 + inner),
        fill=255,
    )
    on_white = Image.new("RGB", (SIZE, SIZE), (255, 255, 255))
    on_white.paste(flat, (0, 0), mask)

    box = int(SIZE / 2 - inner)
    return on_white.crop((box, box, SIZE - box, SIZE - box)).resize(
        (SIZE, SIZE), Image.LANCZOS
    )


def halftone(source, focus=None):
    src = focus_crop(source, focus) if focus else framed_disc(source)

    cells = math.ceil(SIZE / PITCH)
    grid = src.resize((cells, cells), Image.LANCZOS)
    # Portraits are mostly mid-tones, and mid-tones all map to mid-sized dots,
    # which reads as texture rather than a face. Stretch the range first.
    grid = ImageOps.autocontrast(grid, cutoff=2)
    px = grid.load()

    big = SIZE * SUPERSAMPLE
    canvas = Image.new("RGBA", (big, big), (255, 255, 255, 255))
    draw = ImageDraw.Draw(canvas)

    step = PITCH * SUPERSAMPLE
    max_r = (PITCH / 2) * 0.92 * SUPERSAMPLE
    min_r = 0.35 * SUPERSAMPLE

    for gy in range(cells):
        for gx in range(cells):
            r, g, b = px[gx, gy]
            lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
            strength = 1 - lum          # invert: dark source, big dot
            if strength <= 0:
                continue
            radius = max_r * math.sqrt(strength)
            if radius < min_r:
                continue
            cx = (gx + 0.5) * step
            cy = (gy + 0.5) * step
            draw.ellipse(
                (cx - radius, cy - radius, cx + radius, cy + radius), fill=INK
            )

    # Clip the dot field to a disc, then ring it in the tracker's accent.
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big - 1, big - 1), fill=255)
    disc = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    disc.paste(canvas, (0, 0), mask)

    ring = RING * SUPERSAMPLE
    ring_mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(ring_mask).ellipse(
        (ring / 2, ring / 2, big - 1 - ring / 2, big - 1 - ring / 2),
        outline=255, width=ring,
    )
    disc.paste(gradient_image(big).convert("RGBA"), (0, 0), ring_mask)

    return disc.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    src_dir = ROOT / "public" / "avatars"
    out_dir = ROOT / "public" / "tokens"
    written = 0

    for tracker in manifest():
        ticker = tracker["ticker"]
        slug = ticker.lower()

        override = PORTRAIT_OVERRIDES.get(ticker)
        if override:
            name, focus = override
            source = ROOT / "public" / "portraits" / name
            label = f"portraits/{name}"
        else:
            source, focus = src_dir / f"{slug}.png", None
            label = f"avatars/{slug}.png"

        if not source.exists():
            print(f"  {ticker:8} missing {label}, skipped")
            continue

        art = halftone(source, focus)
        art.save(out_dir / f"{slug}.png", "PNG", optimize=True)
        written += 1
        print(f"  {ticker:8} {label:22} -> tokens/{slug}.png")

    print(f"\n{written} token images redrawn as dot matrices")


if __name__ == "__main__":
    main()
