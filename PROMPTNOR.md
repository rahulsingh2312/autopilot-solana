# Autopilot on Solana: Build Prompt

Filled-in master prompt for this project. The generic template lives elsewhere;
this file is the real brief.

**Working title: Autopilot.** Pick a distinct name before launch.
`joinautopilot.com` is a real company and shipping a financial product under
their name invites a takedown, not just a trademark letter. Everything below
uses "Autopilot" as a placeholder: change it in one place (`lib/config.ts`).

---

## 0. Install these skills first

```bash
# Impeccable: design, critique, polish, animation commands
npx impeccable install

# Emil Kowalski's design & animation skills
npx skills.sh add emilkowalski/skills

# Animate skill: Next.js/React animation patterns
npx skills add https://github.com/delphi-ai/animate-skill --skill animate
```

Use them in this order:

1. `/impeccable init` once in the project.
2. `brand-design` before any UI exists: writes `brand.md` + shadcn CSS vars.
3. `scaffold-project` then `build-defi-protocol` for the vault program.
4. `frontend-design-guidelines` while writing components (reads `brand.md`).
5. `emil-design-eng` / `apple-design` for the polish pass.
6. `animate` + `find-animation-opportunities`, then `review-animations`.
7. `/impeccable audit` + `/impeccable polish`.
8. `cso` and `review-and-iterate` before mainnet. `deploy-to-mainnet` to ship.
9. `product-review` (or `roast-my-product`) on the finished site.

## 1. The prompt

> Build a Next.js (App Router, TypeScript, Tailwind, shadcn/ui) site for
> **Autopilot**: copy-trade famous investors on Solana, as a single token.
>
> You deposit SOL into a tracker and receive one token representing your share
> of that strategy. `mbtSOL` is the Michael Burry Tracker. `icSOL` is the
> Inverse Cramer Index. The protocol takes your SOL, swaps it into the
> tokenized equities that make up the strategy, and holds them in a vault.
> Burn your tracker token whenever you want and redeem for either SOL or your
> pro-rata slice of the underlying tokenized stocks.
>
> Longer term, anyone can launch their own index: pick the tokenized stocks
> and weights, deploy a vault, get a ticker. The creator's basket stays in
> their vault, and buyers mint and redeem against it exactly like the official
> trackers. **Not at launch.** V1 ships a small curated set of first-party
> trackers; creator-launched indexes come later.
>
> Audience: crypto natives who want equity exposure without leaving their
> wallet, plus retail traders who follow 13F and finance-Twitter strategies.
>
> The core promise: **one token, one click, one strategy. No brokerage
> account, no KYC broker, no market hours, redeem to SOL any time.**
>
> Visual direction: **[PICK ONE WORLD AND COMMIT, e.g. Bloomberg-terminal
> maximalism / 1980s annual-report print / trading-floor tape and ticker /
> editorial finance magazine / vintage brokerage stationery]**. Every element
> lives inside that world. See §6: take the *structure* from Autopilot, take
> the *character* from somewhere with a point of view. Do not build a white
> fintech landing page with a wallet button bolted on.
>
> Two rules that don't bend: the numbers stay sober and legible no matter how
> loud the world is, and a visitor understands "buy a famous investor's
> portfolio as a token" in 5 seconds without reading a paragraph.

## 2. Site anatomy

### 1. Hero: what is this

Headline states the mechanic, not a mood. Something like "Michael Burry's
portfolio. One token." Subhead spells out the loop in a sentence. Primary CTA
is `Connect wallet`, secondary is `See how it works`.

The hero visual is the product itself, not a stock illustration: a tracker
card, a live balance, a redeem screen. Whether that's phones, a desktop
terminal, a stack of printed statements, or something else is a call for your
chosen visual world to make. Whatever the frame, build the contents as real
React components so they stay live and animate, not as exported PNGs.

### 2. The trackers (this is the heart of the site)

A tracker card is the atomic unit of the whole product. It carries:

- A face. Full-bleed portrait, treated to fit the visual world, each tracker
  on its own distinct color
- Tracker name + token ticker (`Michael Burry Tracker` / `mbtSOL`)
- `by Autopilot` byline with verified badge
- Stat row: **NAV per token**, **Total value locked**, **Rebalance cadence**,
  **Filing delay** (13F data is up to 45 days stale: say so, don't bury it)
- About: two or three sentences of real explanation in the strategy's voice
- Current holdings: actual tokenized tickers with weights
- One full-width buy button, unmissable, `Buy mbtSOL`

That's the information order, and it's the one thing worth taking wholesale
from Autopilot. How it *looks* is your visual world's problem: this list works
as a glossy app card, a printed fund factsheet, or a terminal readout.

Ship at least these, each with genuinely different copy and color:

| Tracker | Ticker | What it holds |
| --- | --- | --- |
| Michael Burry Tracker | `mbtSOL` | Scion's disclosed longs, tokenized subset |
| Inverse Cramer Index | `icSOL` | Short/underweight what he pumps, long what he pans |
| Congress Tracker | `cgSOL` | Aggregated congressional disclosures |
| Buffett Tracker | `bwSOL` | Berkshire's top disclosed positions |

Below the fold, a `Featured` grid of tracker cards in the reference's exact
rhythm. Unlaunched trackers get a real `Coming soon` state, never a dead link.

**Ship two or three, not four.** A curated shelf where every card has real
copy, real holdings, and a real vault beats a wall of half-filled cards.
`mbtSOL` and `icSOL` are enough to prove the thesis.

### 2b. Launch your own index (nav item now, product later)

The end state is a creator marketplace: pick tokenized stocks and weights,
name it, deploy a vault, get a ticker, earn a cut of the fees on your index.
The reference site puts `Launch a Portfolio` in its nav next to the primary
CTA, and that's the right placement.

For v1, put the nav item there and have it lead to a real page that says what
it will be and takes an email or wallet for early access. An honest waitlist
page is a fine destination. A `#` link is not.

When it does ship, the site needs: a creator flow (search tokenized tickers,
set weights to 100%, preview, deploy), a creator profile with a `by @handle`
byline replacing `by Autopilot`, and a clear visual distinction between
first-party trackers and community indexes. Anything a stranger can deploy
needs different trust affordances than something you curated: show the
creator, the vault age, the TVL, and whether the basket has ever changed.
Design that difference into the card now so it isn't a retrofit later.

### 3. How it works

Four steps, each with a real visual:

1. Deposit SOL into a tracker vault
2. The vault swaps into the tokenized equities behind that strategy
3. You hold one token, `mbtSOL`, that tracks the whole basket
4. Redeem any time: burn for SOL, or take delivery of the underlying stocks

Then the mechanics nobody else will explain properly, in plain language:

- **NAV and minting.** How the mint price is derived from vault holdings.
- **Rebalancing.** What triggers it, who pays for it, what the fee is.
- **The tokenized-stock layer.** Name the issuer you actually use (xStocks by
  Backed, Ondo Global Markets, or whatever you integrate). You hold a claim on
  a tokenized share, not the share itself. State that.
- **Coverage gaps.** Not every 13F position has a tokenized equivalent yet. Say
  which names you can hold, and how the missing weight is handled (cash/USDC,
  or redistributed). Hiding this is the fastest way to lose credibility.
- **Redemption reality.** Tokenized-equity liquidity is thinner when US markets
  are closed. Show expected slippage before the user signs, not after.

### 4. Proof

You have no testimonials and no track record. Don't invent either. What you do
have is on-chain, and that's stronger:

- Live TVL, live NAV, live holdings pulled from the vault
- Program ID and vault addresses, linked to Solscan
- Audit status, honestly: "unaudited, devnet only" is a legitimate state
- Open-source repo link

If you show any performance chart, it must be real vault history or a clearly
labeled backtest. The reference site itself stamps "Numbers for illustrative
purposes only. Not actual performance data." on its mockups. Copy that habit.

### 5. Start

Connect wallet, pick a tracker, enter a SOL amount, review the quote (tokens
out, price impact, fee), sign. Repeat the primary CTA at the page bottom.

### Always

- Footer with real legal surface: terms, privacy, risk disclosure, contact
- A permanent, plain-language disclosure block: this is not an ETF, not a
  registered fund, not investment advice; the protocol is not affiliated with
  Michael Burry, Jim Cramer, or any tracked person; token holders have no
  shareholder rights, no voting, no dividends unless you actually pass them
  through; geographic restrictions if any
- OG/Twitter meta with a real tracker card image; proper favicon, verified in
  the tab
- Microcopy in the product's voice everywhere: empty wallet, wrong network,
  insufficient SOL, transaction rejected, RPC timeout

## 3. Copywriting rules (non-negotiable)

- **Write like a person.** Contractions, short sentences, concrete images
  ("your SOL becomes 14 tokenized stocks and one token in your wallet"). If a
  sentence could open any SaaS landing page, rewrite it. Banned: seamlessly,
  empower, unlock, revolutionize, cutting-edge, leverage, democratize.
- **Opinionated in voice, sober in numbers.** An Inverse Cramer index is
  inherently funny and the copy should know it. Have a point of view, write in
  the strategy's voice, let the trackers roast each other. But the moment a
  real number appears (NAV, TVL, holdings, fees, slippage) the tone goes flat
  and factual. No "wagmi", no rocket emoji, no "ape in": the joke is the
  strategy, never the money.
- **Claims must be true.** No fake TVL, no invented users, no "audited by" you
  didn't pay for, no APY. Vague-but-true beats specific-and-fabricated.
- **Verify the premises.** Before writing tracker copy, check the strategy
  still has a live data source. Burry's Scion deregistered with the SEC, so
  13F filings may have stopped: confirm the current state and, if there's no
  fresh filing, say what the tracker actually follows instead.
- **No AI em dashes.** The "—" is the biggest AI-writing tell. Ban it from
  headlines, body, tooltips, metadata, alt text. Use a period, comma, colon,
  or parentheses. Grep for `—` before shipping and drive it to zero.

## 4. Craft rules

- Real content everywhere: no lorem, no fake buttons, no placeholder holdings
- Every state exists: wallet disconnected, wrong network, loading NAV, empty
  position, pending transaction, confirmed, failed with a real reason
- Numbers animate on mount (count-up), never on every re-render. Money is
  right-aligned, tabular-figures, and never jitters in width as it updates
- Motion: one orchestrated hero entrance, hover lift on tracker cards, the
  buy sheet slides with a spring not a fade. `prefers-reduced-motion` path for
  all of it
- Responsive: the tracker card is designed mobile-first, since it's a phone UI
  in the mockups anyway. Don't shrink the desktop layout
- Semantic HTML: one `h1`, aria-labels on icon-only buttons, keyboard
  reachable, visible focus. A buy flow that needs a mouse is broken
- Body text ≥ 4.5:1; the saturated tracker backgrounds must still pass with
  white overlay text
- No generic-AI tells: no gradient text, no glassmorphism, no three identical
  feature cards, no purple-blue hero gradient, no tiny uppercase eyebrows
- Performance: `next/image` for portraits, `next/font` self-hosted, no layout
  shift when live numbers land, LCP under 2.5s on mid-range mobile
- `npm run build` passes clean; screenshot desktop AND mobile and look at them

## 5. Technical shape

- **Frontend**: Next.js App Router, TypeScript, Tailwind, shadcn/ui
- **Wallet**: `@solana/wallet-adapter`, plus an embedded-wallet option (Privy
  or similar) so a first-timer can start without installing anything
- **Program**: Anchor vault. Mint/burn a tracker SPL token against a basket.
  Deposit, redeem-for-SOL, redeem-in-kind, rebalance are the four instructions.
  Write it as one generic vault program parameterized by basket config, not as
  a hardcoded mbtSOL program. Same code path serves the curated trackers now
  and creator-launched indexes later: only the deploy permission changes
- **Swaps**: Jupiter for SOL to tokenized-equity routing
- **RPC/data**: Helius or Triton. Never ship a public mainnet-beta endpoint
- **Config**: every address, ticker, RPC URL, fee, and social link in ONE
  `lib/config.ts`. Launch day should be a one-line edit
- **Devnet first.** The site should work end to end on devnet with a network
  badge visible, before a single mainnet dollar moves

Phase it, and don't build ahead:

1. Marketing site, two or three curated trackers, live read-only vault data,
   `Launch a Portfolio` as a waitlist page
2. Buy and redeem flow on devnet, then mainnet
3. Portfolio view: your positions, cost basis, redeem-in-kind
4. Creator-launched indexes: the deploy flow, creator profiles, fee split,
   and the trust surface that separates community indexes from first-party

## 6. Reference sites (steal the energy, not the code)

**Structure**, how a strategy is packaged and sold:

| Site | What to take |
| --- | --- |
| https://www.joinautopilot.com/landing | Card anatomy and information order only. Do NOT clone it |
| https://stripe.com/ | Dense financial information made calm |
| https://linear.app/ | Motion, type, restraint |

**Character**, the part that makes it ours and not a fintech template:

| Site | What to take |
| --- | --- |
| https://peterpan.capital/ | Total commitment to a theme. Every element lives in one world |
| https://sherwood.chat/ | Explaining a mechanic cleanly without going corporate |
| https://www.microsoftrover.xyz/ | A metaphor carried all the way through, apps and all |
| https://siri-ai.xyz/ | Character-forward, the personality IS the layout |
| https://www.hoodcoin.cash/ | Meme energy with a simple, legible anatomy |
| https://tronpulse.vercel.app/ | Crypto-native market UI that still reads clean |
| https://www.nox.ventures/ | High-craft studio motion bar |
| https://codefronts.com/design-styles/ | Style templates to raid for a distinct visual world |

**How to use these.** Autopilot solved the *information architecture*: what a
tracker card holds, what order the page answers questions in. Take that and
nothing else. It's a white-canvas fintech app and copying its look gives us a
generic clone of a product we're not.

The character sites are where the design actually comes from. Every one of
them commits fully to a single world, and that commitment is the ideology
here: pick one visual world and put every element inside it. A Michael Burry
tracker and an Inverse Cramer index have real personality to work with, so the
site should feel like *something*, not like a Stripe page with a wallet button
bolted on.

Pick ONE character reference as the north star before writing code and say out
loud what you're taking: its rhythm? its density? its motion? Then let
Autopilot inform only the card structure underneath. Sober about the numbers,
opinionated about everything else. Mixing three character references is how
sites end up looking generic.

## 7. Assets

- **Portraits**: real photos of Burry, Cramer, whoever the tracker follows.
  This is an MVP, so grab the best available image and move on. Editorial
  crop, high contrast, treated to fit the visual world. Get them at ≥800px and
  verify the real dimensions, a soft 300px thumbnail wrecks the card. (Swap to
  licensed or illustrated versions if this ever becomes a real launch.)
- Ticker logos: pull from a real source, don't hand-draw brand marks
- Icons: one set (Lucide or Phosphor). No mixing, no emoji
- Fonts: two families max, self-hosted via `next/font`. A confident grotesk
  for numbers and headlines, a boring workhorse for body
- Verify every image resolves and check real dimensions
  (`sips -g pixelWidth file.png`) before shipping
