# Autopilot promo video — the recipe

Reusable prompt for making the next hype cut. Paste this (plus a reference video
and a screen recording) into a fresh Claude Code session and say "make one like
last time for <product>".

---

## The prompt

Make a fast-cut square promo video for my product, in the style of the cults.fun
launch video: nothing is ever static, huge type cards, real product footage,
hard cuts synced to a music track. Build it in Remotion so every cut is code I
can edit. Steal the audio from the reference video and re-time the whole edit to
its exact duration.

**Inputs I will give you:**
- A reference video (structure + energy + audio track to steal)
- A ScreenKite recording of the product (`.skbundle` — raw file lives at
  `media/raw/*.mp4` inside the bundle; grab it with ffmpeg, don't fight the MCP)
- The product repo (pull brand tokens from the site's CSS, never invent them)

**Format:** 1080×1080 @ 30fps, length = the audio track's length, hard cuts.

## Non-negotiable style rules (learned the hard way)

1. **Nothing static, ever.** Every scene needs at least two layers of motion:
   a slow camera push (`scale` over scene duration) plus per-element drift
   (sine-based bob), scrolling ticker rows on dark cards, tilting coins
   (`perspective + rotateY` oscillation), count-up numbers.
2. **Brand comes from the codebase.** Fonts, colors, gradients, portraits and
   token art are read out of the site repo. For Autopilot: paper `#fafaf8`,
   ink `#0a0a0a`, Instrument Serif (display, often italic), Inter 800 (punch
   caps), JetBrains Mono (labels/numerals), dot-grid + mint/pink radial washes.
3. **Use the pastel gradient, not the loud one.** The site's `.btn-grad`
   "mother-of-pearl" stops (`#b6f2d8 → #cfe6fb → #ded0fa → #f8cfe9`) for all
   accents: gradient text on black cards, coin rims, beams, URL chip. The vivid
   Solana gradient (`#00FFA3 → #DC1FFF`) appears ONLY inside the Solana logomark.
4. **Token art = the dotted halftone versions** (`web/public/tokens/*.png`),
   never the color avatars. B&W halftone is the vibe.
5. **Captions are serif italic, sentence case, no background** — website voice
   ("Every vault.", "The chain is the receipt."). No black pills under demos,
   no ALL-CAPS mono chips over content. Big headline over the token wall is
   serif italic ink with a soft paper haze, never a solid box.
6. **Never two black text cards back-to-back.** One punch card, then product
   footage, then the next punch card.
7. **Zooms must land on something.** Every screenshot/video zoom targets a
   specific UI element (a "You receive X" row, a +154% badge, a buy button —
   the reference's "Post button moment"). Measure the target's position as
   transform-origin percentages from a preview frame first. And content must
   NEVER leave the card frame: cap zoom so the panel stays fully inside
   (≤1.6× worked), keep tilts subtle (±3° not ±8°).
8. **Directionality tells the story.** Deposit: SOL left → token right. Burn:
   coins animate a crossing swap so the token is left → SOL right. Arrow always
   points the direction value flows.
9. **No em dashes in on-screen copy.**
10. **Real footage over screen-recording spam.** Short clips (2–4s each) at
    1.2× inside a browser-chrome card, cropped free of tabs/URL bar
    (`crop=iw:ih-250:0:250` on a 2940×1912 capture). Cut clips from the
    ScreenKite bundle's raw 60fps file with ffmpeg.

## Proven scene skeleton (~22.6s, 678 frames)

1. **Wall** (2s) — grid of halftone portraits/tokens, columns scrolling in
   alternating directions, cells tilting, camera pulls back; serif italic
   headline over a soft haze.
2. **Black punch card** (2.2s) — 3 lines Inter 800, last line pastel-gradient,
   scrolling face-ticker row at the bottom, camera push.
3. **Coin title** (2.2s) — dotted token coin tilting, zoom-out reveals the serif
   tagline around it.
4. **Demo beats** (3.8s) — real clips in browser cards: overview shot, then the
   buy flow zooming to the "You receive" row.
5. **Coin mutation** (3s) — SOL coin → dashed pastel beam → token coin; halfway,
   coins swap positions (arc animation) for the burn direction.
6. **Black punch card #2** (2s) — the trust mechanics line.
7. **PnL tilt + receipt** (2.8s) — backtest board with gentle 3D tilt zooming
   to the headline number; then the on-chain table clip.
8. **Serif tagline** (1.8s) — the brand line, lines drifting in parallax.
9. **Outro** (2.8s) — wordmark, bobbing portrait row, pastel URL chip, mono
   status line.

## Workflow

1. `ffprobe` the reference; extract frames (`fps=1`) and map its structure.
2. Extract its audio: `ffmpeg -i ref.mp4 -vn -c:a copy public/track.m4a`;
   set composition length = audio length; `<Audio>` at the root.
3. Survey the screen recording with 1-frame-per-N-seconds extracts; map the
   timeline; cut segments with ffmpeg (crop chrome, scale 1440, 30fps, -an).
4. Scaffold Remotion (pin remotion 4.0.246, TS 5.9, React 18) with
   `@remotion/google-fonts`. Render stills of every scene BEFORE the full
   render; check zoom landings against the actual frames.
5. Full render: `npx remotion render Promo out/promo.mp4 --codec h264 --crf 18
   --color-space bt709 --timeout 120000 --concurrency 4`.
6. Verify with a tiled contact sheet
   (`select='not(mod(n,75))',scale=270:270,tile=5x2`), copy to Desktop.

## Where things live

- Project: `Desktop/autopilot-solana/promo` (source of all of the above,
  final: `out/autopilot-promo-v8.mp4`)
- Reference audio: `promo/public/track.m4a`
- Halftone tokens: `promo/public/tokens/`, portraits: `promo/public/*.jpg`
- Demo clips: `promo/public/clips/` (vault, buy, receipt)
- ScreenKite: `screenkite tool call --name <tool> --project '<bundle>' --json`
  (always pass `--project`; raw video at `<bundle>/media/raw/`)
