# Autopilot brand — "OG Paper"

**Status:** active · chosen by the user 2026-08-09 after a two-round palette loop and a font loop.

One line: a white paper terminal where the only color is money in motion — the original
Solana logo gradient, always flowing, reserved for buttons and live balances.

## Palette

Light-first. Dark mode exists but light is the product's face.

### Seeds

| Role | Hex | Notes |
|---|---|---|
| bg-base | `#FFFFFF` | Pure white page |
| bg-paper | `#FAFAF8` | Section alt / cards-on-white |
| fg-base | `#0A0A0A` | Ink. Near-black, never gray for body |
| fg-muted | `#5C5B57` | Secondary text (AA on white) |
| fg-faint | `#8A8983` | Metadata, min 12px usage |
| border | `#E7E6E1` | Hairlines |
| **grad-a** | `#00FFA3` | OG Solana aqua-green (exact) |
| **grad-b** | `#DC1FFF` | OG Solana magenta (exact) |
| pos | `#0BA05F` | Gains (text-safe green on white) |
| neg | `#D2372C` | Losses |

### The gradient — the entire color story

- `--gradient-og: linear-gradient(93deg, #00FFA3, #DC1FFF)` — exact OG Solana logo stops.
- **Where it lives:** primary buttons, live balances/NAV/TVL numbers, the thin page rail,
  focus rings. Nowhere else. Headlines, icons, cards stay ink.
- **It always moves.** Buttons and balances animate `background-position` over a
  200%-wide gradient (`~5s linear infinite`). Respect `prefers-reduced-motion` (static).
- **Text-safe variant** for gradient text on white: `#00CC82 → #B316D9` (darkened same
  hues, keeps AA legibility). Buttons use the exact stops with near-black text
  (`#08110C`), which passes AA on both ends.

## Typography

Chosen: **pair 1 — Instrument Serif + Inter + JetBrains Mono** (all Google Fonts, wired
via `next/font/google`).

- **Display — Instrument Serif (400, + italic):** hero and section headlines only.
  Big, editorial, peterpan-style; italic for the emphasized phrase.
- **Body/UI — Inter:** everything interactive and explanatory.
- **Numbers — JetBrains Mono:** every balance, NAV, weight, address; always
  `tabular-nums`. Small letterspaced mono for metadata lines.

## Texture & imagery

- **Dot-grid paper:** subtle dot matrix over the white ground (instinctfi.com style),
  ~24px pitch, `#0A0A0A` at ~7% opacity. Gives the page a "graph paper terminal" feel.
- **Halftone portraits:** tracker subjects render as dithered dot-matrix portraits
  (canvas-generated from the source images), not raw photos. This is the signature
  visual and also the licensing solve — a stylized halftone, not a photograph.
- No stock photos, no 3D blobs, no glassmorphism.

## Voice

Confident, plain, a little wry. Short declaratives. Numbers do the bragging; the copy
states uncomfortable facts (frozen tracker, editorial picks, devnet) without apology
and without the previous self-deprecating bit. Never hype ("10x", "moon"), never
corporate ("leverage", "solutions").

## References (user-supplied)

- **instinctfi.com** — structure: hero + halftone portrait, dot grid, index cards with
  holdings and green % pills, 3-step walkthrough, FAQ. Direct competitor; out-craft it.
- **peterpan landing** — editorial serif display, letterspaced mono meta, one accent.
- **Marinade** — light friendliness, big rounded CTAs, playful footer wordmark.
- Rejected: the previous "airline/boarding pass" world (anti-reference); generic dark
  DeFi terminals.

## Dos & don'ts

- DO keep the gradient scarce: if more than buttons + live numbers + one rail carry it,
  it stops meaning "money in motion".
- DO use serif display sparingly — hero + section heads; UI stays Inter.
- DON'T put gradient on headlines or body text.
- DON'T introduce a third accent color; pos/neg greens/reds are semantic only.
- DON'T use raw photographs of tracked subjects — always the halftone treatment.
- DON'T use eyebrows/kicker labels above headings; headings carry their own weight.
