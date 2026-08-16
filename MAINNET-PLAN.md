# Mainnet, and a price anyone can see

Nine trackers, one program, and a decision about liquidity that costs a lot
more than it looks like it does. This is the cheapest honest route.

**~$235 of irreversible on-chain spend** to be live, routable and priced.
Assumes SOL ≈ $78, rent at 6,960 lamports/byte, program ~405 KB.
Drafted 15 Aug 2026.

---

## The idea the budget rests on

The pool is a **price beacon, not the liquidity.**

A tracker share is mintable and burnable at NAV, on demand, by anyone. That
path is *infinitely deep* — there is no book to exhaust. So an AMM pool is not
where trading capacity comes from, and sizing it like a normal token launch
would be setting money on fire.

What the pool actually buys you is **routability and display**: Jupiter only
routes what sits in a pool, and DexScreener, Birdeye, GeckoTerminal and every
wallet read their price from pool state. Size it to clear the listing
thresholds and let mint/redeem carry the volume.

It also does one thing for free that matters: because anyone can redeem at NAV,
nobody rationally sells below it, and because anyone can deposit at NAV, nobody
rationally buys above it. The pool price is *bounded by arbitrage against the
vault itself*. Thin liquidity that stays pegged beats deep liquidity that
drifts.

---

## Phase 0 — blockers

*Nothing below starts until these land.* Four things that are fine on devnet
and dangerous on mainnet.

### 1. `swap_leg` forwards unchecked accounts into a CPI

`ARCHITECTURE.md` already names this as the surface that most needs an audit.
Today it is harmless because devnet vaults hold only SOL. The moment a mainnet
vault holds real NVDAx, it is the drain vector.

- Pin the Jupiter program ID as a compiled-in constant
- Assert the destination token account is the vault's own ATA
- Assert the output mint is a configured leg
- Check `min_out` against the oracle rather than trusting the caller's number

### 2. Authority lives on a hot key

`emergency_withdraw_sol` and `emergency_withdraw_token` can remove everything,
and `set_authority` can hand that power onward. The risk page disclosing it is
the right call on devnet; on mainnet with a public price it reads as a rug
vector unless the key is a multisig. Move **both the upgrade authority and the
tracker authority** to Squads — free to use, ~0.01 SOL to set up.

### 3. 10 ppm fees earn nothing and leave no arbitrage band

0.001% means a $10,000 deposit pays ten cents. That was fine when there was no
cost of goods; mainnet adds RPC, keeper gas, rebalance slippage and LP capital.

Worse, the fee *is* the arbitrage band — at 10 ppm anyone can round-trip your
pool against NAV for free, and the pool position paying for it is yours. Set
deposit and redeem to **20–30 bps**. The program caps at 3%, so there is room.

### 4. The four-day staleness window becomes exploitable

Allowing equity feeds to be four days stale is correct pricing with no
secondary market — the last close *is* the right valuation over a weekend. Add
a public pool and it becomes a trade: the pool prices Monday's expected open
while deposit and redeem still price Friday's close.

Gating deposits outside US market hours closes one direction. It cannot close
the other, because redemption deliberately never checks `paused`. Honest
answer: widen the fee outside market hours, or require in-kind redemption when
feeds are stale. **Treat this as an open design question, not a solved one.**

> **Worth saying plainly.** A visible price does not only attract users. It
> attracts people who read your program. Every one of the four above is
> currently defensible because nobody is looking; a DexScreener listing is the
> end of that.

---

## Phase 1 — deploy

*Blocked by Phase 0.* Deploy once, and size the allocation yourself.

Program data accounts are rent-exempt at roughly **6,960 lamports per byte**,
and the size is fixed at deploy. Passing `--max-len` explicitly, set to the
actual `.so` size, is the single largest cost lever in this document.

| Allocation | Rent | USD | When |
| --- | ---: | ---: | --- |
| 405 KB — tight | 2.82 SOL | ~$220 | **Recommended.** `solana program extend` later costs only the delta |
| 425 KB — devnet's current | 2.96 SOL | ~$231 | Some headroom for one more dependency |
| 810 KB — old 2× default | 5.64 SOL | ~$440 | What you pay for not passing the flag on an older CLI |

Recent Solana releases changed default sizing from 2× the binary to 1×, so the
third row may not apply to your CLI. Check `solana program deploy --help` on the
version you actually have and pass `--max-len` regardless — the default is not
worth trusting with $200.

- **The rent is a deposit, not a spend.** `solana program close` returns it. The
  genuinely unrecoverable spend is transaction fees, roughly 0.08 SOL for the
  ~200 chunked writes a 405 KB program takes.
- **You need ~6 SOL of working capital at deploy time.** The buffer account
  holds a full second copy while the write is in flight, refunded when the
  deploy succeeds. Budget the peak, not the residue.
- **Do not strip Pyth to save 0.3 SOL.** `pyth-solana-receiver-sdk` is the
  heaviest dependency and hand-rolling the price-account parse would shave tens
  of KB. It also replaces the audited path with your own borsh parsing, in an
  unaudited program, to save the price of a nice dinner. Not worth it.
- **Every re-deploy costs again.** Fees plus buffer churn, each time. Keep
  iterating on devnet — the `--tools-version v1.52` trap in your build notes
  exists precisely to stop you shipping a stale `.so` and paying to do it twice.

---

## Phase 2 — one tracker

*Blocked by Phase 1.* Launch one token, not nine.

Nine trackers means nine mints, nine pools, nine liquidity seeds, nine sets of
listing paperwork and nine positions for a keeper to re-center. It multiplies
every cost below by nine and proves nothing that one token would not.

**Recommended — `mg7SOL`.** All seven legs tokenized on xStocks, near-equal
weights, the most recognizable name on the sheet, and zero editorial judgment
to defend. NAV is fully explainable on day one because there is no untokenized
weight sitting in the SOL sleeve.

**Alternative — `aiSOL`.** Sixteen legs, all tokenized, bigger story. Costs
sixteen leg ATAs and sixteen oracle pushes instead of seven, and rebalances are
correspondingly more expensive to execute.

**Not first — `cgSOL`, `psqSOL`, `bwSOL`, `dtSOL`.** Each carries untokenized
legs whose weight sits in the SOL sleeve. Defensible, already disclosed, but it
makes the first NAV conversation harder than it needs to be.

On-chain cost is rounding error: tracker account, share mint, vault, Metaplex
metadata, seven leg ATAs and seven `LegOracle` PDAs come to roughly **0.05
SOL**. The real capital is whatever you seed the vault with so it holds an
actual basket — and NAV arithmetic is correct at any size, so start small.

---

## Phase 3 — the pool

*Blocked by Phase 2.* Pair against USDC. Concentrate. Open at NAV.

### USDC, not SOL — the biggest recurring cost in the plan

The vault holds US equities. Its value in dollars barely moves; its value in
SOL moves with SOL. Divergence loss scales with the square of the pair's
volatility, so pairing a ~22%-vol basket against a ~60%-vol denominator bleeds
the LP position roughly **six to nine times faster** than pairing against USDC,
for identical depth. You are the LP. This one is not close.

### Meteora DAMM v2 — cheapest venue that Jupiter routes

About **0.022 SOL** for pool and position, with no protocol creation fee.
Raydium CPMM charges 0.15 SOL plus roughly 0.2 SOL of rent; Raydium AMM v4
wants an OpenBook market on top of that. All are Jupiter-routed, so pay the
least.

### Size to the threshold, not to the market

Jupiter's verification bar is about $500 of liquidity per side with under 30%
price impact; DexScreener needs a pool and one trade. Minimum credible is
**$1,000** total. Comfortable is **$2,500–5,000**. Concentrated in a ±10% band,
$1,000 gives roughly the depth $10,000 would across a full range — which is
exactly why you can start this small.

### Open the position at NAV, computed, not chosen

Read NAV from the program, convert through the SOL/USD price, and open there.
Any other opening price is a gift to whoever arbitrages it first, paid out of
your own position. Skip DAMM v2's single-sided launch mode — token-only means
no bid, and a tracker share with no bid is worse than no listing.

---

## Phase 4 — the keeper

*Runs from the day the pool opens.* Two jobs, one small bot, next to the worker
you already have.

**Arbitrage the pool back to NAV.** When the gap exceeds fees plus gas, close
it: pool cheap, buy and redeem; pool rich, deposit and sell. This is what makes
the displayed price *mean* something rather than being whatever the last trade
left behind. Run it yourself at first — nobody else knows the mechanism exists
yet. Then document it publicly and let others do it for free.

**Re-center the range before NAV walks out of it.** A concentrated position that
NAV exits goes 100% one-sided and the price decouples from the vault. Watch the
band, re-center near the edge. This is the ops cost of choosing concentrated
over full-range, and it is the right trade at this size.

Both fit the existing `sources → plan → execute` shape in `backend/`, and both
should respect the same manual/auto gating the trackers already use. Ongoing
cost is gas — cents per day.

---

## Phase 5 — visibility

*Free, and mostly automatic.* You do not pay to be seen.

| Surface | How it happens | Cost | Lag |
| --- | --- | ---: | ---: |
| Jupiter routing | Automatic once the pool holds liquidity | $0 | minutes |
| DexScreener | Automatic on first trade; name and logo come from the Metaplex metadata you already set | $0 | minutes |
| GeckoTerminal | Automatic pool indexing; feeds CoinGecko | $0 | hours |
| Birdeye, Solscan | Automatic | $0 | hours |
| Jupiter verified | Apply once liquidity clears the bar; removes the "unknown token" warning | $0 | days |
| CoinGecko, CMC | Free application form | $0 | weeks |
| DexScreener Enhanced Token Info | Banner and socials on the pair page | $299 | — |

Skip the last row. It buys a banner and social links on a page nobody has found
yet; the logo already arrives through on-chain metadata, which the
`set_token_metadata` instruction exists to set.

---

## The ledger

| Line | SOL | USD | Note |
| --- | ---: | ---: | --- |
| Program data rent, 405 KB tight | 2.820 | $220 | recoverable via `solana program close` |
| Deploy transaction fees | 0.080 | $6 | ~200 chunked writes |
| Squads multisig setup | 0.010 | $1 | Both authorities |
| Tracker, mint, vault, metadata | 0.020 | $2 | One tracker |
| 7 leg ATAs + 7 LegOracle PDAs | 0.030 | $2 | recoverable if closed |
| Meteora DAMM v2 pool + position | 0.022 | $2 | No protocol fee |
| **On-chain total** | **2.982** | **$233** | of which ~$222 is refundable rent |

| Capital, still yours | Amount | Exposure |
| --- | ---: | --- |
| Pool seed | $1,000–5,000 | Divergence loss against the basket; minimised by the USDC pairing |
| Vault seed — buying the basket | your call | Basket price. NAV is correct at any size |
| Deploy working capital, transient | ~2.9 SOL | Refunded when the deploy lands |
| Mainnet RPC | $0 | Helius free tier; ~$49/mo when the frontend outgrows it. Public mainnet-beta will not survive your `getMultipleAccounts` polling |

---

## If it has to be cheaper still

**Cut freely.** Nine trackers down to one. A $5,000 pool down to $1,000. The
$299 DexScreener upgrade. Paid RPC until the free tier actually breaks. Deploy
tight and `extend` later instead of buying headroom now.

**Do not cut.** The `swap_leg` account checks. The multisig on both authorities.
A full dry run of deploy, init, pool creation and one arbitrage round-trip on
devnet before any mainnet SOL moves.

**The floor.** About **$235 of genuinely spent money**, of which roughly $220
comes back if you ever close the program, plus **$1,000** of pool capital that
remains yours. Everything that makes the token visible everywhere is free.

---

## Still open

**Weekend redemption against stale marks.** Pausing deposits handles one
direction. Redemption can never be paused without trapping funds, which is a
property worth keeping. The fee is the only defence, which is another argument
for raising it.

**The program is unaudited and now has a public price.** Nothing in this plan
changes that. Sizing the launch small is the mitigation; it is not a fix.

**Jurisdiction.** Tokenized equities carry access restrictions from the issuer,
and a Jupiter listing is reachable from everywhere. Worth a real answer before
the pool opens rather than after.

---

# Appendix — what if we did this on BNB Chain instead?

xStocks launched on BNB Chain on 30 April 2026 with 50+ tokenized equities and
ETFs, trading on PancakeSwap. So the basket can exist there. This is a real
comparison, not a non-starter.

*Assumes BNB ≈ $600 and BSC gas at 0.1 gwei (the network standard is now 0.05).
At that rate 1M gas ≈ $0.06.*

## On-chain cost: BNB wins by about ten dollars

| Line | Solana | BNB Chain |
| --- | ---: | ---: |
| Program / contract deploy | 2.82 SOL — $220, **refundable** | ~4M gas — **$0.24** |
| Deploy transaction fees | 0.08 SOL — $6 | included above |
| Factory / registry | n/a | ~1.5M gas — $0.09 |
| Per tracker | 0.05 SOL — $4 | EIP-1167 clone, ~250k gas — **$0.02** |
| Token metadata | 0.006 SOL — $0.50 | free — name and symbol live in the contract |
| Multisig setup | 0.01 SOL — $1 | Safe deploy, ~300k gas — $0.02 |
| Pool creation + position | 0.022 SOL — $2 | PancakeSwap v3, ~5M gas — **$0.30** |
| **Gross total** | **$233** | **~$0.70** |
| **Unrecoverable** | **~$11** | **~$0.70** |

**Read the last row, not the one above it.** Solana's $220 is rent — a deposit
that `solana program close` returns. The money you actually spend and never see
again is transaction fees, roughly $11. BNB has no rent at all, so nothing is
locked and nothing comes back. **The genuine cost difference is about ten
dollars.**

Where BNB does win properly is **working capital**, not cost: Solana ties up
~$220 indefinitely and needs ~$460 transiently at deploy time for the buffer.
BNB ties up nothing. If SOL on hand is the binding constraint, that is the
argument — and it is a cashflow argument, not a cost one.

Second real win: **trackers are nearly free to add.** A clone costs about two
cents, so the "launch one, not nine" advice relaxes on BNB. The liquidity
argument for launching one still holds — pools still need seeding.

## The costs that dwarf both

**A full rewrite.** Roughly 1,300 lines of Rust across twelve instructions plus
the oracle module, none of which ports. PDAs become mappings, CPI becomes
interface calls, the PDA mint authority becomes an internal `_mint`,
`remaining_accounts` triples become arrays, and Anchor's account validation
becomes explicit `require`s you have to remember to write.

Then the frontend chain layer: `@solana/kit` v7 → wagmi/viem. `program.ts`
(PDAs, borsh decoders, pinned discriminators) becomes an ABI, which is honestly
*simpler*; `hooks.ts`, `instructions.ts` and `pulse.ts` are rewrites; the
single-slot `getMultipleAccounts` trick becomes Multicall3. The Safari
`DisposableStack` problem disappears entirely.

Then the backend execute layer: `swap_leg` through Jupiter becomes PancakeSwap
router or 1inch/OpenOcean.

Call it **four to six weeks of one engineer** to get back to where devnet
already is. That is the real price tag, and it buys ten dollars of gas.

**A different bug surface, so a fresh audit.** Reentrancy exists on EVM and does
not on Solana. Approve races, division rounding, and above all the **ERC-4626
first-depositor inflation attack** — the single most exploited vault bug class
on EVM. Your Solana design sidesteps it because deposit mints 1:1 at genesis; a
Solidity port needs virtual shares or a dead-shares seed or it ships with a
known hole.

## Two ongoing costs that favour Solana permanently

**Thinner xStocks books.** Tokenized equities are about $755M on-chain in total;
BNB Chain holds roughly $41.7M of it, with Solana leading. Every rebalance
`swap_leg` executes against those books, so worse fills are a recurring cost for
as long as the vault exists.

**Pyth is a pull oracle on EVM.** On Solana the price account is already
on-chain and reading it is free. On BNB every deposit must carry signed update
data and pay to verify it — roughly 300–500k gas for an eight-feed basket, so
~$0.03 per deposit against ~$0.0005 on Solana. Negligible to a user, but it
changes the contract signature and it never goes away.

**MEV.** BSC has a mature, aggressive sandwich population. Your rebalance swaps
and your arbitrage keeper both compete with it, where on Solana the keeper would
have a real head start.

## Recommendation

**Stay on Solana.** The cost case for BNB is ten dollars and a month of
rewriting working, deployed, seeded code.

If the actual reason is **distribution** — Binance's ecosystem, bStocks
momentum, BNB Chain's daily actives — that is a legitimate argument, but it is a
growth argument and should be made on its own terms. Even then the order is the
same: ship Solana first, let demand justify the Solidity rewrite, then deploy
BNB as a second venue.

*One thing to verify before acting on any of this: confirm all seven Magnificent
7 names are in the BNB xStocks list. Apple, Tesla and NVIDIA are confirmed;
Microsoft, Amazon, Alphabet and Meta are very likely in the top 50 but were not
individually checked.*

---

Costs current as of 15 August 2026, computed at SOL ≈ $78 and BNB ≈ $600.
Solana rent is 6,960 lamports per byte for two years; BSC figures assume 0.1
gwei. Venue fees, gas and listing thresholds move — re-check before spending.
