/**
 * End-to-end smoke test for the Pinocchio program on devnet.
 *
 *   node scripts/pin-smoke.mjs
 *
 * Drives the real deployed binary through the whole lifecycle — create, fund,
 * price, pause, rebalance, redeem, close — and asserts the invariants that
 * matter after every step. The differential suite proves the port matches
 * Anchor inside LiteSVM; this proves the artifact actually deployed does the
 * same thing against a real validator.
 *
 * Deliberately uses a throwaway ticker so it can be re-run, and closes the
 * tracker at the end so the rent comes back.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  AccountRole,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getProgramDerivedAddress,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID =
  process.env.PIN_PROGRAM_ID ?? "7Z3DAC8q4vgFr2ofxXonHT2jgJx3xk1bmQHsRjUmVAnY";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// A fresh ticker per run, because `close_tracker` is permanent for a ticker:
// it deliberately leaves the share mint in place (immutable at zero supply), so
// `initialize_tracker` afterwards fails `require_uninitialized` on the mint with
// InvalidAccountOwner (6040). Retiring a tracker burns its ticker forever —
// worth knowing before picking production ones.
const TICKER =
  process.env.TICKER ?? `pin${Math.floor(Math.random() * 1e6).toString(36)}`;
// Sized at the protocol ceiling so the 16-leg regression below has room: the
// account is allocated for `max_legs` at init and never reallocated, so a
// rebalance past it is rejected with LegCapacityExceeded (6035) — which is the
// program behaving correctly, not a payload-size problem.
const MAX_LEGS = 16;

// One-byte discriminators, mirroring `Instruction` in the port's lib.rs.
const IX = {
  INITIALIZE_TRACKER: 0,
  DEPOSIT: 1,
  REDEEM_FOR_SOL: 2,
  REDEEM_IN_KIND: 3,
  REBALANCE: 4,
  SWAP_LEG: 5,
  SET_TOKEN_METADATA: 6,
  SET_PAUSED: 7,
  SET_FEES: 8,
  EMERGENCY_WITHDRAW_SOL: 9,
  EMERGENCY_WITHDRAW_TOKEN: 10,
  SET_AUTHORITY: 11,
  SET_MANAGER: 12,
  CLOSE_TRACKER: 13,
};

const utf8 = new TextEncoder();
const addrEnc = getAddressEncoder();
const bytes = (a) => new Uint8Array(addrEnc.encode(a));
const pda = async (programAddress, seeds) =>
  (await getProgramDerivedAddress({ programAddress, seeds }))[0];

const u16le = (n) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
};
const u64le = (n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};
const cat = (...parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// ---------------------------------------------------------------------------

const secret = JSON.parse(
  await readFile(
    process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json"),
    "utf8",
  ),
);
const signer = await createKeyPairSignerFromBytes(new Uint8Array(secret));

const tracker = await pda(PROGRAM_ID, [utf8.encode("tracker"), utf8.encode(TICKER)]);
const trackerSeed = bytes(tracker);
const vault = await pda(PROGRAM_ID, [utf8.encode("vault"), trackerSeed]);
const mint = await pda(PROGRAM_ID, [utf8.encode("share"), trackerSeed]);
const ata = await pda(ATA_PROGRAM, [
  bytes(signer.address),
  bytes(TOKEN_PROGRAM),
  bytes(mint),
]);

const rpc = createSolanaRpc(RPC_URL);

// Confirmation by polling rather than by websocket subscription. The public
// devnet endpoint throttles subscriptions hard, and a dropped socket surfaces
// as an unrelated AbortError that looks like a program failure.
async function confirm(signature) {
  for (let i = 0; i < 60; i++) {
    const { value } = await withRetry(() =>
      rpc.getSignatureStatuses([signature]).send(),
    );
    const status = value[0];
    if (status?.err) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return;
    }
    await sleep(1000);
  }
  throw new Error(`timed out confirming ${signature}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True for the public devnet endpoint's rate limiter, which is not a failure. */
const isRateLimit = (e) =>
  e?.context?.statusCode === 429 ||
  String(e?.message ?? "").includes("429") ||
  String(e?.cause?.message ?? "").includes("429");

/** Retry a whole step on 429 with linear backoff. */
async function withRetry(fn, attempts = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimit(e) || i >= attempts - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

async function send(label, instructions) {
  return withRetry(() => sendOnce(label, instructions));
}

async function sendOnce(label, instructions) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => addSignersToTransactionMessage([signer], m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const sig = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: "base64",
      preflightCommitment: "confirmed",
    })
    .send();
  await confirm(sig);
  console.log(`  ✓ ${label}  ${sig}`);
  return sig;
}

/** Expect a transaction to be rejected, and report why. */
async function expectFailure(label, instructions) {
  try {
    await withRetry(() => sendOnce(label, instructions));
  } catch (e) {
    // Kit nests the program error one level down and fills the envelope with
    // bigints, so `JSON.stringify` throws before it can be searched.
    const code = e?.cause?.context?.code ?? e?.context?.code ?? null;
    const logs = e?.context?.logs ?? [];
    console.log(`  ✓ ${label} rejected${code ? ` (custom ${code})` : ""}`);
    if (code == null && logs.length) console.log(`      ${logs.at(-1)}`);
    return code == null ? null : Number(code);
  }
  throw new Error(`${label}: expected rejection, transaction succeeded`);
}

// ---- tracker decoding, the port's fixed layout ----------------------------

const T = {
  PAUSED: 3,
  MAX_LEGS: 7,
  LEG_COUNT: 8,
  AUTHORITY: 22,
  MANAGER: 54,
  RENT_RESERVE: 150,
  DEPOSIT_FEE_PPM: 158,
  REDEEM_FEE_PPM: 160,
  LEGS: 170,
  LEG_SIZE: 66,
};

async function readTracker() {
  const { value } = await withRetry(() =>
    rpc
      .getAccountInfo(tracker, { encoding: "base64", commitment: "confirmed" })
      .send(),
  );
  if (!value) return null;
  const d = Buffer.from(value.data[0], "base64");
  return {
    tag: d[0],
    version: d[1],
    paused: d[T.PAUSED] !== 0,
    maxLegs: d[T.MAX_LEGS],
    legCount: d[T.LEG_COUNT],
    rentReserve: d.readBigUInt64LE(T.RENT_RESERVE),
    depositFeePpm: d.readUInt16LE(T.DEPOSIT_FEE_PPM),
    redeemFeePpm: d.readUInt16LE(T.REDEEM_FEE_PPM),
  };
}

// Kit returns `Lamports`, which is a bigint. Normalised here so every
// comparison below is bigint-to-bigint — mixing them silently fails `===`.
const lamportsOf = async (a) =>
  withRetry(async () =>
    BigInt((await rpc.getBalance(a, { commitment: "confirmed" }).send()).value),
  );

async function shareBalance() {
  try {
    const { value } = await withRetry(() =>
      rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send(),
    );
    return BigInt(value.amount);
  } catch (e) {
    if (isRateLimit(e)) throw e;
    return 0n;
  }
}

async function supply() {
  const { value } = await withRetry(() =>
    rpc.getTokenSupply(mint, { commitment: "confirmed" }).send(),
  );
  return BigInt(value.amount);
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
};

// ---- instruction builders -------------------------------------------------

const ixInitialize = (depositPpm, redeemPpm, legs) => {
  const tickerBytes = utf8.encode(TICKER);
  const padded = new Uint8Array(12);
  padded.set(tickerBytes);
  // 34 bytes per leg: mint || weight. Feed ids travel separately via
  // set_leg_feed, which is what keeps a full 16-leg basket inside a
  // transaction.
  const legBytes = legs.flatMap((l) => [l.mint, u16le(l.weightBps)]);
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: signer.address, role: AccountRole.READONLY }, // fee_recipient
      { address: tracker, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.WRITABLE },
      { address: vault, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    data: cat(
      new Uint8Array([IX.INITIALIZE_TRACKER, 0, MAX_LEGS]),
      u16le(depositPpm),
      u16le(redeemPpm),
      new Uint8Array([tickerBytes.length]),
      padded,
      new Uint8Array([legs.length]),
      ...legBytes,
    ),
  };
};

const ixCreateAta = () => ({
  programAddress: ATA_PROGRAM,
  accounts: [
    { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
    { address: ata, role: AccountRole.WRITABLE },
    { address: signer.address, role: AccountRole.READONLY },
    { address: mint, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
  ],
  data: new Uint8Array([1]), // CreateIdempotent
});

const moneyAccounts = () => [
  { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
  { address: tracker, role: AccountRole.WRITABLE },
  { address: mint, role: AccountRole.WRITABLE },
  { address: vault, role: AccountRole.WRITABLE },
  { address: signer.address, role: AccountRole.WRITABLE }, // fee_recipient
  { address: ata, role: AccountRole.WRITABLE },
  { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
  { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
];

const ixDeposit = (lamports, minShares = 0) => ({
  programAddress: PROGRAM_ID,
  accounts: moneyAccounts(),
  data: cat(new Uint8Array([IX.DEPOSIT]), u64le(lamports), u64le(minShares)),
});

const ixRedeem = (shares, minLamports = 0) => ({
  programAddress: PROGRAM_ID,
  accounts: moneyAccounts(),
  data: cat(new Uint8Array([IX.REDEEM_FOR_SOL]), u64le(shares), u64le(minLamports)),
});

const adminAccounts = () => [
  { address: signer.address, role: AccountRole.READONLY_SIGNER },
  { address: tracker, role: AccountRole.WRITABLE },
];

const ixSetPaused = (paused) => ({
  programAddress: PROGRAM_ID,
  accounts: adminAccounts(),
  data: new Uint8Array([IX.SET_PAUSED, paused ? 1 : 0]),
});

const ixSetFees = (d, r) => ({
  programAddress: PROGRAM_ID,
  accounts: adminAccounts(),
  data: cat(new Uint8Array([IX.SET_FEES]), u16le(d), u16le(r)),
});

const ixRebalance = (legs) => ({
  programAddress: PROGRAM_ID,
  accounts: adminAccounts(),
  data: cat(
    new Uint8Array([IX.REBALANCE, legs.length]),
    ...legs.flatMap((l) => [l.mint, u16le(l.weightBps)]),
  ),
});

const ixCloseTracker = () => ({
  programAddress: PROGRAM_ID,
  accounts: [
    { address: signer.address, role: AccountRole.READONLY_SIGNER },
    { address: signer.address, role: AccountRole.WRITABLE }, // rent_destination
    { address: tracker, role: AccountRole.WRITABLE },
    { address: mint, role: AccountRole.READONLY },
    { address: vault, role: AccountRole.WRITABLE },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
  ],
  data: new Uint8Array([IX.CLOSE_TRACKER]),
});

// A sleeve-only basket: no tokenized equivalent yet, so no oracle accounts are
// needed and valuation is pure lamports — exactly the devnet situation.
const zero = new Uint8Array(32);
const sleeveBasket = [
  { mint: zero, weightBps: 6000 },
  { mint: zero, weightBps: 4000 },
];
const sleeveBasket3 = [
  { mint: zero, weightBps: 5000 },
  { mint: zero, weightBps: 3000 },
  { mint: zero, weightBps: 2000 },
];
/** The basket that used to be unsendable: sixteen legs, 546 bytes of payload. */
const maximalBasket = Array.from({ length: 16 }, (_, i) => ({
  mint: zero,
  weightBps: i === 0 ? 10_000 - 15 * 625 : 625,
}));

// ---------------------------------------------------------------------------

const SOL = 1_000_000_000n;
console.log(`\nPinocchio devnet smoke test`);
console.log(`  program  ${PROGRAM_ID}`);
console.log(`  payer    ${signer.address}`);
console.log(`  ticker   ${TICKER}\n`);

if (await readTracker()) {
  throw new Error(`${TICKER} already exists — pick another ticker`);
}

const startBalance = await lamportsOf(signer.address);

console.log("1. create");
await send("initialize_tracker", [ixInitialize(2500, 2500, sleeveBasket)]);
let t = await readTracker();
assert(t.tag === 1, `tag should be 1, got ${t.tag}`);
assert(t.version === 1, `version should be 1, got ${t.version}`);
assert(t.legCount === 2, `legCount should be 2, got ${t.legCount}`);
assert(t.maxLegs === MAX_LEGS, "maxLegs");
assert(t.depositFeePpm === 2500, "deposit fee");
assert(!t.paused, "starts unpaused");
assert((await supply()) === 0n, "supply starts at zero");
const reserve = t.rentReserve;
assert((await lamportsOf(vault)) === reserve, "vault holds only the reserve");
console.log(`     reserve ${reserve} lamports, net assets 0 — NAV undefined, correct`);

console.log("2. deposit");
await send("create ATA", [ixCreateAta()]);
await send("deposit 0.05 SOL", [ixDeposit(50_000_000n)]);
const shares = await shareBalance();
// 0.25% of 50_000_000 is 125_000
assert(shares === 49_875_000n, `genesis shares should be 49_875_000, got ${shares}`);
assert((await supply()) === shares, "supply equals holder balance");
const netAssets = (await lamportsOf(vault)) - reserve;
assert(netAssets === shares, `NAV must be exactly 1.0, got ${netAssets}/${shares}`);
console.log(`     ${shares} shares, ${netAssets} lamports — NAV exactly 1.0`);

console.log("3. NAV holds across a second deposit");
await send("deposit 0.02 SOL", [ixDeposit(20_000_000n)]);
const s2 = await supply();
const a2 = (await lamportsOf(vault)) - reserve;
assert(a2 === s2, `NAV drifted: ${a2}/${s2}`);
console.log(`     ${s2} shares, ${a2} lamports — still exactly 1.0`);

console.log("4. pause halts deposits, never redemption");
await send("set_paused(true)", [ixSetPaused(true)]);
assert((await readTracker()).paused, "should be paused");
const code = await expectFailure("deposit while paused", [ixDeposit(1_000_000n)]);
assert(code === null || code === 6008, `expected TrackerPaused (6008), got ${code}`);
await send("redeem 1000 shares while paused", [ixRedeem(1000n)]);
console.log("     redemption works while paused — holders are never trapped");
await send("set_paused(false)", [ixSetPaused(false)]);

console.log("5. admin");
await send("set_fees(100, 200)", [ixSetFees(100, 200)]);
t = await readTracker();
assert(t.depositFeePpm === 100 && t.redeemFeePpm === 200, "fees updated");
await expectFailure("set_fees above the 3% cap", [ixSetFees(30_001, 10)]);
await send("rebalance to 3 legs", [ixRebalance(sleeveBasket3)]);
assert((await readTracker()).legCount === 3, "leg count should be 3");
await expectFailure("rebalance to weights that do not sum to 100%", [
  ixRebalance([{ mint: zero, weightBps: 5000 }]),
]);
assert((await readTracker()).legCount === 3, "rejected rebalance must not corrupt the basket");
// The regression this whole redeploy was for.
await send("rebalance to a maximal 16-leg basket", [ixRebalance(maximalBasket)]);
assert((await readTracker()).legCount === 16, "16 legs must fit one transaction");
await send("rebalance back to 3 legs", [ixRebalance(sleeveBasket3)]);
console.log("     fee cap holds, bad basket rejected, 16-leg basket fits");

console.log("6. redeem everything");
await send("set_fees(0, 0)", [ixSetFees(0, 0)]);
const remaining = await shareBalance();
await send(`redeem ${remaining} shares`, [ixRedeem(remaining)]);
assert((await supply()) === 0n, "supply should be zero");
assert((await shareBalance()) === 0n, "holder should be empty");
const vaultLeft = await lamportsOf(vault);
assert(vaultLeft === reserve, `vault should hold exactly the reserve, got ${vaultLeft}`);
console.log(`     vault drained to its ${reserve}-lamport reserve, not below`);

console.log("7. close");
await send("close_tracker", [ixCloseTracker()]);
assert((await readTracker()) === null, "tracker account should be gone");
const endBalance = await lamportsOf(signer.address);
console.log(
  `     rent returned; net cost of the whole run: ${Number(startBalance - endBalance) / 1e9} SOL`,
);

console.log("\nAll checks passed.\n");
