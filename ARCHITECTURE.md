# Autopilot on Solana

Copy-trade a famous investor's disclosed portfolio by holding one SPL token.
Deposit SOL into a tracker vault, receive a share token priced at NAV, burn it
back for SOL whenever you want.

**Live:** https://autopilot-solana.vercel.app · **Cluster:** devnet ·
**Program:** `8cKanyTRdgbdf8eWiLpqzy3kwzsXWXNxQdd6NRauCSNK`

```
autopilot-solana/
├── anchor/                  Solana program (Anchor 1.1.2)
│   └── programs/autopilot-vault/src/
└── web/                     Next.js 16 app (App Router)
    ├── src/
    └── scripts/             operational scripts, run with node
```

---

## 1. The program

One **generic** vault program parameterized by basket config. Every tracker,
curated or creator-launched, is the same code path with a different `Tracker`
account; only who may call `initialize_tracker` would differ.

### Accounts

| Account | Seeds | Purpose |
| --- | --- | --- |
| `Tracker` | `["tracker", ticker]` | Config: authority, basket legs, fees, cadence, bumps |
| Vault | `["vault", tracker]` | System-owned PDA holding the SOL. Data-less, so the program moves lamports with a signed system transfer |
| Share mint | `["share", tracker]` | SPL mint, 9 decimals, mint authority = tracker PDA, **freeze authority unset** so nobody can freeze a holder |

Share **supply is the share count**. There is no second copy of it in the
`Tracker` account that could drift out of sync.

### State

```rust
Tracker {
  authority, share_mint, fee_recipient,
  ticker, name,                      // ticker is also the PDA seed
  legs: Vec<BasketLeg>,              // max 16
  deposit_fee_bps, redeem_fee_bps,   // capped at MAX_FEE_BPS = 300
  rebalance_interval, last_rebalance_ts, rebalance_count,
  filing_delay_days,
  rent_reserve,                      // excluded from net assets
  paused, created_at, bump, vault_bump, mint_bump,
}

BasketLeg { mint: Pubkey, symbol: String, weight_bps: u16 }
```

`mint == Pubkey::default()` means the name has **no tokenized equivalent**, so
its weight sits in the SOL sleeve rather than being silently dropped. On devnet
that is every leg, because tokenized equities are mainnet-only.

### Instructions

| Instruction | Who | What it does |
| --- | --- | --- |
| `initialize_tracker(args)` | deployer | Creates tracker + share mint + vault, funds the vault to rent exemption and records `rent_reserve`, validates weights sum to exactly 10000 bps |
| `deposit(lamports_in, min_shares_out)` | anyone | Skims the fee to `fee_recipient`, sends the rest to the vault, mints `net * supply / net_assets` shares (1:1 at genesis so NAV starts at exactly 1.0) |
| `redeem_for_sol(shares_in, min_lamports_out)` | holder | Burns shares, pays out `net_assets * shares / supply` minus fee. **Works while paused** |
| `redeem_in_kind(shares_in)` | holder | Burns shares, delivers pro-rata of each tokenized leg via `remaining_accounts` triples (mint, vault ATA, holder ATA) plus the SOL sleeve. Fee is a haircut retained by the vault |
| `rebalance(legs)` | authority | Publishes a new basket, bumps `rebalance_count`, emits an event |
| `set_paused(bool)` | authority | Halts deposits only |
| `set_fees(deposit, redeem)` | authority | Within the compiled 3% ceiling |
| `set_token_metadata(name, symbol, uri)` | authority | Metaplex CPI. Required because the mint authority is a PDA, so only the program can sign |

### Safety properties worth knowing

- **Slippage enforced on chain.** Deposit and redeem both carry a caller
  minimum. If NAV moves between quote and landing, the transaction reverts
  rather than quietly costing the user.
- **Pausing cannot trap funds.** `set_paused` gates `deposit` only; redemption
  paths never check it.
- **Fees are capped in the program**, not just the UI. A tracker cannot be
  reconfigured into a 90% exit tax after deposits land.
- **Rent reserve is excluded from NAV** and guarded on every payout, so
  depositor value is never inflated by the vault's own rent.
- **u128 intermediate math** (`mul_div`) so a large vault cannot overflow.
- Freeze authority is deliberately never set.

### Building

```bash
cd anchor
anchor build                      # needs Anchor 1.1.2
solana program deploy target/deploy/autopilot_vault.so \
  --program-id 8cKanyTRdgbdf8eWiLpqzy3kwzsXWXNxQdd6NRauCSNK --url devnet
```

> **macOS gotcha:** `anchor build` hangs in `strip.sh` if
> `platform-tools-sdk/sbf/dependencies/platform-tools` is missing. Symlink it to
> `~/.cache/solana/v1.52/platform-tools`.

---

## 2. The trackers

Seven vaults, all live on devnet, all seeded with real deposits.

| Ticker | Fund | Source | Rebalance |
| --- | --- | --- | --- |
| `mbtSOL` | Michael Burry Tracker | Scion's final 13F (Q3 2025) | Never, source is gone |
| `icSOL` | Inverse Cramer Index | Editorial | Monthly |
| `pltSOL` | Pelosi Tracker | STOCK Act disclosures | On each disclosure |
| `cgSOL` | Congress Tracker | Aggregated disclosures, equal weight | Quarterly |
| `bwSOL` | Buffett Tracker | Berkshire 13F top 6 | Quarterly |
| `jstSOL` | Jim Simons Tracker | Renaissance 13F top 5 | Quarterly |
| `psqSOL` | Ackman Tracker | Pershing Square 13F top 5 | Quarterly |

**Every basket was verified against real filings before any copy was written.**
Where a strategy cannot be represented honestly, the card says so rather than
faking it: Scion deregistered with the SEC in Nov 2025 and ~80% of its final
book was put options a long-only vault cannot hold; Pelosi's filings disclose
ranges and options, so those weights are labeled editorial estimates; Medallion
discloses nothing, so `jstSOL` tracks only RenTec's public 13F.

All seven have Metaplex metadata and circular portrait icons, so they render
with real names and images in Phantom and explorers.

---

## 3. The frontend

Next.js 16 App Router, React 19, Tailwind v4, `@solana/kit` v7.

### Solana integration

Deliberately **not** wallet-adapter. Per the current Solana Foundation guidance:

- `@solana/kit` v7 plugin client, built once in `app/providers.tsx`
- `@solana/kit-plugin-wallet` for Wallet Standard discovery (no per-wallet adapters)
- `@solana/react` for `ClientProvider`, `useClient`, `useAction`

The program client in `lib/vault/` is hand-rolled rather than codegen'd: three
account layouts and two instructions is less code than a Codama pipeline.
Anchor discriminators are precomputed and pinned so nothing hashes at runtime.

| File | Role |
| --- | --- |
| `lib/vault/program.ts` | PDAs, borsh decoders, instruction data encoders, discriminators |
| `lib/vault/instructions.ts` | Instruction builders + `explainTransactionError` mapping every program error code to a human sentence |
| `lib/vault/hooks.ts` | `useVault` (one `getMultipleAccounts` for tracker + mint + vault, so NAV can never render from a mismatched slot), `useShareBalance`, `useSolBalance` |
| `lib/vault/pulse.ts` | Cluster vitals for the ticker rail: slot, TPS, epoch |
| `lib/config.ts` | **Single source of truth.** Every address, ticker, fee, basket, portrait, and piece of copy. Launch day is a one-line edit |

### Design system

One committed world in `app/globals.css`: white paper ground, Instrument Serif
display, Inter body, IBM Plex Mono for every number, and the Solana brand
gradient (`#00FFA3 → #DC1FFF`) as the only accent.

- **Numbers are always mono and always tabular** so columns never jitter
- `--grad-a-ink` / `--grad-b-ink` are darkened gradient stops used for text, so
  gradient numerals still pass contrast on white
- Portraits render as **dot-matrix halftones** on `<canvas>`, a stylized
  derivative rather than a photograph. Changing the source **morphs dot radii
  in place** rather than swapping images, so one face dissolves into the next
- `prefers-reduced-motion` is honored throughout, including the halftone morph

### Key components

| Component | Notes |
| --- | --- |
| `site/hero.tsx` | Doubles as the fund detail view: selecting a tracker swaps the headline for a 50/50 `FundPanel` + sticky portrait |
| `trackers/tracker-row.tsx` | List row with live vault chip, expands via animated `grid-template-rows` (no JS measurement) |
| `trackers/trade-form.tsx` | Buy/redeem with quote, fee, enforced minimum, and per-error-code messages |
| `ui/halftone.tsx` | The canvas dot renderer and morph |
| `lib/polyfills.ts` | **Load-bearing.** Safari has no `DisposableStack`; `@solana/kit` uses it at module scope, so without this every iOS visitor got a blank page. Must be imported before any Kit import |

---

## 4. Operational scripts

Run from `web/`. All are idempotent and default to devnet.

```bash
node scripts/init-trackers.mjs                # create any missing trackers
node scripts/set-metadata.mjs                 # register Metaplex metadata
node scripts/deposit.mjs mbtSOL 0.3           # deposit SOL, mint shares
node scripts/redeem.mjs  mbtSOL 0.1           # burn shares, get SOL back
```

Override the endpoint with `RPC_URL=…` (the public devnet faucet and RPC are
heavily rate limited; a Helius devnet URL is more reliable).

---

## 5. What is deliberately not built

- **Creator-launched indexes.** The program is already generic enough; what is
  missing is the creator flow, the fee split, and the trust surface that
  distinguishes a stranger's basket from a curated one. `/launch` states this
  plainly instead of showing a dead "coming soon".
- **Real swaps into tokenized equities.** Those mints are mainnet-only, so on
  devnet every vault holds SOL and the UI says so on each card.
- **An audit.** The program is unreviewed. The site says "unaudited, devnet
  only" wherever it would matter.
