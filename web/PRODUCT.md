# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Crypto-native retail traders on Solana ("degens" through to curious DeFi users). They hold SOL in a browser wallet, are comfortable signing transactions, and are drawn by the meme/curiosity of famous-investor portfolios. They will not open a brokerage account; they decide in one scroll whether to connect a wallet and buy.

## Product Purpose

Autopilot lets anyone deposit SOL and receive one SPL token that tracks a famous investor's disclosed portfolio (Michael Burry's final 13F, an "Inverse Cramer" editorial index, Congress STOCK-Act filings soon). Tokens are redeemable ("burnable") for SOL at any time. Success for the homepage is a connected wallet and a completed deposit — it is a live product surface, not a waitlist splash. The waitlist exists but is secondary.

## Positioning

One token per famous portfolio, on-chain, with every number read live from the Solana chain. No brokerage account, no market hours, redeemable any time. The mechanism a neighbor can't copy honestly: the vault program is deployed and verifiable (program `8cKany…CSNK`), holdings/weights come from disclosed public sources, and the product states its own limitations outright.

## Operating Context

- Solana devnet today; mainnet would route tokenized equities via xStocks (Backed Assets).
- Anchor program lives in `../anchor`; web app is Next.js 16 (App Router, Tailwind v4, @solana/kit + wallet-standard).
- All tracker data, addresses, fees, and copy live in `src/lib/config.ts` — single source of truth.
- Live on-chain reads via SWR hooks in `src/lib/vault/hooks.ts`; buy flow is `src/components/trackers/buy-sheet.tsx`.
- Three trackers: mbtSOL (frozen — source deregistered), icSOL (live), cgSOL (not deployed yet).

## Capabilities and Constraints

- Deposit SOL → mint tracker token; redeem for SOL or in-kind; max fee 300 bps enforced by program.
- mbtSOL will never rebalance (its source is gone) — this is a product fact the UI must state.
- Burry's book was ~80% put options which a long-only vault cannot hold; only the common-stock sleeve is tracked. Must not be hidden.
- icSOL constituents are editorial (picked by Autopilot), not a regulated index.
- cgSOL is not deployed; no vault, no token yet.
- Image licensing: only CC-licensed portraits for Cramer and the Capitol; no freely licensed Burry photo exists.
- Legal pages (terms/privacy/risk) exist and must remain reachable.

## Brand Commitments

Name: Autopilot (wordmark AUTOPILOT). Voice decision (2026-08-08): the previous ultra-blunt self-deprecating copy is NOT binding — user asked for a full copy rewrite alongside the visual redesign. Honesty about limitations stays (it's a legal/ethical requirement), but voice and framing are open. The previous "airline / boarding pass" visual world is explicitly rejected (user: hates the fonts and everything) — treat as anti-reference only.

## Evidence on Hand

- Deployed devnet program: `8cKanyTRdgbdf8eWiLpqzy3kwzsXWXNxQdd6NRauCSNK`; live vault stats readable on-chain.
- Real public sources: SEC 13F filings (Scion), STOCK Act disclosures, Mad Money coverage.
- Portraits: `public/portraits/cramer.jpg` (CC BY 2.0), `public/portraits/capitol.jpg` (CC BY-SA 3.0). No Burry image.
- No testimonials, no TVL milestones, no press — do not fabricate any.

## Product Principles

- Deposit is the hero action: every section should shorten the path from landing to signed transaction.
- Never hide an uncomfortable fact (frozen tracker, editorial picks, filing delays) — disclose it with confidence, not apology.
- All displayed numbers come from the chain or a citable filing; nothing invented.
- One config file drives the product; new trackers must be a config edit, not a redesign.
