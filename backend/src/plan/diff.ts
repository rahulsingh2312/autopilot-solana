/**
 * Target basket vs the chain → a rebalance plan.
 *
 * A plan has two halves that can succeed independently:
 *
 *   1. **Publish.** Write the new weights into the `Tracker` account. Always
 *      possible, cheap, and the thing the site displays.
 *   2. **Execute.** Actually move assets so holdings match those weights.
 *      Possible only on mainnet, only while the legs are routable, and only
 *      once the program can sign a Jupiter CPI.
 *
 * Keeping them separate is the honest shape. The existing program already
 * treats `rebalance` as publishing intent, and the site already says the swap
 * is a separate step — so a plan that can publish but not trade is a normal
 * outcome with a stated reason, not a failure.
 */

import { env } from "../env.ts";
import { log } from "../log.ts";
import { WEIGHT_DENOMINATOR } from "../types.ts";
import type { OnChainLeg, PlannedTrade, RebalancePlan, TargetPortfolio } from "../types.ts";
import type { Address } from "@solana/kit";

import { ZERO_ADDRESS, type EncodableLeg } from "../chain/program.ts";
import type { TrackerState } from "../chain/state.ts";
import { getQuote, priceImpactBps, valueInLamports, WSOL_MINT } from "../execute/jupiter.ts";

/** Above this, a route is moving the market rather than trading in it. */
const MAX_PRICE_IMPACT_BPS = 300;

/**
 * Trades smaller than this are not worth their fees and slippage. 0.02 SOL is
 * roughly the point where a swap's cost stops being rounding error against the
 * position it is correcting.
 */
const MIN_TRADE_LAMPORTS = 20_000_000n;

/**
 * Reduces a leg symbol to the underlying equity it represents.
 *
 * A basket names the same position two ways: the filing says `NVDA`, and the
 * on-chain leg for a tokenized holding says `NVDAx`, because that is the token
 * actually held. Comparing them raw scores an unchanged basket as a complete
 * turnover, which would fire a rebalance on every single cycle.
 *
 * Only a trailing lowercase `x` is stripped, which is Backed's convention.
 * Real tickers ending in a capital X (NFLX, AMEX) are untouched.
 */
export const underlyingSymbol = (symbol: string): string =>
  (symbol.endsWith("x") ? symbol.slice(0, -1) : symbol).toUpperCase();

/**
 * Summed absolute weight change between two baskets, in bps.
 *
 * Defined over the union of tickers so a position that appears or disappears
 * counts its full weight. A tracker swapping one 20% name for another scores
 * 4000, not 0 — which is the intuition an operator has when they see it.
 */
export function computeDriftBps(
  previous: OnChainLeg[],
  target: Array<{ ticker: string; weightBps: number }>,
): number {
  const before = new Map(previous.map((leg) => [underlyingSymbol(leg.symbol), leg.weightBps]));
  const after = new Map(target.map((leg) => [underlyingSymbol(leg.ticker), leg.weightBps]));

  let drift = 0;
  for (const symbol of new Set([...before.keys(), ...after.keys()])) {
    drift += Math.abs((after.get(symbol) ?? 0) - (before.get(symbol) ?? 0));
  }
  return drift;
}

/**
 * Total vault value in lamports, and what each tokenized leg contributes.
 *
 * Returns null for a leg the venue cannot price, which becomes a blocker.
 * Valuing a position at zero because a quote failed would tell the planner to
 * buy a position the vault already holds.
 */
async function valueVault(state: TrackerState): Promise<{
  totalLamports: bigint;
  legLamports: Map<string, bigint>;
  unpriceable: string[];
}> {
  const legLamports = new Map<string, bigint>();
  const unpriceable: string[] = [];
  let total = state.netLamports;

  for (const holding of state.holdings) {
    if (holding.amount === 0n) {
      legLamports.set(holding.mint, 0n);
      continue;
    }
    const value = await valueInLamports(holding.mint, holding.amount);
    if (value === null) {
      unpriceable.push(holding.symbol);
      continue;
    }
    legLamports.set(holding.mint, value);
    total += value;
  }

  return { totalLamports: total, legLamports, unpriceable };
}

export async function buildPlan(
  portfolio: TargetPortfolio,
  state: TrackerState,
): Promise<RebalancePlan> {
  const previousLegs: OnChainLeg[] = state.account.legs.map((leg) => ({
    symbol: leg.symbol,
    mint: leg.mint,
    weightBps: leg.weightBps,
  }));

  const driftBps = computeDriftBps(previousLegs, portfolio.legs);
  const blockers: string[] = [];
  const trades: PlannedTrade[] = [];

  if (state.account.paused) {
    blockers.push("tracker is paused");
  }

  const tokenized = portfolio.legs.filter((leg) => leg.mint);

  if (env.cluster !== "mainnet-beta") {
    // Not a failure: devnet has no xStocks, the program models that as the SOL
    // sleeve, and the site already discloses it.
    blockers.push(
      `cluster is ${env.cluster}: xStocks mints are mainnet-only, so weights publish but nothing trades`,
    );
  } else if (tokenized.length === 0) {
    blockers.push("no leg in this basket has a tokenized counterpart");
  } else {
    const untokenized = portfolio.legs.filter((leg) => !leg.mint);
    if (untokenized.length > 0) {
      log.info("legs held as SOL sleeve", {
        tracker: portfolio.trackerTicker,
        symbols: untokenized.map((leg) => leg.ticker).join(","),
        bps: untokenized.reduce((sum, leg) => sum + leg.weightBps, 0),
      });
    }

    const { totalLamports, legLamports, unpriceable } = await valueVault(state);
    for (const symbol of unpriceable) {
      blockers.push(`${symbol}: no route to price the existing position`);
    }

    if (totalLamports === 0n) {
      blockers.push("vault is empty: nothing to rebalance");
    } else if (unpriceable.length === 0) {
      // Target lamports per tokenized leg. Untokenized weight deliberately
      // stays in SOL rather than being redistributed across the others, which
      // would silently overweight whatever happens to be tokenized.
      for (const leg of tokenized) {
        const mint = leg.mint!;
        const targetLamports =
          (totalLamports * BigInt(leg.weightBps)) / BigInt(WEIGHT_DENOMINATOR);
        const currentLamports = legLamports.get(mint) ?? 0n;
        const delta = targetLamports - currentLamports;

        if (delta > 0n && delta >= MIN_TRADE_LAMPORTS) {
          const quote = await getQuote({
            inputMint: WSOL_MINT,
            outputMint: mint,
            amount: delta,
          });
          if (!quote) {
            blockers.push(`${leg.ticker}: no route to buy`);
            continue;
          }
          const impact = priceImpactBps(quote);
          if (impact > MAX_PRICE_IMPACT_BPS) {
            blockers.push(`${leg.ticker}: buy price impact ${(impact / 100).toFixed(2)}%`);
            continue;
          }
          trades.push({
            side: "buy",
            ticker: leg.ticker,
            mint,
            amount: delta.toString(),
            deltaBps: Number((delta * BigInt(WEIGHT_DENOMINATOR)) / totalLamports),
          });
        } else if (delta < 0n && -delta >= MIN_TRADE_LAMPORTS && currentLamports > 0n) {
          const holding = state.holdings.find((h) => h.mint === mint);
          if (!holding || holding.amount === 0n) continue;

          // Sell the fraction of the position whose value equals the overshoot.
          const tokensToSell = (holding.amount * -delta) / currentLamports;
          if (tokensToSell === 0n) continue;

          const quote = await getQuote({
            inputMint: mint,
            outputMint: WSOL_MINT,
            amount: tokensToSell,
          });
          if (!quote) {
            blockers.push(`${leg.ticker}: no route to sell`);
            continue;
          }
          const impact = priceImpactBps(quote);
          if (impact > MAX_PRICE_IMPACT_BPS) {
            blockers.push(`${leg.ticker}: sell price impact ${(impact / 100).toFixed(2)}%`);
            continue;
          }
          trades.push({
            side: "sell",
            ticker: leg.ticker,
            mint,
            amount: tokensToSell.toString(),
            deltaBps: -Number((-delta * BigInt(WEIGHT_DENOMINATOR)) / totalLamports),
          });
        }
      }

      // Positions the new basket drops entirely must be sold in full, or the
      // vault keeps holding a name its published weights no longer mention.
      const targetMints = new Set(tokenized.map((leg) => leg.mint));
      for (const holding of state.holdings) {
        if (targetMints.has(holding.mint) || holding.amount === 0n) continue;
        trades.push({
          side: "sell",
          ticker: holding.symbol,
          mint: holding.mint,
          amount: holding.amount.toString(),
          deltaBps: -holding.weightBps,
        });
      }
    }
  }

  // Sells first: they fund the buys, and a buy-first ordering can run the
  // vault out of lamports halfway through a cycle.
  trades.sort((a, b) => (a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));

  return {
    trackerTicker: portfolio.trackerTicker,
    filingId: portfolio.filingId,
    driftBps,
    targetLegs: portfolio.legs,
    previousLegs,
    trades,
    blockers,
    builtAt: new Date().toISOString(),
  };
}

/** Basket legs in the shape the `rebalance` instruction expects. */
export const toEncodableLegs = (portfolio: TargetPortfolio): EncodableLeg[] =>
  portfolio.legs.map((leg) => ({
    // The program reads the zero mint as "no tokenized form, hold as SOL".
    mint: (leg.mint ?? ZERO_ADDRESS) as Address,
    // Name the leg after what the vault actually holds: the xStock symbol
    // when one exists, the plain ticker when the weight sits in SOL. This is
    // the convention the deployed trackers already use.
    // MAX_SYMBOL_LEN is 12 and the program rejects anything longer.
    symbol: (leg.xstockSymbol ?? leg.ticker).slice(0, 12),
    weightBps: leg.weightBps,
  }));
