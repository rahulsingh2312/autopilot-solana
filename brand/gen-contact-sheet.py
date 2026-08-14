#!/usr/bin/env python3
"""Builds out/contact-sheet.png so icons get judged at the size they ship at.

Every icon here looks good at 512. That tells you nothing. This puts each one
next to its own 16, 32 and 64 pixel render — both blown back up with
nearest-neighbour so the damage is visible, and at true size underneath.

    python3 brand/gen-contact-sheet.py icon-orb badge-rimbust-brand ...
    python3 brand/gen-contact-sheet.py            # everything in out/
"""

import sys

from PIL import Image

from palette import OUT

CELL = 128
ROW = CELL + 44
SIZES = (16, 32, 64)


def sheet(names, out_name="contact-sheet"):
    rows = [n for n in names if (OUT / f"{n}.png").exists()]
    if not rows:
        sys.exit("nothing to lay out — run the gen-icon scripts first")

    width = 24 + (len(SIZES) + 1) * (CELL + 20)
    canvas = Image.new("RGB", (width, 24 + len(rows) * ROW), (239, 239, 236))

    for i, name in enumerate(rows):
        src = Image.open(OUT / f"{name}.png").convert("RGB")
        y = 20 + i * ROW
        canvas.paste(src.resize((CELL, CELL), Image.LANCZOS), (20, y))
        for j, px in enumerate(SIZES):
            small = src.resize((px, px), Image.LANCZOS)
            x = 20 + (j + 1) * (CELL + 20)
            canvas.paste(small.resize((CELL, CELL), Image.NEAREST), (x, y))
            canvas.paste(small, (x, y + CELL + 6))

    path = OUT / f"{out_name}.png"
    canvas.save(path)
    return path


if __name__ == "__main__":
    picks = sys.argv[1:] or sorted(
        p.stem for p in OUT.glob("*.png")
        if p.stem.startswith(("icon-", "badge-", "cutout-"))
        and not p.stem.endswith("-400")
    )
    print(sheet(picks))
