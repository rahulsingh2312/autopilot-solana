"""Set type in the site's own faces without installing them.

next/font caches Instrument Serif and JetBrains Mono under .next with hashed
filenames that change on every build, so the kit keeps its own copies in
fonts/ and reads glyph outlines straight out of them. Text comes back as SVG
path data, which means every asset here is resolution-independent and needs
no font on the rendering machine.
"""

import pathlib

from fontTools.misc.transform import Transform
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONTS = pathlib.Path(__file__).resolve().parent / "fonts"


class Face:
    """One font file, able to hand back a path for any string."""

    def __init__(self, filename):
        self.font = TTFont(FONTS / filename)
        self.upem = self.font["head"].unitsPerEm
        self.glyphset = self.font.getGlyphSet()
        self.cmap = self.font.getBestCmap()
        self.hmtx = self.font["hmtx"]
        try:
            self.kern = self.font["kern"].kernTables[0].kernTable
        except Exception:
            self.kern = {}

    def _names(self, text):
        missing = {c for c in text if ord(c) not in self.cmap}
        if missing:
            raise KeyError(f"font is missing {sorted(missing)}")
        return [self.cmap[ord(c)] for c in text]

    def _walk(self, text, size, tracking, draw):
        """Advance through the string, kerning as we go, handing each glyph a
        transform. y grows downward in SVG, hence the flipped scale."""
        scale = size / self.upem
        cursor = 0.0
        names = self._names(text)
        for i, name in enumerate(names):
            draw(name, cursor * scale, scale)
            cursor += self.hmtx[name][0]
            if i + 1 < len(names):
                cursor += self.kern.get((name, names[i + 1]), 0)
            cursor += tracking * self.upem
        return cursor * scale

    def path(self, text, size, x=0.0, y=0.0, tracking=0.0):
        """SVG path data for `text` with its baseline at (x, y), plus the
        advance width."""
        parts = []

        def draw(name, dx, scale):
            pen = SVGPathPen(self.glyphset)
            self.glyphset[name].draw(
                TransformPen(pen, Transform(scale, 0, 0, -scale, x + dx, y))
            )
            if d := pen.getCommands():
                parts.append(d)

        width = self._walk(text, size, tracking, draw)
        return " ".join(parts), width

    def width(self, text, size, tracking=0.0):
        return self._walk(text, size, tracking, lambda *_: None)

    def bounds(self, text, size, tracking=0.0):
        """Inked bounds relative to a baseline at the origin: (x0, y0, x1, y1),
        y downward. Use this to centre on the marks rather than the metrics —
        a line of type sits optically low when centred by its em box."""
        pen = BoundsPen(self.glyphset)
        self._walk(
            text,
            size,
            tracking,
            lambda name, dx, scale: self.glyphset[name].draw(
                TransformPen(pen, Transform(scale, 0, 0, -scale, dx, 0))
            ),
        )
        return pen.bounds


serif = Face("instrument-serif.woff2")
italic = Face("instrument-serif-italic.woff2")
mono = Face("jetbrains-mono.woff2")
