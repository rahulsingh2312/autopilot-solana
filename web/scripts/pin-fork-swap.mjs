/**
 * `swap_leg` against a real Jupiter route, on a mainnet fork.
 *
 *   RPC_URL=http://127.0.0.1:9500 node scripts/pin-fork-swap.mjs
 *
 * # What this is testing
 *
 * `swap_leg` deliberately does not understand the route. It pins the Jupiter
 * program id, asserts both token accounts belong to the vault, asserts the
 * destination is a published leg, and then brackets an opaque CPI with
 * before/after balance reads. Everything it protects is measured, not parsed.
 *
 * None of that can be tested without a real route: the instruction data is
 * whatever Jupiter's aggregator emits, and the account list is whatever pools
 * it picked. So this fetches a live quote for wSOL -> NVDAx, asks Jupiter for
 * the instruction, and forwards it through the vault — which signs as a PDA,
 * by seeds, for a program that has no idea a PDA is involved.
 *
 * # Two things that make this awkward, both real
 *
 * **Address lookup tables.** A Jupiter route references ~25 accounts and ships
 * an ALT. Inlining them costs 800 bytes and blows the transaction limit once
 * `swap_leg`'s own ten accounts are added, so the transaction has to be v0 and
 * compressed against the same table Jupiter returned.
 *
 * **wSOL is classic SPL Token.** The vault's sleeve is native lamports, so a
 * buy has to wrap into a wSOL account first. That account is owned by the
 * original token program even though every leg is Token-2022 — which is
 * exactly the mix-up this test was written to catch.
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
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:9500";
const PROGRAM_ID =
  process.env.PIN_PROGRAM_ID ?? "7Z3DAC8q4vgFr2ofxXonHT2jgJx3xk1bmQHsRjUmVAnY";
const JUP_API = "https://lite-api.jup.ag/swap/v1";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

const WSOL = "So11111111111111111111111111111111111111112";
const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";

const TICKER = process.env.TICKER ?? `sw${Math.floor(Math.random() * 1e6).toString(36)}`;
const IX = { INITIALIZE_TRACKER: 0, SWAP_LEG: 5 };

const utf8 = new TextEncoder();
const addrEnc = getAddressEncoder();
const bytes = (a) => new Uint8Array(addrEnc.encode(a));
const pda = async (p, seeds) =>
  (await getProgramDerivedAddress({ programAddress: p, seeds }))[0];
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
const cat = (...p) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const assert = (c, m) => {
  if (!c) throw new Error(`ASSERTION FAILED: ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const secret = JSON.parse(
  await readFile(
    process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json"),
    "utf8",
  ),
);
const signer = await createKeyPairSignerFromBytes(new Uint8Array(secret));
const rpc = createSolanaRpc(RPC_URL);

const tracker = await pda(PROGRAM_ID, [utf8.encode("tracker"), utf8.encode(TICKER)]);
const trackerSeed = bytes(tracker);
const vault = await pda(PROGRAM_ID, [utf8.encode("vault"), trackerSeed]);
const shareMint = await pda(PROGRAM_ID, [utf8.encode("share"), trackerSeed]);
const vaultWsol = await pda(ATA_PROGRAM, [bytes(vault), bytes(TOKEN_PROGRAM), bytes(WSOL)]);
const vaultNvdax = await pda(ATA_PROGRAM, [
  bytes(vault),
  bytes(TOKEN_2022_PROGRAM),
  bytes(NVDAX),
]);

async function cheat(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());
  if (res.error) throw new Error(`${method}: ${JSON.stringify(res.error)}`);
  return res.result;
}

async function confirm(sig) {
  for (let i = 0; i < 80; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    if (value[0]?.err) throw new Error(`failed: ${JSON.stringify(value[0].err)}`);
    if (value[0]?.confirmationStatus) return;
    await sleep(300);
  }
  throw new Error(`timed out confirming ${sig}`);
}

async function send(label, instructions, lookupTables) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  let message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => addSignersToTransactionMessage([signer], m),
  );
  if (lookupTables) {
    message = compressTransactionMessageUsingAddressLookupTables(message, lookupTables);
  }
  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const sig = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(wire, { encoding: "base64", preflightCommitment: "processed" })
    .send();
  await confirm(sig);
  console.log(`  ✓ ${label}`);
  return sig;
}

const tokenAmount = async (a) => {
  try {
    const { value } = await rpc
      .getTokenAccountBalance(a, { commitment: "processed" })
      .send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
};
const lamportsOf = async (a) =>
  BigInt((await rpc.getBalance(a, { commitment: "processed" }).send()).value);

// ---- instructions ---------------------------------------------------------

const ixInitialize = (legs) => {
  const t = utf8.encode(TICKER);
  const padded = new Uint8Array(12);
  padded.set(t);
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: signer.address, role: AccountRole.READONLY },
      { address: tracker, role: AccountRole.WRITABLE },
      { address: shareMint, role: AccountRole.WRITABLE },
      { address: vault, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    data: cat(
      new Uint8Array([IX.INITIALIZE_TRACKER, 0, 4]),
      u16le(0),
      u16le(0),
      new Uint8Array([t.length]),
      padded,
      new Uint8Array([legs.length]),
      ...legs.flatMap((l) => [l.mint, u16le(l.weightBps)]),
    ),
  };
};

const ixCreateAta = (owner, mint, ata, tokenProgram) => ({
  programAddress: ATA_PROGRAM,
  accounts: [
    { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
    { address: ata, role: AccountRole.WRITABLE },
    { address: owner, role: AccountRole.READONLY },
    { address: mint, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    { address: tokenProgram, role: AccountRole.READONLY },
  ],
  data: new Uint8Array([1]),
});

const roleOf = (a) =>
  a.isSigner
    ? a.isWritable
      ? AccountRole.WRITABLE_SIGNER
      : AccountRole.READONLY_SIGNER
    : a.isWritable
      ? AccountRole.WRITABLE
      : AccountRole.READONLY;

/**
 * `swap_leg(amount_in, min_amount_out, route_data)`.
 *
 * The route's accounts are appended verbatim. Jupiter marks the vault as a
 * signer in its own list; the program re-derives that flag itself and supplies
 * the signature by seeds, so the vault is passed here as a plain account.
 */
const ixSwapLeg = (amountIn, minOut, routeData, routeAccounts) => ({
  programAddress: PROGRAM_ID,
  accounts: [
    { address: signer.address, role: AccountRole.READONLY_SIGNER }, // manager
    { address: tracker, role: AccountRole.READONLY },
    { address: vault, role: AccountRole.WRITABLE },
    { address: vaultWsol, role: AccountRole.WRITABLE },
    { address: vaultNvdax, role: AccountRole.WRITABLE },
    { address: WSOL, role: AccountRole.READONLY },
    { address: NVDAX, role: AccountRole.READONLY },
    { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    { address: JUPITER_PROGRAM, role: AccountRole.READONLY },
    ...routeAccounts.map((a) => ({
      address: a.pubkey,
      // The vault cannot sign a transaction; swap_leg supplies its signature
      // by seeds, so it must not be marked a signer at the outer level.
      role: a.pubkey === vault ? (a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY) : roleOf(a),
    })),
  ],
  data: cat(new Uint8Array([IX.SWAP_LEG]), u64le(amountIn), u64le(minOut), routeData),
});

// ---------------------------------------------------------------------------

const AMOUNT_IN = 100_000_000n; // 0.1 SOL

console.log(`\nswap_leg against a real Jupiter route`);
console.log(`  rpc      ${RPC_URL}`);
console.log(`  ticker   ${TICKER}`);
console.log(`  vault    ${vault}\n`);

console.log("1. a tracker holding NVDAx");
await send("initialize_tracker", [
  ixInitialize([
    { mint: bytes(NVDAX), weightBps: 6000 },
    { mint: new Uint8Array(32), weightBps: 4000 },
  ]),
]);
await send("create vault wSOL (classic) + NVDAx (Token-2022) ATAs", [
  ixCreateAta(vault, WSOL, vaultWsol, TOKEN_PROGRAM),
  ixCreateAta(vault, NVDAX, vaultNvdax, TOKEN_2022_PROGRAM),
]);

// The vault's sleeve pays for the swap.
await cheat("surfnet_setAccount", [
  vault,
  { lamports: 2_000_000_000, owner: SYSTEM_PROGRAM, data: "", executable: false },
]);
console.log(`     vault sleeve funded: ${await lamportsOf(vault)} lamports`);

console.log("2. a live Jupiter quote, with the vault as the user");
const quote = await fetch(
  `${JUP_API}/quote?inputMint=${WSOL}&outputMint=${NVDAX}&amount=${AMOUNT_IN}` +
    `&slippageBps=300&onlyDirectRoutes=true`,
).then((r) => r.json());
assert(quote.outAmount, `no quote: ${JSON.stringify(quote).slice(0, 200)}`);
console.log(
  `     ${quote.routePlan.map((r) => r.swapInfo.label).join(" -> ")}: ` +
    `${AMOUNT_IN} lamports -> ${quote.outAmount} NVDAx base units`,
);

const built = await fetch(`${JUP_API}/swap-instructions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    quoteResponse: quote,
    userPublicKey: vault,
    wrapAndUnwrapSol: false,
    useSharedAccounts: false,
    skipUserAccountsRpcCalls: true,
  }),
}).then((r) => r.json());
assert(built.swapInstruction, `no instruction: ${JSON.stringify(built).slice(0, 300)}`);

const route = built.swapInstruction;
assert(
  route.programId === JUPITER_PROGRAM,
  `route must target the pinned Jupiter program, got ${route.programId}`,
);
const routeData = Buffer.from(route.data, "base64");
console.log(
  `     ${route.accounts.length} route accounts, ${routeData.length} bytes of opaque data`,
);

// Resolve the lookup tables Jupiter used, so the transaction can compress
// against them instead of inlining 800 bytes of pubkeys.
const lookupTables = {};
for (const [table, addresses] of Object.entries(
  built.addressesByLookupTableAddress ?? {},
)) {
  lookupTables[table] = addresses;
}
console.log(`     ${Object.keys(lookupTables).length} address lookup table(s)`);

console.log("3. swap_leg forwards it, vault signs by seeds");
const wsolBefore = await tokenAmount(vaultWsol);
const nvdaxBefore = await tokenAmount(vaultNvdax);
const minOut = BigInt(quote.otherAmountThreshold);

await send(
  `swap_leg 0.1 SOL -> >=${minOut} NVDAx`,
  [ixSwapLeg(AMOUNT_IN, minOut, routeData, route.accounts)],
  Object.keys(lookupTables).length ? lookupTables : undefined,
);

const nvdaxAfter = await tokenAmount(vaultNvdax);
const received = nvdaxAfter - nvdaxBefore;
assert(received >= minOut, `received ${received}, below the floor ${minOut}`);
console.log(`     vault received ${received} NVDAx base units (~${Number(received) / 1e8} NVDAx)`);
console.log(`     wSOL account left at ${await tokenAmount(vaultWsol)} (unwrapped back to the sleeve)`);
console.log(`     vault sleeve now ${await lamportsOf(vault)} lamports`);

console.log("\n4. the guards actually bite");
async function expectReject(label, ix, expected) {
  try {
    await send(label, [ix], lookupTables);
    throw new Error(`${label}: expected rejection`);
  } catch (e) {
    const code = e?.cause?.context?.code ?? e?.context?.code ?? null;
    console.log(`  ✓ ${label} rejected${code ? ` (custom ${code})` : ""}`);
    assert(
      expected == null || code === expected,
      `expected custom ${expected}, got ${code}`,
    );
  }
}

// USDC: a real, liquid mint that this tracker's basket does not name. The
// route behind it is still perfectly valid — what is refused is the
// *destination*, which is the point of the check.
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
{
  const bogus = ixSwapLeg(AMOUNT_IN, 0n, routeData, route.accounts);
  bogus.accounts[6] = { address: USDC, role: AccountRole.READONLY };
  await expectReject("buying a mint not in the published basket", bogus, 6022);
}
{
  // Selling into the sleeve is always allowed, so the same-mint guard is what
  // catches a degenerate wSOL -> wSOL.
  const same = ixSwapLeg(AMOUNT_IN, 0n, routeData, route.accounts);
  same.accounts[6] = { address: WSOL, role: AccountRole.READONLY };
  await expectReject("swapping a token for itself", same, 6021);
}
{
  // The destination account must belong to the vault. Point it at the
  // *manager's* token account instead and the proceeds have nowhere to go.
  const stolen = ixSwapLeg(AMOUNT_IN, 0n, routeData, route.accounts);
  const outsider = await pda(ATA_PROGRAM, [
    bytes(signer.address),
    bytes(TOKEN_2022_PROGRAM),
    bytes(NVDAX),
  ]);
  stolen.accounts[4] = { address: outsider, role: AccountRole.WRITABLE };
  await expectReject("routing the proceeds outside the vault", stolen, null);
}

console.log("\nAll swap checks passed.\n");
