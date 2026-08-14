"""The tokens from src/app/globals.css, in a form the renderers can use.

Kept in one place so a colour change on the site is a one-line change here and
every asset re-renders to match.
"""

import pathlib
import subprocess

INK = "#0a0a0a"
PAPER = "#fafaf8"
MUTED = "#5c5b57"
FAINT = "#8a8983"

# --grad-a / --grad-b: the Solana logomark gradient, bottom-left to top-right.
GRAD_A = "#00ffa3"
GRAD_B = "#dc1fff"

# --grad-a-ink / --grad-b-ink: the same hues darkened enough to set text in.
GRAD_A_INK = "#00b374"
GRAD_B_INK = "#a812c4"

RGB_A = (0x00, 0xFF, 0xA3)
RGB_B = (0xDC, 0x1F, 0xFF)

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / "out"
SOURCES = ROOT / "sources"

# This kit sits beside the Next app rather than inside it, so nothing here is
# ever uploaded to a deployment. Anything it needs to read from the site is
# reached through here.
WEB = ROOT.parent / "web"


def tile_gradient(x1, y1, x2, y2, ident="tile", a=GRAD_A, b=GRAD_B):
    return (
        f'<linearGradient id="{ident}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
        f'gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/>'
        f"</linearGradient>"
    )


def write_svg(name, svg, width, height):
    """Save the SVG and rasterise it beside itself, so every asset ships in
    both a form you can edit and a form you can upload."""
    OUT.mkdir(exist_ok=True)
    svg_path = OUT / f"{name}.svg"
    svg_path.write_text(svg)
    subprocess.run(
        ["rsvg-convert", "-w", str(width), "-h", str(height), str(svg_path),
         "-o", str(OUT / f"{name}.png")],
        check=True,
    )
    return OUT / f"{name}.png"
