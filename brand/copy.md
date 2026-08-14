# Profile copy

X allows 160 characters of bio, 50 of name, 30 of location, and one link.
Counts below are the real ones.

## Bio

**Plain — recommended.** Leads with the promise, then says exactly what you
get. The devnet line is doing real work: it stops anyone arriving expecting to
move real money.

> Trade the trader, not the market. One token tracks one famous investor's
> disclosed portfolio. Deposit SOL, burn back whenever. Live on Solana devnet.
>
> *150 characters*

**Names the names.** The names are the hook and the reason someone screenshots
the profile. Every one is public filing data, but pair this with the
disclaimer in the pinned post rather than leaving it nowhere.

> Famous portfolios, one token each — Buffett, Pelosi, Cramer, Congress.
> Deposit SOL, hold the tracker, burn it back. Non-custodial. Solana devnet.
>
> *146 characters*

**Builder voice.** For a personal account rather than a product one. Builders
follow builders, and early on that travels further.

> I turn 13F filings into one token you can hold. Anchor program + Next app,
> open source. Trade the trader, not the market. Solana devnet.
>
> *138 characters*

## Fields

| Field | Use | Why |
| --- | --- | --- |
| Name | `Autopilot` | The wordmark, nothing appended. The tagline goes in the bio, where it can be read. |
| Handle | `@autopilotsol` or `@tradethetrader` | First is searchable next to the product name; second is the line people repeat. |
| Location | `Solana · devnet` | Free honesty. Costs nothing, prevents the wrong expectation. |
| Website | `autopilot-solana.vercel.app` | Straight from `BRAND.domain` in `src/lib/config.ts`. |

## Pinned post

Opens on the fact rather than the pitch, and carries the disclaimer the
landing page already carries. The pin is where a curious visitor lands after
the bio, so it is the right place for the caveat.

> Buffett files a 13F. Pelosi files a disclosure. Congress files hundreds.
>
> Autopilot turns each one into a single token on Solana. Deposit SOL, hold
> bwSOL or pltSOL, burn it back whenever — no brokerage, no market hours, no
> custody.
>
> Live on devnet. Not an ETF, not advice, not affiliated with anyone a tracker
> follows.

## Source lines

Both of these are the site's, not new copy, and should stay in sync with it:

- Headline — `src/components/site/hero.tsx`: *Trade the trader, not the market.*
- Tagline — `BRAND.tagline`: *Famous portfolios, one token each.*
- Disclaimer — the hero's footnote: *Not an ETF. Not advice. Not affiliated
  with anyone a tracker follows.*
