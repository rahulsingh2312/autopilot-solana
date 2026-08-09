# Autopilot tracking worker

Watches what the tracked investors disclose, decides what each vault should
hold, and moves it there.

One long-running Node process: a scheduler, an HTTP API the site and the admin
panel read, and a SQLite audit trail. No build step — it runs straight off
`.ts` under Node 24's strip-only TypeScript mode, which is why the code avoids
enums, parameter properties, and namespaces (`erasableSyntaxOnly` enforces it).

```bash
cp .env.example .env && $EDITOR .env
npm install
node --env-file=.env src/index.ts
```

---

## The pipeline

```
SourceAdapter → Filing → TargetPortfolio → RebalancePlan → publish → swap
```

Every stage is a plain value that gets stored, so any basket on the site can be
traced back to the filing that caused it and the transaction that applied it.

| Stage | Where | What it does |
| --- | --- | --- |
| Source | `src/sources/` | Fetches a disclosure. One adapter per kind |
| Portfolio | `src/plan/portfolio.ts` | Filing → the basket to hold, with every exclusion recorded |
| Diff | `src/plan/diff.ts` | Target vs on-chain legs → weights to publish and trades to make |
| Publish | `src/execute/publish.ts` | `rebalance` instruction |
| Swap | `src/execute/publish.ts` | `swap_leg` — a Jupiter route signed by the vault PDA |

### Sources

| Tracker | Source | Status |
| --- | --- | --- |
| bwSOL, jstSOL, psqSOL | SEC EDGAR 13F | ✅ free, official, structured |
| mbtSOL | SEC EDGAR 13F | ✅ ingested, never rebalanced — Scion deregistered |
| icSOL | Editorial | ✅ pushed from the admin panel |
| pltSOL, cgSOL | House Clerk PTRs | ✅ free, official, needs poppler |

Congressional data comes from the House Clerk's own Periodic Transaction
Reports. The repo previously recorded this as impractical because the PDFs are
scanned — that is true of the *annual* financial disclosures, but **not** of
PTRs, which are generated digitally and carry a real text layer. Every paid
product in this space is reselling a parse of these same documents.

Two wrinkles worth knowing: the PDFs are encrypted (empty password), so
`pdftotext` is required and a pure-JS parse would have to implement PDF
decryption; and each parse is cached forever by document ID, because a filed
PTR never changes. That takes the 843-filing aggregate from ~2 minutes cold to
~3 seconds warm.

The Senate publishes separately and is not covered — `CONGRESS_PROVIDER=quiver`
remains for that.

### Three things about 13F data

1. **Rows are not positions.** Berkshire's Q1 2026 filing is 90 rows describing
   29 positions, one row per manager/discretion combination. Aggregation by
   CUSIP is mandatory.
2. **Options are in there.** A row carrying `<putCall>` is an option, which a
   long-only vault cannot hold. Scion's final book was **95.1%** options by
   reported value — the parser measures this rather than trusting copy.
3. **Only the top of the book is resolved.** Renaissance discloses 3,213 names
   and jstSOL keeps five; resolving every CUSIP would be 129 rate-limited
   OpenFIGI batches to answer a question about an already-sorted list.

### And one about PTRs

A member can hold **shares and options of the same ticker at once**, and they
are different products to a long-only vault. Flagging the whole ticker as a
derivative because one transaction was an option throws the share position away
with it — which collapsed pltSOL's basket to three names before it was fixed.
The two sleeves are netted separately: the share sleeve is holdable, the option
sleeve is reported as excluded.

---

## Automatic by default

Each tracker has a `mode`, editable in the admin panel and defaulting to
**auto**: the worker publishes on its own and reports what it did, and with
`autoSwap` it executes the trades too. Nothing waits on a human, because a
tracker that is only as current as someone's attention is not tracking.

`manual` remains as a per-tracker brake — a detected change becomes a pending
plan plus a Telegram alert and waits. `AUTO_PUBLISH=false` flips the whole
fleet back at once.

Manual approval and automation run the *same* function (`applyPlan`), so a plan
approved by hand takes exactly the path an automatic one would.

The admin panel is an internal operations surface, not a product one: it is
noindexed, gated behind its own password, and exists to watch what the worker
did and to override it when needed.

Publishing and swapping are separate on purpose, and always in that order.
Swapping first would leave the vault holding something its published weights do
not describe.

---

## CLI

```bash
node src/cli.ts holdings              # what the chain says right now
node src/cli.ts ingest --force        # fetch, build, plan (never sends)
node src/cli.ts plan bwSOL            # show the pending plan in full
node src/cli.ts publish bwSOL --dry-run
```

## HTTP

Reads are public; writes need `Authorization: Bearer $ADMIN_TOKEN`.

| Route | Purpose |
| --- | --- |
| `GET /health` | Cluster, signer, read-only status |
| `GET /api/trackers` | Everything the panel's index needs, one request |
| `GET /api/trackers/:t` | Full detail incl. holdings and pending plan |
| `GET /api/trackers/:t/history` | Filings, plans, executions |
| `POST /api/trackers/:t/ingest` | Force a cycle |
| `POST /api/trackers/:t/approve` | Apply the pending plan (`{dryRun}`) |
| `POST /api/trackers/:t/reject` | Discard it |
| `PATCH /api/trackers/:t/settings` | mode, autoSwap, drift threshold |
| `PUT /api/trackers/:t/basket` | Editorial baskets only |
| `POST /api/trackers/:t/pause` | Halt deposits (redemption stays open) |

---

## What blocks execution today

Running `plan` on devnet reports it directly:

> cluster is devnet: xStocks mints are mainnet-only, so weights publish but
> nothing trades

Weights publish everywhere. Trading additionally needs:

1. **Mainnet.** There is no devnet xStocks deployment. Mints are discovered
   from Backed's directory (`deployments[network=Solana].address`), so no
   hardcoded registry goes stale.
2. **The redeployed program**, carrying `swap_leg`.
3. **Oracle NAV.** `net_assets()` counts lamports only. Fund a vault with
   tokenized equities without fixing that and depositors mint far too many
   shares. `redeem_in_kind` is unaffected — it pays pro-rata of each leg and is
   correct at any price.

## Operational notes

- **Pyth Hermes requires an API key from 2026-08-18.** The default
  `HERMES_URL` is the Doura Labs endpoint, which does not, so an unattended
  worker does not break on that date.
- **US equity feeds only tick during market hours.** Backed returns
  `{"quote": null}` when markets are shut, and the planner treats an unpriceable
  leg as a blocker rather than valuing it at zero.
- **SEC blocks by IP** without a contact-carrying `User-Agent`. Requests are
  throttled to 8/second here, inside their published ceiling of 10.
