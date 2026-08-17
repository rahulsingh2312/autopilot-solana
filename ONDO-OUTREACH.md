# Ondo Stocks — Primary Purchaser application

**To:** onboarding@ondo.finance
**Subject:** Primary Purchaser access — on-chain index vaults on Solana (Warhol)

---

Hi Ondo team,

I'm building Warhol, an on-chain index product on Solana. A user deposits SOL into a
vault program and receives a single token representing a fixed-weight basket of
tokenized US equities. The vault holds the constituents directly, prices them against
Pyth's equity feeds, and mints or burns shares at NAV. It's live on Solana mainnet
today — program `7Z3DAC8q4vgFr2ofxXonHT2jgJx3xk1bmQHsRjUmVAnY`.

I'd like to apply for Primary Purchaser status and API access.

**Why primary issuance rather than the secondary market.** Acquiring constituents on
the open market is the part that doesn't work at any meaningful size. Measured on the
venues we can currently route through, most tokenized equity pairs are a few thousand
dollars deep — several of the names we need show under $10k of total liquidity, and
outside the top ~25 tickers a $1,000 order moves the price by more than 2%. For a
product whose entire premise is that the token is worth its NAV, paying 2-10% slippage
to assemble the basket defeats the mechanism. Minting against the API at the underlying
price is the only way the arithmetic holds, and it's the reason I'd rather be a Primary
Purchaser than a large taker.

**What we'd need.**

- Primary Purchaser onboarding and whitelisting
- REST API access for mint/redeem attestations and pricing
- Streaming API access for real-time prices, if available at our tier

**Assets.** Our current baskets need: NVDA, MSFT, AAPL, AMZN, GOOGL, META, TSLA, COIN,
CRCL, HOOD, MSTR, STRC, GME, MCD, KO, PEP, XOM. Could you confirm which of these are
live as Ondo Stocks on Solana, and what the roadmap looks like for the rest? Coverage is
the main input into which baskets we ship next.

**Technical questions**, ahead of any integration work:

1. **PDA whitelisting.** Our vault is a program-derived address — it has no private key
   and signs only via the program. Can a PDA be whitelisted as a mint recipient, or does
   the whitelist assume an EOA that can sign directly? This is the single biggest
   unknown for us; if it requires an EOA, we'd need to know before designing the
   custody path.
2. **Token-2022 extensions.** Which extensions do the Solana mints carry — permanent
   delegate, transfer hook, default account state, pausable? We already handle a
   permanent delegate and a scaled-UI-amount multiplier on other issuers' tokens, but a
   live transfer hook would change how our program's associated token accounts are set
   up, and a non-`Initialized` default account state would need an explicit thaw step.
3. **Attestation validity window.** How long is a mint quote signature valid? We'd like
   the request-attestation and broadcast steps to land in the same block where possible.
4. **Operational parameters.** Minimum and maximum mint size, fee schedule, settlement
   timing, and how redemptions behave outside US market hours.

**About us.** [ENTITY NAME], incorporated in [JURISDICTION]. [ONE LINE: who's behind it,
any prior shipped work.] Expected initial volume is modest — [$X] per month at launch,
scaling with the product. Happy to complete KYB/KYC and to talk through the vault design
in as much detail as is useful.

Best,
[NAME]
[TITLE], [ENTITY]
[EMAIL] · sol.copycat.my

---

## Before you send

Four blanks that need real answers, and one of them is not cosmetic:

- **`[ENTITY NAME]` / `[JURISDICTION]`** — Ondo Stocks is offered to non-US persons, and
  onboarding is KYB/KYC gated. This is the same jurisdiction question that's still open
  on the risk page. If there's no entity yet, that's worth resolving before sending;
  applying as an individual is possible but weakens the ask.
- **`[$X] per month`** — don't inflate it. A small honest number with a credible product
  behind it reads better than a large one you can't support, and they will ask.
- **`[ONE LINE]`** — link the live site and the deployed program. The fact that it's
  already on mainnet with real Pyth feeds is the strongest thing in the email.

## What this changes about the product, if they say yes

Worth thinking through now rather than after the call:

- **Minting takes USDC, not SOL.** Users deposit SOL. Primary issuance settles in a USD
  stablecoin. Something has to bridge that — either the vault swaps SOL→USDC before
  minting, or minting happens out-of-band on a treasury basis and the vault trades
  against inventory. The second is a materially different product with a balance sheet
  attached.
- **Whitelisting is per-address.** If Ondo can't whitelist a PDA, the tokens can't sit
  in a program-owned vault the way xStocks do today, and the custody model changes.
- **This does not replace the secondary market for redemptions.** A user redeeming
  in-kind receives constituent tokens that they then have to sell into the same thin
  pools. Primary issuance fixes the entry, not the exit.
