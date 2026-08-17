/**
 * Vault operations shared by the one-off swap CLI and the keeper.
 *
 * Both need the same three things: what a vault is worth and holds, how to
 * route one leg through Jupiter, and how to send that route through
 * `swap_leg`. Keeping one copy matters more here than usual — the two callers
 * trade real money, and a fix applied to one and not the other is a fix that
 * looks applied.
 */

import {
  AccountRole,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

import { LEG_BINDINGS } from "../../src/lib/leg-bindings.ts";
import { decodeTracker, findTrackerPda, findVaultPda } from "../../src/lib/vault/program.ts";
import { findAssociatedTokenPdaFor, findPythPriceAccount } from "../../src/lib/vault/oracle.ts";

export const PROGRAM_ID = "7Z3DAC8q4vgFr2ofxXonHT2jgJx3xk1bmQHsRjUmVAnY";
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const JUP_API = "https://lite-api.jup.ag/swap/v1";
export const WSOL = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const IX_SWAP_LEG = 5;
export const SOL_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/**
 * The program's bound on forwarded route accounts.
 *
 * 46 is the measured stack ceiling — 72 bytes per slot on a 672-byte base
 * against a 4096-byte frame. See `swap_leg.rs`.
 */
export const PROGRAM_ROUTE_LIMIT = 46;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a call that was throttled.
 *
 * The keeper reads a few dozen accounts per pass and does it in a burst, which
 * a shared endpoint answers with 429 rather than an error worth reporting.
 * Honours `retry-after` when one is sent, and backs off otherwise.
 */
export async function rpcRetry(fn, attempts = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const throttled =
        e?.context?.statusCode === 429 || String(e?.message ?? "").includes("429");
      if (!throttled || i >= attempts - 1) throw e;
      const after = Number(e?.context?.headers?.get?.("retry-after") ?? 0);
      await sleep(after > 0 ? after * 1000 : 400 * 2 ** i);
    }
  }
}

export const bindingOf = (mint) =>
  Object.values(LEG_BINDINGS).find((b) => b.mint === mint) ?? null;

/** A Pyth price, read the way the program reads it. */
export async function readPrice(rpc, feedHex) {
  const account = await findPythPriceAccount(feedHex);
  const { value } = await rpcRetry(() =>
    rpc.getAccountInfo(account, { encoding: "base64", commitment: "confirmed" }).send(),
  );
  if (!value) throw new Error(`no price account for ${feedHex.slice(0, 8)}`);
  const d = Buffer.from(value.data[0], "base64");
  if (d[40] !== 1) throw new Error("price update is not Full verification");
  return Number(d.readBigInt64LE(73)) * 10 ** d.readInt32LE(89);
}

/**
 * Everything about a vault the keeper reasons over.
 *
 * `netAssets` counts the legs, not just the sleeve. Sizing off the sleeve alone
 * is right only for the first trade of a fresh vault; after that it makes every
 * subsequent leg progressively underweight.
 */
export async function readVault(rpc, ticker) {
  const trackerAddress = await findTrackerPda(ticker);
  const vault = await findVaultPda(trackerAddress);

  const { value: info } = await rpcRetry(() =>
    rpc.getAccountInfo(trackerAddress, { encoding: "base64", commitment: "confirmed" }).send(),
  );
  if (!info) return null;
  const tracker = decodeTracker(Uint8Array.from(Buffer.from(info.data[0], "base64")));

  const { value: lamports } = await rpcRetry(() =>
    rpc.getBalance(vault, { commitment: "confirmed" }).send(),
  );
  const sleeve = BigInt(lamports) - tracker.rentReserve;
  const solPrice = await readPrice(rpc, SOL_FEED);

  const legs = [];
  let legLamports = 0n;
  for (const leg of tracker.legs) {
    const b = bindingOf(leg.mint);
    if (!b) continue;
    const ata = await findAssociatedTokenPdaFor(vault, leg.mint, b.tokenProgram);
    const bal = await rpcRetry(() =>
      rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send(),
    ).catch(() => ({ value: null }));

    const amount = bal.value ? BigInt(bal.value.amount) : 0n;
    const decimals = bal.value ? bal.value.decimals : 8;
    const price = amount > 0n ? await readPrice(rpc, b.pythFeed) : 0;
    const lamportsValue =
      amount > 0n
        ? BigInt(Math.floor(((Number(amount) / 10 ** decimals) * price / solPrice) * 1e9))
        : 0n;
    legLamports += lamportsValue;
    legs.push({ binding: b, weightBps: leg.weightBps, ata, amount, decimals, lamports: lamportsValue, price });
  }

  return {
    ticker,
    trackerAddress,
    vault,
    tracker,
    sleeve,
    legs,
    legLamports,
    netAssets: sleeve + legLamports,
    solPrice,
  };
}

/**
 * A Jupiter route that fits the program's account bound.
 *
 * `maxAccounts` is advisory — asking for 28 has returned 39 and 44 on the same
 * pair minutes apart — so this quotes, counts, and re-quotes tighter until one
 * fits. Direct routes come first: a second hop needs somewhere to hold the
 * intermediate token, and with `useSharedAccounts: false` that is an account
 * the vault does not have, which Jupiter reports as 0x1789.
 */
export async function planRoute({ vault, inputMint, outputMint, amountIn, slippageBps = 300 }) {
  const attempts = [
    { onlyDirectRoutes: true, useSharedAccounts: false },
    { maxAccounts: 20, useSharedAccounts: true },
    { maxAccounts: 28, useSharedAccounts: true },
  ];

  for (const attempt of attempts) {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: String(amountIn),
      slippageBps: String(slippageBps),
    });
    if (attempt.maxAccounts) params.set("maxAccounts", String(attempt.maxAccounts));
    if (attempt.onlyDirectRoutes) params.set("onlyDirectRoutes", "true");

    const quote = await fetch(`${JUP_API}/quote?${params}`).then((r) => r.json());
    if (!quote?.outAmount) continue;

    const built = await fetch(`${JUP_API}/swap-instructions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: vault,
        // The program wraps and unwraps SOL itself, around the CPI.
        wrapAndUnwrapSol: false,
        useSharedAccounts: attempt.useSharedAccounts ?? false,
        skipUserAccountsRpcCalls: false,
      }),
    }).then((r) => r.json());

    if (!built?.swapInstruction) continue;
    if (built.swapInstruction.programId !== JUPITER_PROGRAM) continue;
    if (built.swapInstruction.accounts.length > PROGRAM_ROUTE_LIMIT) continue;

    return {
      quote,
      route: built.swapInstruction,
      routeData: Buffer.from(built.swapInstruction.data, "base64"),
      minOut: BigInt(quote.otherAmountThreshold ?? quote.outAmount),
      label: (quote.routePlan ?? []).map((r) => r.swapInfo.label).join(" -> "),
      lookupTableNames: built.addressLookupTableAddresses ?? [],
      lookupTables: { ...(built.addressesByLookupTableAddress ?? {}) },
    };
  }
  return null;
}

/** Read lookup tables Jupiter named but did not inline. */
export async function resolveLookupTables(rpc, plan) {
  const missing = plan.lookupTableNames.filter((t) => !plan.lookupTables[t]);
  if (missing.length === 0) return plan.lookupTables;

  const { value } = await rpcRetry(() =>
    rpc.getMultipleAccounts(missing, { encoding: "base64", commitment: "confirmed" }).send(),
  );
  const decoder = getAddressDecoder();
  value.forEach((info, i) => {
    if (!info) return;
    const d = Buffer.from(info.data[0], "base64");
    const list = [];
    for (let o = 56; o + 32 <= d.length; o += 32) list.push(decoder.decode(d.subarray(o, o + 32)));
    plan.lookupTables[missing[i]] = list;
  });
  return plan.lookupTables;
}

const roleOf = (a) =>
  a.isSigner
    ? a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
    : a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;

/**
 * `swap_leg`, either direction.
 *
 * Selling into the sleeve is always allowed; only buys are checked against the
 * published basket, so a leg that has been dropped from the basket can still be
 * exited.
 */
export function ixSwapLeg({
  manager, trackerAddress, vault, sourceTa, destinationTa,
  sourceMint, destinationMint, tokenProgram, amountIn, minOut, routeData, routeAccounts,
}) {
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: manager, role: AccountRole.READONLY_SIGNER },
      { address: trackerAddress, role: AccountRole.READONLY },
      { address: vault, role: AccountRole.WRITABLE },
      { address: sourceTa, role: AccountRole.WRITABLE },
      { address: destinationTa, role: AccountRole.WRITABLE },
      { address: sourceMint, role: AccountRole.READONLY },
      { address: destinationMint, role: AccountRole.READONLY },
      { address: tokenProgram, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: JUPITER_PROGRAM, role: AccountRole.READONLY },
      ...routeAccounts.map((a) => ({
        address: a.pubkey,
        // The vault cannot sign a transaction; the program supplies its
        // signature by seeds, so it must not be a signer at the outer level.
        role:
          a.pubkey === vault
            ? a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY
            : roleOf(a),
      })),
    ],
    data: cat(new Uint8Array([IX_SWAP_LEG]), u64le(amountIn), u64le(minOut), routeData),
  };
}

export function ixCreateAta({ payer, owner, mint, ata, tokenProgram }) {
  return {
    programAddress: ATA_PROGRAM,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: ata, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: tokenProgram, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([1]),
  };
}

/**
 * Simulate, then optionally send.
 *
 * Always simulates. A swap that would fail costs nothing to discover here and
 * real money to discover on chain, and the keeper runs unattended.
 */
export async function sendOrSimulate({ rpc, signer, instructions, lookupTables, send }) {
  const { value: blockhash } = await rpcRetry(() => rpc.getLatestBlockhash().send());
  let message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => addSignersToTransactionMessage([signer], m),
  );
  if (lookupTables && Object.keys(lookupTables).length > 0) {
    message = compressTransactionMessageUsingAddressLookupTables(message, lookupTables);
  }

  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const bytes = Buffer.from(wire, "base64").length;

  const { value: sim } = await rpcRetry(() =>
    rpc.simulateTransaction(wire, {
      encoding: "base64",
      commitment: "confirmed",
      replaceRecentBlockhash: false,
      sigVerify: true,
    }).send(),
  );
  if (sim.err) {
    const show = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
    return { ok: false, bytes, error: show(sim.err), logs: sim.logs ?? [] };
  }
  if (!send) return { ok: true, bytes, cu: sim.unitsConsumed, signature: null };

  const signature = getSignatureFromTransaction(signed);
  await rpcRetry(() =>
    rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send(),
  );
  for (let i = 0; i < 60; i++) {
    const { value } = await rpcRetry(() => rpc.getSignatureStatuses([signature]).send());
    if (value[0]?.err) return { ok: false, bytes, error: JSON.stringify(value[0].err), logs: [] };
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") {
      return { ok: true, bytes, cu: sim.unitsConsumed, signature };
    }
    await sleep(1000);
  }
  return { ok: false, bytes, error: "timed out confirming", logs: [] };
}

export { cat, u64le, sleep };
