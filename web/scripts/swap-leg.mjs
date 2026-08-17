/**
 * Convert a vault's SOL sleeve into one of its legs, through Jupiter.
 *
 *   RPC_URL=... SOLANA_KEYPAIR=... node --experimental-strip-types \
 *     --import ./scripts/ts-resolve.mjs scripts/swap-leg.mjs habitSOL MCDx [lamports]
 *
 * Simulates unless `SEND=1`.
 *
 * # This is the step that makes it an index
 *
 * A deposit only ever puts SOL in. Nothing about minting shares buys anything,
 * so a vault that has taken deposits and never run this holds SOL and tracks
 * nothing. `swap_leg` is what closes that gap, and it is a manager instruction
 * on purpose: repositioning the basket is the creator's job, and the program
 * refuses to let a depositor move the vault's assets.
 *
 * # What the program checks, and what it leaves to Jupiter
 *
 * `route_data` is opaque here and opaque on chain. The vault does not parse the
 * route; it pins Jupiter's program id, requires both token accounts to be its
 * own, requires the destination to be a published leg, and reads balances
 * before and after. Spending more than `amountIn` or receiving less than
 * `minAmountOut` reverts. So a hostile or merely broken route costs a failed
 * transaction rather than the vault's assets, and this script does not need to
 * be trusted with much.
 *
 * # Sizing
 *
 * Defaults to the leg's shortfall against its target weight: `net assets ×
 * weight − what it already holds`, valued at the leg's Pyth price. That is the
 * amount that moves the basket to its published weights and no further.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  AccountRole,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

import { TRACKERS } from "../src/lib/config.ts";
import { LEG_BINDINGS, legBinding } from "../src/lib/leg-bindings.ts";
import { decodeTracker, findTrackerPda, findVaultPda } from "../src/lib/vault/program.ts";
import { findAssociatedTokenPdaFor, findPythPriceAccount } from "../src/lib/vault/oracle.ts";

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("RPC_URL is required");
  process.exit(1);
}
const SEND = process.env.SEND === "1";
const PROGRAM_ID = "7Z3DAC8q4vgFr2ofxXonHT2jgJx3xk1bmQHsRjUmVAnY";
const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const JUP_API = "https://lite-api.jup.ag/swap/v1";
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const IX_SWAP_LEG = 5;

/**
 * 3% of a $2 trade is cents, and a tight bound on a thin pair is how a swap
 * fails repeatedly for no benefit. `min_amount_out` still holds the floor on
 * chain, so this is a routing preference, not the safety limit.
 */
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 300);

/**
 * Ceiling on accounts in the route.
 *
 * `swap_leg` stack-allocates its forwarded account list and rejects anything
 * past `MAX_ROUTE_ACCOUNTS = 40`; the SBF frame is capped at 4 KB and that
 * bound is what keeps it under. Unconstrained, Jupiter happily returns a
 * three-hop route with 63 accounts, which overruns both that and the 1232-byte
 * transaction. `maxAccounts` asks the router for something that fits instead of
 * discovering it does not afterwards.
 *
 * Set below 40 because the ten fixed accounts and the instruction data share
 * the same transaction.
 */
const MAX_ROUTE_ACCOUNTS = Number(process.env.MAX_ROUTE_ACCOUNTS ?? 28);

const [, , TICKER = "habitSOL", XSTOCK = "MCDx", AMOUNT_ARG] = process.argv;

const tracker_ = TRACKERS.find((t) => t.ticker === TICKER);
if (!tracker_) throw new Error(`unknown tracker ${TICKER}`);
const binding = legBinding(XSTOCK);

const utf8 = new TextEncoder();
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u64le = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
};

const rpc = createSolanaRpc(RPC_URL);
const signer = await createKeyPairSignerFromBytes(
  new Uint8Array(
    JSON.parse(
      await readFile(process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json"), "utf8"),
    ),
  ),
);

const trackerPda = await findTrackerPda(TICKER);
const vault = await findVaultPda(trackerPda);

const { value: ti } = await rpc
  .getAccountInfo(trackerPda, { encoding: "base64", commitment: "confirmed" })
  .send();
const tracker = decodeTracker(Uint8Array.from(Buffer.from(ti.data[0], "base64")));

if (tracker.manager !== signer.address) {
  throw new Error(`${signer.address} is not the manager (${tracker.manager})`);
}

const vaultWsol = await findAssociatedTokenPdaFor(vault, WSOL, TOKEN_PROGRAM);
const vaultLeg = await findAssociatedTokenPdaFor(vault, binding.mint, binding.tokenProgram);

const tokenAmount = async (address) => {
  try {
    const { value } = await rpc.getTokenAccountBalance(address, { commitment: "confirmed" }).send();
    return BigInt(value.amount);
  } catch {
    return null; // no account
  }
};

/**
 * What the vault is worth, in lamports, counting legs it already holds.
 *
 * Sizing off the SOL balance alone is right only for the first swap of a fresh
 * vault. After that the sleeve is no longer the whole fund: buy MCDx with a
 * quarter of a four-leg basket and the remaining SOL is 75% of the fund, so
 * "25% of the sleeve" is 18.75% of the fund and every subsequent leg comes out
 * progressively underweight.
 *
 * Valued the way the program values it: amount / 10^decimals, times the
 * ScaledUiAmount multiplier, times the equity price, divided by the SOL price.
 * Prices come from the same Pyth accounts `value_tokenized_legs` reads, so this
 * agrees with on-chain NAV rather than approximating it.
 */
const priceOf = async (feedIdHex) => {
  const account = await findPythPriceAccount(feedIdHex);
  const { value } = await rpc
    .getAccountInfo(account, { encoding: "base64", commitment: "confirmed" })
    .send();
  if (!value) throw new Error(`no price account for feed ${feedIdHex.slice(0, 8)}`);
  const d = Buffer.from(value.data[0], "base64");
  if (d[40] !== 1) throw new Error("price update is not Full verification");
  return Number(d.readBigInt64LE(73)) * 10 ** d.readInt32LE(89);
};

const SOL_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const { value: vaultLamports } = await rpc.getBalance(vault, { commitment: "confirmed" }).send();
const sleeve = BigInt(vaultLamports) - tracker.rentReserve;

const solPrice = await priceOf(SOL_FEED);
let legValueLamports = 0n;
const held = [];
for (const leg of tracker.legs) {
  const b = Object.values(LEG_BINDINGS).find((x) => x.mint === leg.mint);
  if (!b) continue;
  const ata = await findAssociatedTokenPdaFor(vault, leg.mint, b.tokenProgram);
  const { value } = await rpc
    .getTokenAccountBalance(ata, { commitment: "confirmed" })
    .send()
    .catch(() => ({ value: null }));
  if (!value || value.amount === "0") { held.push({ b, lamports: 0n, amount: 0n }); continue; }
  const price = await priceOf(b.pythFeed);
  const units = Number(value.amount) / 10 ** value.decimals;
  const lamports = BigInt(Math.floor((units * price / solPrice) * 1e9));
  legValueLamports += lamports;
  held.push({ b, lamports, amount: BigInt(value.amount) });
}

const netAssets = sleeve + legValueLamports;

console.log(`${TICKER} -> ${XSTOCK}`);
console.log(`  vault        ${vault}`);
console.log(`  SOL sleeve   ${Number(sleeve) / 1e9} SOL`);
console.log(`  legs held    ${Number(legValueLamports) / 1e9} SOL equivalent`);
console.log(`  net assets   ${Number(netAssets) / 1e9} SOL`);

const weightBps = tracker.legs.find((l) => l.mint === binding.mint)?.weightBps;
if (weightBps === undefined) throw new Error(`${XSTOCK} is not a leg of ${TICKER}`);

/**
 * Buy only the shortfall. A leg already at target is skipped rather than
 * topped up, so re-running this is safe and does not churn the basket through
 * Jupiter for no reason.
 */
const alreadyHeld = held.find((h) => h.b.mint === binding.mint)?.lamports ?? 0n;

/**
 * Lamports the vault keeps back.
 *
 * Not a fee reserve: `redeem_for_sol` pays a holder out of the sleeve, so a
 * vault invested to the last lamport cannot service a redemption at all. The
 * cost is being marginally underweight against the published basket, which is
 * the right trade against a redemption that reverts.
 */
const CUSHION = 3_000_000n; // 0.003 SOL

const target = (netAssets * BigInt(weightBps)) / 10_000n;
const shortfall = target > alreadyHeld ? target - alreadyHeld : 0n;
const spendable = sleeve > CUSHION ? sleeve - CUSHION : 0n;
const amountIn = AMOUNT_ARG
  ? BigInt(AMOUNT_ARG)
  : (shortfall < spendable ? shortfall : spendable);

console.log(`  ${XSTOCK} weight  ${weightBps / 100}%  target ${Number(target) / 1e9} SOL, holds ${Number(alreadyHeld) / 1e9}`);
console.log(`  spending     ${Number(amountIn) / 1e9} SOL  (${amountIn} lamports)`);
if (amountIn <= 0n) {
  console.log(`  ${XSTOCK} is at or above target, nothing to buy`);
  process.exit(0);
}

// The vault's wSOL account must exist before the program can wrap into it:
// `swap_leg` transfers lamports in and calls SyncNative, but creates nothing.
const instructions = [];
if ((await tokenAmount(vaultWsol)) === null) {
  console.log(`  creating the vault's wSOL account ${vaultWsol}`);
  instructions.push({
    programAddress: ATA_PROGRAM,
    accounts: [
      { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: vaultWsol, role: AccountRole.WRITABLE },
      { address: vault, role: AccountRole.READONLY },
      { address: WSOL, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([1]),
  });
}

/**
 * Find a route that fits.
 *
 * `maxAccounts` is a hint, not a guarantee: asking for 28 has returned 39 and
 * 44 on the same pair minutes apart, because the router optimises for output
 * and treats the ceiling as advisory. The program's bound is not advisory, so
 * the only reliable approach is to ask, count, and ask again more tightly.
 *
 * Each attempt is a real quote, so the last one is the one that gets executed
 * and its price is the price. Direct routes are the final fallback: one hop
 * cannot exceed the account budget, at the cost of a possibly worse fill.
 */
const ATTEMPTS = [
  // Direct first. A multi-hop route has to put the intermediate token
  // somewhere, and with `useSharedAccounts: false` that somewhere is an
  // account the vault does not have — which is Jupiter's 0x1789. One hop has
  // no intermediate, so the question does not arise, and it is also the
  // cheapest way to stay under the account bound.
  { onlyDirectRoutes: true, useSharedAccounts: false },
  // Then multi-hop, with Jupiter supplying its own intermediate accounts. The
  // final output still lands in the vault's own destination account, which is
  // what the program checks.
  { maxAccounts: 20, useSharedAccounts: true },
  { maxAccounts: MAX_ROUTE_ACCOUNTS, useSharedAccounts: true },
];

/**
 * The program's hard bound. Exceeding it is `RemainingAccountsMismatch`.
 *
 * 46 is the largest value that fits an SBF stack frame: 72 bytes per slot on a
 * 672-byte base against a 4096-byte cap. See `swap_leg.rs` for the measurement.
 * PEPx's cheapest route is exactly 46 accounts, so this clears it by nothing at
 * all — a route that does not fit is refused before anything is sent.
 */
const PROGRAM_ROUTE_LIMIT = 46;

let quote, route, routeData, built;
for (const [i, attempt] of ATTEMPTS.entries()) {
  const params = new URLSearchParams({
    inputMint: WSOL,
    outputMint: binding.mint,
    amount: String(amountIn),
    slippageBps: String(SLIPPAGE_BPS),
  });
  if (attempt.maxAccounts) params.set("maxAccounts", String(attempt.maxAccounts));
  if (attempt.onlyDirectRoutes) params.set("onlyDirectRoutes", "true");

  const q = await fetch(`${JUP_API}/quote?${params}`).then((r) => r.json());
  if (!q.outAmount) {
    console.log(`  attempt ${i + 1}   no route (${JSON.stringify(attempt)})`);
    continue;
  }

  const b = await fetch(`${JUP_API}/swap-instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: q,
      // The vault is the trader. It cannot sign a transaction; `swap_leg`
      // supplies its signature by seeds.
      userPublicKey: vault,
      // The program wraps and unwraps SOL itself, around the CPI.
      wrapAndUnwrapSol: false,
      useSharedAccounts: attempt.useSharedAccounts ?? false,
      // Jupiter must resolve the vault's token accounts for real. Skipping the
      // lookups makes it assume the classic token program, and every leg here
      // is Token-2022, so it derives a destination that does not exist and the
      // route fails inside Jupiter with 0x1789.
      skipUserAccountsRpcCalls: false,
    }),
  }).then((r) => r.json());

  if (!b.swapInstruction) {
    console.log(`  attempt ${i + 1}   no instruction (${JSON.stringify(attempt)})`);
    continue;
  }

  const n = b.swapInstruction.accounts.length;
  const label = q.routePlan.map((r) => r.swapInfo.label).join(" -> ");
  const ok = n <= PROGRAM_ROUTE_LIMIT;
  console.log(`  attempt ${i + 1}   ${String(n).padStart(2)} accounts  ${label}${ok ? "  <= fits" : "  too many"}`);
  if (!ok) continue;

  quote = q;
  built = b;
  route = b.swapInstruction;
  routeData = Buffer.from(route.data, "base64");
  break;
}

if (!route) {
  console.error(`\n  no route for ${XSTOCK} fits the program's ${PROGRAM_ROUTE_LIMIT}-account bound`);
  process.exit(1);
}
if (route.programId !== JUPITER_PROGRAM) {
  throw new Error(`route targets ${route.programId}, not the pinned Jupiter program`);
}

const minOut = BigInt(quote.otherAmountThreshold);
console.log(`  quote        ${quote.outAmount} base units, impact ${Number(quote.priceImpactPct).toFixed(4)}%`);
console.log(`  floor        ${minOut} base units`);

const roleOf = (a) =>
  a.isSigner
    ? a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
    : a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;

instructions.push({
  programAddress: PROGRAM_ID,
  accounts: [
    { address: signer.address, role: AccountRole.READONLY_SIGNER },
    { address: trackerPda, role: AccountRole.READONLY },
    { address: vault, role: AccountRole.WRITABLE },
    { address: vaultWsol, role: AccountRole.WRITABLE },
    { address: vaultLeg, role: AccountRole.WRITABLE },
    { address: WSOL, role: AccountRole.READONLY },
    { address: binding.mint, role: AccountRole.READONLY },
    { address: binding.tokenProgram, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    { address: JUPITER_PROGRAM, role: AccountRole.READONLY },
    ...route.accounts.map((a) => ({
      address: a.pubkey,
      // Jupiter marks the vault as a signer in its own list. It cannot be one
      // at the outer level: the program signs for it by seeds.
      role:
        a.pubkey === vault
          ? a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY
          : roleOf(a),
    })),
  ],
  data: cat(new Uint8Array([IX_SWAP_LEG]), u64le(amountIn), u64le(minOut), routeData),
});

/**
 * The lookup tables the route uses, resolved to their contents.
 *
 * Compressing against them is not an optimisation here, it is the difference
 * between fitting and not: inlining the route's pubkeys costs ~800 bytes
 * against a 1232-byte transaction.
 *
 * Jupiter returns `addressesByLookupTableAddress` only sometimes. When it does
 * not, `addressLookupTableAddresses` still names the tables, and their contents
 * are read from chain. An ALT account is a 56-byte header followed by packed
 * 32-byte addresses.
 */
const lookupTables = { ...(built.addressesByLookupTableAddress ?? {}) };
const named = built.addressLookupTableAddresses ?? [];
const missing = named.filter((t) => !lookupTables[t]);
if (missing.length) {
  const { value } = await rpc
    .getMultipleAccounts(missing, { encoding: "base64", commitment: "confirmed" })
    .send();
  const { getAddressDecoder } = await import("@solana/kit");
  const decoder = getAddressDecoder();
  value.forEach((info, i) => {
    if (!info) return;
    const d = Buffer.from(info.data[0], "base64");
    const addresses = [];
    for (let o = 56; o + 32 <= d.length; o += 32) {
      addresses.push(decoder.decode(d.subarray(o, o + 32)));
    }
    lookupTables[missing[i]] = addresses;
  });
}
console.log(`  lookup tbls  ${Object.keys(lookupTables).length}`);

const legBefore = await tokenAmount(vaultLeg);

const { value: blockhash } = await rpc.getLatestBlockhash().send();
let message = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(signer, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
  (m) => appendTransactionMessageInstructions(instructions, m),
  (m) => addSignersToTransactionMessage([signer], m),
);
if (Object.keys(lookupTables).length) {
  message = compressTransactionMessageUsingAddressLookupTables(message, lookupTables);
}
const signed = await signTransactionMessageWithSigners(message);
const wire = getBase64EncodedWireTransaction(signed);
console.log(`  tx size      ${Buffer.from(wire, "base64").length} bytes of 1232`);

const { value: sim } = await rpc
  .simulateTransaction(wire, {
    encoding: "base64",
    commitment: "confirmed",
    replaceRecentBlockhash: false,
    sigVerify: true,
  })
  .send();
if (sim.err) {
  // BigInts appear inside instruction errors, and JSON.stringify throws on
  // them — which would hide the very error this is here to print.
  const show = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
  console.error(`\nSIMULATION FAILED ${show(sim.err)}`);
  for (const l of sim.logs ?? []) console.error(`    ${l}`);
  process.exit(1);
}
console.log(`  simulated    ok, ${sim.unitsConsumed} CU`);

if (!SEND) {
  console.log(`\nsimulation clean. SEND=1 to execute.`);
  process.exit(0);
}

const sig = getSignatureFromTransaction(signed);
await rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
for (let i = 0; i < 60; i++) {
  const { value } = await rpc.getSignatureStatuses([sig]).send();
  if (value[0]?.err) throw new Error(`failed: ${JSON.stringify(value[0].err)}`);
  if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") break;
  await new Promise((r) => setTimeout(r, 1000));
}

const legAfter = await tokenAmount(vaultLeg);
const { value: lamportsAfter } = await rpc.getBalance(vault, { commitment: "confirmed" }).send();
console.log(`\n  tx           ${sig}`);
console.log(`  received     ${legAfter - (legBefore ?? 0n)} ${XSTOCK} base units`);
console.log(`  vault holds  ${legAfter} ${XSTOCK}, ${Number(BigInt(lamportsAfter) - tracker.rentReserve) / 1e9} SOL`);
