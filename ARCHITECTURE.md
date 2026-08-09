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

### Two denominators, deliberately separate

```rust
WEIGHT_DENOMINATOR: u32 = 10_000;    // basket weights, basis points
FEE_DENOMINATOR:    u64 = 1_000_000; // fees, parts per million
MAX_FEE_PPM:        u16 = 30_000;    // 3% ceiling, compiled in
```

These were **one shared constant** until fees moved to ppm. Changing it naively
would have silently redefined a valid basket as one summing to 1,000,000
instead of 10,000, invalidating every tracker's weights and breaking
`rebalance`. Keep them apart.

Fee fields stayed `u16` through that change, which is why the `Tracker` layout
is byte-identical and no account needed migrating. A 3% cap is 30,000 ppm,
which still fits.

### State

```rust
Tracker {
  authority, share_mint, fee_recipient,
  ticker, name,                      // ticker is also the PDA seed
  legs: Vec<BasketLeg>,              // max 16
  deposit_fee_ppm, redeem_fee_ppm,   // capped at MAX_FEE_PPM
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
| `redeem_in_kind(shares_in)` | holder | Burns shares, delivers pro-rata of each tokenized leg via `remaining_accounts` triples (mint, vault ATA, holder ATA) plus the SOL sleeve. Fee is a haircut retained by the vault. **Needs no oracle** |
| `rebalance(legs)` | authority | Publishes a new basket, bumps `rebalance_count`, emits an event |
| `set_paused(bool)` | authority | Halts deposits only |
| `set_fees(deposit_ppm, redeem_ppm)` | authority | Within the compiled 3% ceiling |
| `set_token_metadata(name, symbol, uri)` | authority | Metaplex CPI. Required because the mint authority is a PDA, so only the program can sign |

### Safety properties worth knowing

- **Slippage enforced on chain.** Deposit and redeem both carry a caller
  minimum. If NAV moves between quote and landing, the transaction reverts
  rather than quietly costing the user.
- **Pausing cannot trap funds.** `set_paused` gates `deposit` only; redemption
  paths never check it.
- **Fees are capped in the program**, not just the UI.
- **Rent reserve is excluded from NAV** and guarded on every payout.
- **u128 intermediate math** (`mul_div`) so a large vault cannot overflow.
- Freeze authority is deliberately never set.

### Building and deploying

```bash
cd anchor
anchor build                      # needs Anchor 1.1.2
solana program deploy target/deploy/autopilot_vault.so \
  --program-id 8cKanyTRdgbdf8eWiLpqzy3kwzsXWXNxQdd6NRauCSNK --url devnet
```

> **macOS gotcha:** `anchor build` hangs in `strip.sh` if
> `platform-tools-sdk/sbf/dependencies/platform-tools` is missing. Symlink it to
> `~/.cache/solana/v1.52/platform-tools`.

> **Upgrades need ~2.4 SOL transiently** for the deploy buffer, even though it
> is refunded. The devnet faucet rate-limits hard; redeeming our own tracker
> shares is a reliable way to reclaim SOL when short.

---

## 2. NAV, and the gap before mainnet

```
NAV = (vault lamports − rent_reserve) ÷ share supply
```

Deposits mint proportionally, so **minting and burning can never move NAV**.
Only the vault's holdings changing value, or fees retained in the vault, can.
On devnet the vault holds only SOL and SOL is the unit of account, so NAV is
pinned at 1.0000. These are cash vaults with a published target basket, and the
UI says so.

**The mainnet gap:** `net_assets()` counts only lamports. Fund a vault with
tokenized equities without changing it and NAV ignores them entirely, so
depositors mint far too many shares and dilute existing holders. Mainnet needs
a valuation step reading each leg's balance against a SOL-denominated price,
multiplied by the xStocks rebasing multiplier.

`redeem_in_kind` is unaffected: it pays `vault_balance × shares ÷ supply` per
leg, correct at any price, so it keeps working even if a feed goes stale.

---

## 3. The trackers

Seven vaults, all live on devnet, all seeded with real deposits. Fees are
**10 ppm (0.001%)** in and out on every one.

| Ticker | Fund | Share mint | Source |
| --- | --- | --- | --- |
| `mbtSOL` | Michael Burry Tracker | `EkCack…QKum` | Scion final 13F (Q3 2025) |
| `icSOL` | Inverse Cramer Index | `BKzHT1…t6uu` | Editorial |
| `pltSOL` | Pelosi Tracker | `9wHzV6…ARtQ` | STOCK Act disclosures |
| `cgSOL` | Congress Tracker | `BL47Ni…Bkfw` | Aggregated disclosures |
| `bwSOL` | Buffett Tracker | `Ackvk…EGJN` | Berkshire 13F top 6 |
| `jstSOL` | Jim Simons Tracker | `5t8wBg…gNqa` | Renaissance 13F top 5 |
| `psqSOL` | Ackman Tracker | `2bksTX…HFh6` | Pershing Square 13F top 5 |

**Every basket was verified against real filings before any copy was written.**
Where a strategy cannot be represented honestly, the card says so: Scion
deregistered in Nov 2025 and ~80% of its final book was puts a long-only vault
cannot hold; Pelosi's filings disclose ranges and options, so those weights are
labelled editorial estimates; Medallion discloses nothing, so `jstSOL` tracks
only RenTec's public 13F.

All seven have Metaplex metadata and halftone token art with the Solana
gradient ring.

---

## 4. The frontend

Next.js 16 App Router, React 19, Tailwind v4, `@solana/kit` v7. Deliberately
**not** wallet-adapter, per current Solana Foundation guidance: Kit plugin
client + Wallet Standard discovery + `@solana/react`.

| File | Role |
| --- | --- |
| `lib/config.ts` | **Single source of truth.** Every address, ticker, fee, basket, portrait, and piece of copy |
| `lib/vault/program.ts` | PDAs, borsh decoders, instruction encoders, pinned discriminators |
| `lib/vault/instructions.ts` | Builders + `explainTransactionError`, mapping each program error code to a human sentence |
| `lib/vault/hooks.ts` | `useVault` (one `getMultipleAccounts` so NAV never renders from a mismatched slot), share/SOL balances |
| `lib/vault/pulse.ts` | Cluster vitals for the ticker rail |
| `lib/xstocks.ts` | Live basket prices from Backed |
| `lib/polyfills.ts` | **Load-bearing.** See below |
| `components/ui/halftone.tsx` | Canvas dot renderer; morphs dot radii in place when the portrait changes |
| `components/ui/nav-note.tsx` | The NAV asterisk and its always-visible definition |

### API routes

| Route | Status |
| --- | --- |
| `/api/xstocks` | ✅ Asset directory (641 names, **paginated at 100 — page it or you lose NVDA**) |
| `/api/xstocks?symbols=` | ✅ Live price, rebasing multiplier, halt status |
| `/api/waitlist` | ✅ Posts signups to Telegram |
| `/api/backtest` | ⚠️ Built but returns null: no working price-history source |

### Safari: the one that took the site down

`@solana/kit` v7 uses `DisposableStack` at module scope. Safari has not shipped
explicit resource management, so the whole bundle threw before React mounted
and **every iOS visitor saw a blank page while desktop worked fine.** Fixed by
importing `disposablestack/auto` in `lib/polyfills.ts`, which must be the first
import in `providers.tsx`, above any Kit import.

---

## 5. Data sources, tested

| Source | Result |
| --- | --- |
| xStocks `/public/assets`, `/multiplier`, `/system/status`, `/proof-of-reserves` | ✅ Free, no key |
| xStocks `/price-data` | ⚠️ `200` with `{"quote": null}` outside US market hours. Never yet observed carrying a price, so **the parse path is unverified** |
| House Clerk FD ZIP | ✅ Free and official, but the XML is only an index. Tickers and amounts live in per-filing PDFs, many scanned |
| House / Senate Stock Watcher S3 | ❌ `403 AccessDenied`, buckets dead |
| Quiver API | 🔑 Paid. Public pages are client-rendered and scrapeable with a headless browser |
| Yahoo Finance chart | ❌ `429` from both this machine and Vercel egress |
| Stooq | ❌ JavaScript proof-of-work wall |
| Alpha Vantage demo key | ❌ IBM only |

**To ship a performance chip**, a price-history key is needed. Twelve Data
(800/day free) or Polygon (5/min) both fit given a 6-hour cache over ~30 unique
symbols. It must be labelled **backtest**, not fund performance.

---

## 6. Scripts

Run from `web/`. Idempotent, default to devnet, override with `RPC_URL=…`.

```bash
node scripts/init-trackers.mjs           # create any missing trackers
node scripts/set-metadata.mjs            # register Metaplex metadata
node scripts/set-fees.mjs 10 10          # 0.001% in and out (ppm)
node scripts/deposit.mjs mbtSOL 0.3
node scripts/redeem.mjs  mbtSOL 0.1
```

Token art is generated headlessly: crop rectangles are read off a gridded
contact sheet of the portraits, halftoned on canvas with an S-curve for
contrast, and ringed with the Solana gradient. **Replacing `public/tokens/*.png`
updates what wallets show with no transaction**, because the metadata URI is
unchanged. Wallets cache images hard, so the change is not instant.

---

## 7. Open items

**Staged, not shipped** (local edits to `config.ts`):
- Pelosi basket rebuilt from her real disclosures (Intel and Uber calls traded
  May 2026, plus January's Amazon and Vistra exercises). The live on-chain
  basket is still the old one; making it real needs a `rebalance` call.
- Inverse Cramer copy citing Quiver's backtest: 42.7% win rate over 3,427
  trades, Sharpe −0.171, −13.99% last year.

**Not built:**
- Oracle-backed `net_assets`, the prerequisite for mainnet.
- Creator-launched indexes. The program is generic enough; what is missing is
  the creator flow, fee split, and the trust surface separating a stranger's
  basket from a curated one.
- Real swaps into tokenized equities (mainnet-only mints).
- An audit. The program is unreviewed and the site says so.
