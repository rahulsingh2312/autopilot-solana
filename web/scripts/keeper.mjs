/**
 * Keeps each vault invested, and keeps enough SOL to redeem out of.
 *
 *   RPC_URL=... SOLANA_KEYPAIR=... node --experimental-strip-types \
 *     --import ./scripts/ts-resolve.mjs scripts/keeper.mjs [ticker]
 *
 * Simulates unless `SEND=1`.
 *
 * # What it is for
 *
 * Two problems, one job.
 *
 * A deposit only ever puts SOL in the sleeve. Nothing about minting shares buys
 * anything, so a vault that takes deposits and is never rebalanced holds cash
 * and tracks nothing — and each new depositor dilutes the basket further toward
 * SOL until somebody intervenes.
 *
 * And `redeem_for_sol` pays out of that same sleeve, checking the holder's
 * *gross* claim against it. A vault invested to its target weights has a sleeve
 * of nearly nothing, so it computes a correct payout and then reverts. The
 * holder's exit becomes take-in-kind plus a sale per leg: three signatures
 * instead of one.
 *
 * The answer is to stay invested and hold only what operations require. A
 * holder paid SOL to own stocks; cash sitting in the vault is not what they
 * bought, and a fund carrying 15% cash lags its own basket by 15% of whatever
 * the basket does.
 *
 * So the floor is a fixed number of lamports, not a share of the fund. It
 * exists so the vault can always cover its own rent and never lands in a state
 * where the next instruction fails for want of a few thousand lamports. It does
 * not scale with the fund, because nothing about paying rent does.
 *
 * The cost of that choice lands on redemption: `redeem_for_sol` can only settle
 * what the sleeve holds, so exiting a fully invested vault means taking the
 * basket and selling it — one transaction for the stock, a few more for the
 * sale. That is the honest shape of a fund that actually holds its assets, and
 * the alternative is a cash pile wearing a basket's name.
 *
 * # Why it will not churn
 *
 * Each trade costs roughly half a percent of the amount traded, in Jupiter's
 * fee and the gap between the pool price and Pyth's. Rebalancing on every
 * one-basis-point drift would hand that to the AMMs continuously, so nothing
 * moves until a leg is `DRIFT_BPS` away from where it should be, and no trade
 * smaller than `MIN_TRADE_LAMPORTS` is worth its own fee.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createKeyPairSignerFromBytes, createSolanaRpc } from "@solana/kit";

import { LIVE_TRACKERS } from "../src/lib/config.ts";
import { findAssociatedTokenPdaFor } from "../src/lib/vault/oracle.ts";
import {
  TOKEN_PROGRAM,
  WSOL,
  ixCreateAta,
  ixSwapLeg,
  planRoute,
  readVault,
  resolveLookupTables,
  rpcRetry,
  sendOrSimulate,
} from "./lib/vault-ops.mjs";

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("RPC_URL is required");
  process.exit(1);
}
const SEND = process.env.SEND === "1";

/**
 * Cash held as a share of the fund. Zero, deliberately.
 *
 * Set it above zero only to trade tracking for one-transaction redemptions,
 * and know that is the trade being made.
 */
const BUFFER_BPS = Number(process.env.BUFFER_BPS ?? 0);

/** How far a leg must drift from target before it is worth a trade. */
const DRIFT_BPS = Number(process.env.DRIFT_BPS ?? 200); // 2 percentage points

/**
 * Smallest trade worth making.
 *
 * Below roughly this size the fixed costs of a swap dominate the position it
 * establishes, and Jupiter frequently will not quote at all.
 */
const MIN_TRADE_LAMPORTS = BigInt(process.env.MIN_TRADE_LAMPORTS ?? 5_000_000); // 0.005 SOL

/**
 * The only SOL the vault deliberately keeps: enough to operate, and no more.
 *
 * A flat figure rather than a percentage, because what it covers — staying
 * above rent, having lamports on hand for the next instruction — does not grow
 * with the fund. On a large vault it rounds to nothing; on a small one it is
 * the difference between working and not.
 */
const FLOOR_LAMPORTS = BigInt(process.env.FLOOR_LAMPORTS ?? 2_000_000); // 0.002 SOL

const rpc = createSolanaRpc(RPC_URL);
const signer = await createKeyPairSignerFromBytes(
  new Uint8Array(
    JSON.parse(
      await readFile(process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json"), "utf8"),
    ),
  ),
);

const only = process.argv[2];
const tickers = LIVE_TRACKERS.map((t) => t.ticker).filter((t) => !only || t === only);

const sol = (v) => (Number(v) / 1e9).toFixed(6);
let traded = 0;
let planned = 0;

console.log(`keeper    ${signer.address}  ${SEND ? "SENDING" : "simulating"}`);
console.log(
  `floor     ${sol(FLOOR_LAMPORTS)} SOL${BUFFER_BPS ? ` + ${BUFFER_BPS / 100}%` : ""}` +
    `   drift ${DRIFT_BPS / 100}pp   min trade ${sol(MIN_TRADE_LAMPORTS)} SOL\n`,
);

for (const ticker of tickers) {
  const v = await readVault(rpc, ticker);
  if (!v) {
    console.log(`${ticker.padEnd(9)} not initialized`);
    continue;
  }
  if (v.netAssets === 0n) {
    console.log(`${ticker.padEnd(9)} empty`);
    continue;
  }
  if (v.tracker.manager !== signer.address) {
    console.log(`${ticker.padEnd(9)} SKIPPED — ${signer.address} is not the manager`);
    continue;
  }

  // Everything above the operating floor is the basket's. `BUFFER_BPS` is
  // normally zero, so this is `netAssets - floor`.
  const bufferTarget =
    (v.netAssets * BigInt(BUFFER_BPS)) / 10_000n + FLOOR_LAMPORTS;
  const investable = v.netAssets > bufferTarget ? v.netAssets - bufferTarget : 0n;

  console.log(
    `${ticker.padEnd(9)} NAV ${sol(v.netAssets)} SOL   sleeve ${sol(v.sleeve)} ` +
      `(${((Number(v.sleeve) * 100) / Number(v.netAssets)).toFixed(1)}%, keeping ${sol(bufferTarget)})`,
  );

  for (const leg of v.legs) {
    const target = (investable * BigInt(leg.weightBps)) / 10_000n;
    const delta = target - leg.lamports; // positive: buy, negative: sell
    const driftBps = Number((delta < 0n ? -delta : delta) * 10_000n / v.netAssets);
    const sym = leg.binding.symbol;

    if (driftBps < DRIFT_BPS) {
      console.log(`  ${sym.padEnd(6)} on target (${(driftBps / 100).toFixed(2)}pp)`);
      continue;
    }

    const buying = delta > 0n;
    let amountIn;
    if (buying) {
      // Never spend below the floor, and never spend the buffer itself.
      const spendable = v.sleeve > FLOOR_LAMPORTS ? v.sleeve - FLOOR_LAMPORTS : 0n;
      amountIn = delta < spendable ? delta : spendable;
    } else {
      // Selling: the amount is denominated in the leg's own base units, so the
      // lamport shortfall has to be converted back through the same price the
      // valuation used.
      const shortfallLamports = -delta;
      const fraction = Number(shortfallLamports) / Number(leg.lamports);
      amountIn = BigInt(Math.floor(Number(leg.amount) * Math.min(fraction, 1)));
    }

    const notional = buying ? amountIn : (buying ? 0n : -delta);
    if (notional < MIN_TRADE_LAMPORTS || amountIn <= 0n) {
      console.log(`  ${sym.padEnd(6)} ${(driftBps / 100).toFixed(2)}pp off, too small to trade`);
      continue;
    }

    const inputMint = buying ? WSOL : leg.binding.mint;
    const outputMint = buying ? leg.binding.mint : WSOL;
    const vaultWsol = await findAssociatedTokenPdaFor(v.vault, WSOL, TOKEN_PROGRAM);

    const plan = await planRoute({ vault: v.vault, inputMint, outputMint, amountIn });
    if (!plan) {
      console.log(`  ${sym.padEnd(6)} ${(driftBps / 100).toFixed(2)}pp off, no route fits`);
      continue;
    }
    await resolveLookupTables(rpc, plan);

    const instructions = [];
    // The program wraps into this account but does not create it.
    const { value: wsolInfo } = await rpcRetry(() =>
      rpc.getAccountInfo(vaultWsol, { encoding: "base64", commitment: "confirmed" }).send(),
    );
    if (!wsolInfo) {
      instructions.push(
        ixCreateAta({
          payer: signer.address,
          owner: v.vault,
          mint: WSOL,
          ata: vaultWsol,
          tokenProgram: TOKEN_PROGRAM,
        }),
      );
    }

    instructions.push(
      ixSwapLeg({
        manager: signer.address,
        trackerAddress: v.trackerAddress,
        vault: v.vault,
        sourceTa: buying ? vaultWsol : leg.ata,
        destinationTa: buying ? leg.ata : vaultWsol,
        sourceMint: inputMint,
        destinationMint: outputMint,
        // Unused by the handler, which resolves each side from the account it
        // was given, but passed as the leg's program rather than a guess.
        tokenProgram: leg.binding.tokenProgram,
        amountIn,
        minOut: plan.minOut,
        routeData: plan.routeData,
        routeAccounts: plan.route.accounts,
      }),
    );

    const result = await sendOrSimulate({
      rpc,
      signer,
      instructions,
      lookupTables: plan.lookupTables,
      send: SEND,
    });

    const verb = buying ? "buy " : "sell";
    if (!result.ok) {
      console.log(`  ${sym.padEnd(6)} ${verb} FAILED ${result.error}`);
      for (const l of result.logs.slice(-4)) console.log(`         ${l}`);
      continue;
    }
    planned += 1;
    if (result.signature) traded += 1;
    console.log(
      `  ${sym.padEnd(6)} ${verb} ${(driftBps / 100).toFixed(2)}pp  ${plan.label}  ` +
        `${result.bytes}b ${result.cu}cu  ${result.signature ?? "(simulated)"}`,
    );
  }
  console.log();
}

console.log(
  SEND
    ? `${traded} trade(s) sent`
    : `${planned} trade(s) would be made. SEND=1 to execute.`,
);
