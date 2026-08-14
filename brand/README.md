# brand/

Everything the product wears where it isn't the site: the browser tab, the X
profile, the share card. All of it is generated from `web/src/app/globals.css`'s
colour tokens and the site's own faces, so the tab, the timeline and the
landing page stay one thing rather than three.

## It costs the site nothing

This sits beside `web/`, not inside it. Nothing here is imported by the app,
nothing is served, and no asset is in `web/public/` — so it has never been
able to affect page weight or runtime.

The one real cost was deploys. The Vercel project's Root Directory is `.`, so
a deploy uploads this whole repo rather than just `web/` — which would have
meant shipping ~25 MB of generated PNGs and reference images to every build
for no reason. `.vercelignore` at the repo root excludes `brand/`, so it never
leaves your machine.

If you point the Vercel project's Root Directory at `web/` later, this stays
excluded for the simpler reason that it isn't in there.

It is a workshop that writes files. Run it when you want new assets; ignore it
otherwise.

```
brand/
  typography.py           set type in Instrument Serif / JetBrains Mono, as SVG paths
  palette.py              the globals.css tokens, plus the SVG → PNG step
  fonts/                  vendored woff2 — see "Why the fonts are copied in"
  sources/                the reference images the photographic icons are cut from
  gen-x-banner.py         out/x-banner*.png — the profile header, rendered at 2x
  gen-icons.py            out/icon-*.png — drawn marks on the gradient tile
  gen-icon-cutouts.py     out/badge-*.png, out/cutout-*.png — the sources, cut out
  gen-contact-sheet.py    out/contact-sheet.png — every icon at 16, 32 and 64 px
  gen-profile-preview.py  out/profile-preview.png — banner and avatar composited
  copy.md                 bio, profile fields, pinned post
  out/                    generated; safe to delete and rebuild
```

Two cuts of the header come out of `gen-x-banner.py`: `x-banner.png` sets the
first line roman and the second italic, the way the site's hero does;
`x-banner-italic.png` sets both italic and leans them a further 5°. Both are
written at 3000x1000 — X downsamples to fit, and arriving from twice the size
is what stops the serif's hairlines and the halftone dots crawling on a
retina screen. Icons follow the same rule: 512 is the favicon master, `-800`
is the avatar X downsamples to the 400 it shows.

## Running it

Needs `rsvg-convert` for rasterising and four Python packages:

```sh
brew install librsvg
python3 -m venv brand/.venv
brand/.venv/bin/pip install -r brand/requirements.txt
```

Then, from the repo root:

```sh
brand/.venv/bin/python brand/gen-x-banner.py
brand/.venv/bin/python brand/gen-icons.py
brand/.venv/bin/python brand/gen-icon-cutouts.py
brand/.venv/bin/python brand/gen-contact-sheet.py icon-orb badge-rimbust-brand
```

Every generator writes both an `.svg` and a `.png` where it can, so an asset
can be re-cut at any size without going soft. The cutout script is pixel work
and writes PNG only.

## Judge icons on the contact sheet, not the 512

Each icon renders beautifully at 512 pixels. That fact is worthless — a
favicon is 16, and a browser gets there by resampling. `gen-contact-sheet.py`
puts each candidate beside its own 16 / 32 / 64 px renders, blown back up so
the damage is visible and at true size underneath. Two rules came out of it:

- **A high-contrast serif needs thickening.** Instrument Serif's hairlines
  disappear entirely at 16 px, so `gen-icons.py` strokes the letter in its own
  fill colour before shrinking.
- **A photograph needs a containing shape.** Keying a figure's background out
  and setting it loose on the tile reads as noise once small; the same figure
  circle-cropped and ringed still reads, because the disc gives the eye one
  shape to hold. That ring is also what the token art already wears.

## Applying an icon

`web/src/app/icon.png` is the favicon and the `apple-touch-icon` — Next picks
it up from the filename, no config. The `-800` variants are the ones to upload
as the X avatar. The banner is a manual upload at `x.com/settings/profile`.

```sh
cp brand/out/<pick>.png web/src/app/icon.png
```

`web/public/og.png` is the 1200x630 share card and is still the hand-made original
— `gen-x-banner.py` is that composition re-cut for a 3:1 strip, not a
replacement for it.

## Why the fonts are copied in

`next/font` caches Instrument Serif and JetBrains Mono under `.next` with
content-hashed filenames that change on every build, and the subset it
downloads for a given page may be missing glyphs the generators need — the
first pass at this failed on a full stop. `fonts/` holds the full-charset
subsets, so the kit renders without a build and without installing anything
system-wide.

## Where the X banner's layout comes from

Parts of an X header are not yours, and **desktop and mobile take different
parts** — a layout that survives one can still fail the other. Both numbers
below were measured off live profile screenshots, because the published
guidance understates the first and does not mention the second.

**Desktop takes the bottom-left.** The avatar disc lands at x 50–392 and
starts at y 330 of the 1500x500 frame, running off the bottom edge. A first
pass followed the usual safe-area advice and put "not the market." directly
behind the picture. So the headline now finishes entirely above y 310 and the
bottom-left corner is given up on purpose.

**Mobile takes the sides.** A phone keeps the header's full height and crops
its width — roughly 130–142 px off each edge. On a screenshot the wordmark
read "topilot.", with the "Au" gone, and the sixth coin was sliced down the
middle. Two independent reads, one number. `MARGIN` is therefore 180, not the
90 that looked generous on a laptop, and the coin row is five wide rather than
six because that is what is left.

`gen-profile-preview.py` draws both views — desktop with the disc punched into
it, mobile cropped with the avatar below — from any banner and avatar pair.
Run it before uploading; a header only fails once it is published, which is a
slow way to find out.

```sh
brand/.venv/bin/python brand/gen-profile-preview.py x-banner-italic badge-crystal-brand
```

`out/x-banner-preview.png` is the same information as a map: red is what each
device takes back, the dashed teal rules are `MARGIN`.

The icons default to the `soft` ground, which is the banner's own pastel wash
and dot grid rather than the gradient at full strength. That is deliberate:
the avatar sits *on* the header, so sharing its material makes the two read as
one surface instead of two designs that happen to share a hue. `gen-icons.py`
still offers the saturated tile, which is louder in a tab strip but fights
anything photographic laid over it.

## The pitch pages

Both rounds of this were written up as pages, with the reasoning behind each
choice and the icons shown inside a mock tab strip:

- Round one, letterforms and the first banners —
  <https://claude.ai/code/artifact/244add3d-9e0a-4148-a0d3-544e16168a7d>
- Round two, the share-card banner and the photographic icons —
  <https://claude.ai/code/artifact/7b1679f6-477e-4881-99b7-7bc2a0c10758>
- Everything currently in `out/`, including how it lands on a live profile —
  <https://claude.ai/code/artifact/b62797fa-68f8-48a5-98e9-1c8390fb0b77>
