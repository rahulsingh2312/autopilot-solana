# Autopilot — visual world: "OG Paper"

Replaces the retired "Autopilot Air" airline world (2026-08-09, user-directed rebrand).
Brand tokens, type, and rules live in [brand.md](brand.md); this file records how the
world is built into the product surfaces.

## The world in one sentence

A white graph-paper trading terminal, edited like a magazine: ink serif headlines,
halftone dot portraits of the people being tracked, and one moving thing on the page —
the original Solana gradient flowing through every button and live number.

## Committed decisions

- **Mode: Persuade** (homepage) — the visitor's success is a signed deposit.
- **Ground:** white + faint dot grid. Sections separated by hairlines, not background
  swaps; one `#FAFAF8` paper band allowed for contrast pacing.
- **Hero:** serif display headline with italic emphasis phrase; halftone portrait of a
  tracked subject on the right; gradient CTA; live TVL as flowing-gradient mono number.
- **Tracker cards:** Instinct-style list cards — halftone avatar, name, live NAV/TVL in
  mono, holdings as weight rows, caveat stated in plain ink. Expandable row pattern is
  kept from the incumbent build (it works), fully reskinned.
- **How-it-works:** three numbered steps (sequence is real information), vertical rule,
  live product fragments as illustrations — not icon cards.
- **Proof:** on-chain table read live, explorer links. No testimonials ever (product
  principle).
- **Motion:** the flowing gradient is the page's one authored motion moment; everything
  else is restrained (fade/rise on first paint, expand panels, count-ups). All motion
  respects `prefers-reduced-motion`.
- **Halftone portraits:** generated at runtime on canvas from `public/portraits/*` at
  display resolution; dot pitch ≈ 5–7px; pure ink dots on transparent ground.

## What survives from the old build

Behavioral skeleton only: expandable tracker rows, buy-sheet flow (deposit/redeem with
on-chain quotes), connect-button states, live SWR vault hooks, legal pages, waitlist.
All visual classes from the airline world (`pass`, `perf`, `barcode`, `led-rail`,
`sky-wash`, boarding-pass metaphors, orange accent) are deleted, not restyled.

## Never

- Dark-first anything on the marketing surface.
- The gradient outside buttons / live numbers / the page rail.
- Raw photographs of tracked subjects.
- Airline vocabulary ("boarding", "departures", "gate") anywhere in UI copy.
