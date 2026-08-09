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
├── backend/                 Tracking worker (Node 24, no build step)
│   └── src/                 sources → plan → execute, plus the HTTP API
└── web/                     Next.js 16 app (App Router)
    ├── src/                 site + /admin operations console
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
| `swap_leg(amount_in, min_out, route)` | authority | Routes one leg through Jupiter, signed by the **vault PDA**. Custody is never broken |
| `push_multiplier(feed_id, multiplier)` | authority | Records a leg's Pyth feed and xStocks rebasing multiplier in a `LegOracle` PDA |
| `close_tracker` | authority | Retires a tracker. **Refuses while any share is outstanding** |
| `emergency_withdraw_sol` / `_token` | authority | Removes vault assets. The one path that can take value from holders |
| `set_authority` | authority | Hands control of a tracker to another key |
| `set_paused(bool)` | authority | Halts deposits only |
| `set_fees(deposit_ppm, redeem_ppm)` | authority | Within the compiled 3% ceiling |
| `set_token_metadata(name, symbol, uri)` | authority | Metaplex CPI. Required because the mint authority is a PDA, so only the program can sign |

### Safety properties worth knowing

- **Slippage enforced on chain.** Deposit and redeem both carry a caller
  minimum. If NAV moves between quote and landing, the transaction reverts
  rather than quietly costing the user.
- **Pausing cannot trap funds.** `set_paused` gates `deposit` only; redemption
  paths never check it.
- **The authority can, though.** `emergency_withdraw_sol` and
  `emergency_withdraw_token` let the authority key remove vault assets outright,
  and `set_authority` hands that power to another key. They exist so a stuck or
  half-rebalanced vault can be recovered by hand. This is a deliberate trade of
  trustlessness for operability, it is disclosed on the risk page, and every use
  emits an event — but it means holders trust the key, not only the code.
- **Fees are capped in the program**, not just the UI.
- **Rent reserve is excluded from NAV** and guarded on every payout.
- **u128 intermediate math** (`mul_div`) so a large vault cannot overflow.
- Freeze authority is deliberately never set.

### Building and deploying

```bash
cd anchor
cargo build-sbf --tools-version v1.52
solana program deploy target/deploy/autopilot_vault.so \
  --program-id 8cKanyTRdgbdf8eWiLpqzy3kwzsXWXNxQdd6NRauCSNK --url devnet
anchor idl build -o target/idl/autopilot_vault.json   # keep the IDL honest
```

> **`--tools-version v1.52` is not optional.** `cargo build-sbf` defaults to
> platform-tools v1.51 and will re-download it into `~/.cache/solana/v1.51`;
> that download has truncated repeatedly here, and the failure mode is the
> worst kind — the build prints an error but **leaves the previous
> `target/deploy/*.so` in place**, so a deploy silently ships the old binary.
> Always verify before deploying:
>
> ```bash
> strings target/deploy/autopilot_vault.so | grep -c "Rebasing multiplier"
> ```
>
> If you do repair v1.51 by extracting the tarball by hand, clear the quarantine
> flag or dyld refuses the toolchain's own dylibs:
> `xattr -dr com.apple.quarantine ~/.cache/solana/v1.51/platform-tools`.

> **The binary no longer fits the original allocation.** Adding the Pyth
> receiver SDK took it from ~342 KB to ~405 KB, past the 350,000 bytes the
> program data account was created with. It has been extended to 425,000; a
> future dependency that pushes past that needs `solana program extend` first,
> and the deploy buffer scales with it.

> **Upgrades need ~2.8 SOL transiently** for the deploy buffer, refunded on
> success. The devnet faucet rate-limits hard and stays limited for hours.
> `~/.config/solana/cargo-manifest-id.json` is a second funded devnet wallet;
> redeeming tracker shares also works but empties the vaults the site displays.

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

**The mainnet gap, now closed in code.** `net_assets()` counted only lamports,
so a vault funded with tokenized equities would price them at nothing and mint
depositors far too many shares. `oracle.rs` adds the valuation step, and both
`deposit` and `redeem_for_sol` now use it:

```
net_assets = (vault lamports − rent_reserve)
           + Σ over tokenized legs:
               balance × multiplier ÷ 10^decimals × pyth(equity) ÷ pyth(SOL)
```

Three things make it work, and each is load-bearing:

- **The multiplier is pushed, not read.** Pyth publishes NVDA's price; nobody
  publishes the factor converting an NVDAx balance into NVDA shares. Backed
  does, over HTTP, so the worker pushes it into a `LegOracle` PDA. It is the
  one trusted input, bounded to 0.01×–100× on chain so a bad push can nudge NAV
  but never invent it.
- **Equity feeds are allowed to be four days stale, SOL only sixty seconds.**
  US equities do not tick overnight or at weekends, and the last close *is* the
  right valuation then — that is how any fund prices. Demanding a fresh equity
  tick would disable deposits two thirds of the week. SOL trades continuously,
  so a stale SOL price means a broken feed.
- **A separate PDA, not a new `Tracker` field.** Adding to `BasketLeg` would
  change the account layout and force migrating every deployed tracker, for
  data that moves on a different schedule entirely.

Devnet is untouched: no leg there is tokenized, `value_tokenized_legs` returns
zero, and the arithmetic is exactly what it was.

`redeem_in_kind` remains oracle-free: it pays `vault_balance × shares ÷ supply`
per leg, correct at any price, so it keeps working even if every feed is stale.
That matters, because a large SOL redemption out of a mostly-tokenized vault
will now compute a correct payout and then fail the rent-reserve check — the
sleeve cannot cover it, and in-kind is the holder's recourse.

**Still open:** the four-day equity window means a depositor can transact on
Friday's close before Monday's open. Every fund has this problem and solves it
with cutoffs or swing pricing; here the deposit fee is the only friction, and
that is a product decision rather than a solved one.

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
- Creator-launched indexes. The program is generic enough; what is missing is
  the creator flow, fee split, and the trust surface separating a stranger's
  basket from a curated one.
- An audit. The program is unreviewed and the site says so — and the surface
  that most needs one is now `swap_leg`, which forwards unchecked accounts into
  a CPI.

---

## 8. The tracking worker

`backend/` watches the sources, decides what each vault should hold, and moves
it there. Full detail in `backend/README.md`; what matters here is the shape.

```
SourceAdapter → Filing → TargetPortfolio → RebalancePlan → publish → swap
```

Every stage is a stored value, so any basket on the site traces back to the
filing that caused it and the transaction that applied it.

**Sources.** SEC EDGAR 13F drives bwSOL, jstSOL, psqSOL and mbtSOL — free,
official, structured, no key. icSOL is pushed from the admin panel. pltSOL and
cgSOL need a paid congress provider and ship disabled rather than guessing;
that decision is a config flip, not a code change.

Three things about 13F data the parser handles and a naive reader does not:
rows are not positions (Berkshire's Q1 2026 filing is 90 rows describing 29
holdings, one per manager); `<putCall>` rows are options a long-only vault
cannot hold; and only the top of the book is CUSIP-resolved, because
Renaissance discloses 3,213 names and jstSOL keeps five.

> Running it against the real filings corrected two things the hand-written
> config had wrong. Scion's final book was **95.1% options by reported value**,
> not the ~80% the site says. And Berkshire's actual Q1 2026 top six ends in
> **OXY, not GOOGL** — bwSOL's live basket is stale by one position, and the
> planner scores it at 31.98% drift.

**Modes.** Each tracker is `manual` (plan + Telegram alert, nothing lands until
someone approves) or `auto` (publishes itself), with `autoSwap` gating whether
it also trades. Approval and automation call the same `applyPlan`, so what a
human approves is exactly what automation would have done. Default is manual.

**Publish and swap are separate, always in that order.** Swapping first would
leave the vault holding something its published weights do not describe.

**The admin console** lives at `/admin` in the web app and proxies to the
worker server-side, so the token that can move a vault's assets never reaches a
browser. Panel login and worker authority are deliberately different secrets.
