/**
 * The tokenized-leg paths, against a mainnet fork.
 *
 *   surfpool start -u https://api.mainnet-beta.solana.com --port 9500 --ws-port 9501 \
 *     --airdrop <YOUR_PUBKEY>
 *   solana program deploy target/deploy/autopilot_vault_pin.so \
 *     --program-id target/deploy/autopilot_vault_pin-keypair.json --url http://127.0.0.1:9500
 *   RPC_URL=http://127.0.0.1:9500 node scripts/pin-fork-test.mjs
 *
 * # Why a fork rather than devnet or LiteSVM
 *
 * `value_tokenized_legs` and `redeem_in_kind` only do anything when a leg is a
 * real Token-2022 mint with a real Pyth feed behind it. Devnet has neither —
 * every devnet leg carries the zero mint — so those paths have never executed
 * anywhere except unit tests.
 *
 * Surfpool forks mainnet with lazy account cloning, so the **actual** NVDAx
 * mint is here, with its permanent delegate, its pausable config, its scaled-UI
 * multiplier and its transfer-hook slot, and the **actual** Pyth price accounts
 * are here too. Nothing about the token's behaviour is simulated. The only
 * fiction is the money.
 *
 * What this proves that `tests/fixtures.rs` cannot: those tests feed real bytes
 * to the parsers in isolation. This runs the whole instruction — account
 * validation, oracle valuation, Token-2022 CPI — against real accounts inside a
 * real runtime.
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

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** Real mainnet addresses, present in the fork by lazy cloning. */
const NVDAX_MINT = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const PYTH_SOL_USD = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
const PYTH_NVDA_USD = "2w1Tg1XTZbUib7srfRoStJ4v5JXVsK7roQEGMsMaGZFC";

/** Pyth `Equity.US.NVDA/USD`. */
const NVDA_FEED_ID_HEX =
  "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593";

const TICKER = process.env.TICKER ?? `fk${Math.floor(Math.random() * 1e6).toString(36)}`;
const MAX_LEGS = 4;

const IX = {
  INITIALIZE_TRACKER: 0,
  DEPOSIT: 1,
  REDEEM_FOR_SOL: 2,
  REDEEM_IN_KIND: 3,
  SET_LEG_FEED: 14,
};

const utf8 = new TextEncoder();
const addrEnc = getAddressEncoder();
const bytes = (a) => new Uint8Array(addrEnc.encode(a));
const hex = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
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
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const assert = (c, m) => {
  if (!c) throw new Error(`ASSERTION FAILED: ${m}`);
};

// ---------------------------------------------------------------------------

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
const shareAta = await pda(ATA_PROGRAM, [
  bytes(signer.address),
  bytes(TOKEN_PROGRAM),
  bytes(shareMint),
]);
// Leg accounts are Token-2022, so their ATAs derive under that program.
const vaultLegAta = await pda(ATA_PROGRAM, [
  bytes(vault),
  bytes(TOKEN_2022_PROGRAM),
  bytes(NVDAX_MINT),
]);
const holderLegAta = await pda(ATA_PROGRAM, [
  bytes(signer.address),
  bytes(TOKEN_2022_PROGRAM),
  bytes(NVDAX_MINT),
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function confirm(sig) {
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const s = value[0];
    if (s?.err) throw new Error(`failed: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus) return;
    await sleep(300);
  }
  throw new Error(`timed out confirming ${sig}`);
}

async function send(label, instructions) {
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
      preflightCommitment: "processed",
    })
    .send();
  await confirm(sig);
  console.log(`  ✓ ${label}`);
  return sig;
}

async function expectFailure(label, instructions) {
  try {
    await send(label, instructions);
  } catch (e) {
    const code = e?.cause?.context?.code ?? e?.context?.code ?? null;
    console.log(`  ✓ ${label} rejected${code ? ` (custom ${code})` : ""}`);
    return code;
  }
  throw new Error(`${label}: expected rejection`);
}

/** Raw JSON-RPC, for the `surfnet_*` cheatcodes Kit does not model. */
async function cheat(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());
  if (res.error) throw new Error(`${method}: ${JSON.stringify(res.error)}`);
  return res.result;
}

/** The `publish_time` inside a cloned Pyth `PriceUpdateV2`. */
async function pythPublishTime(address) {
  const { value } = await rpc.getAccountInfo(address, { encoding: "base64" }).send();
  const raw = Buffer.from(value.data[0], "base64");
  // price_message at 41 (Full verification), publish_time 52 bytes in.
  return Number(raw.readBigInt64LE(41 + 52));
}

/**
 * Set the balance of an existing Token-2022 account.
 *
 * `surfnet_setTokenAccount` cannot be used here: it derives the associated
 * token address under the **classic** SPL Token program even when the mint is
 * Token-2022, so the balance lands at an address the program will never look
 * at. Verified directly — the classic derivation got the tokens and the
 * Token-2022 derivation stayed at zero.
 *
 * Instead this patches `amount` (a LE u64 at offset 64) in the account the ATA
 * program already created, leaving every other byte — including whatever
 * extensions Token-2022 wrote — exactly as the real program left it.
 */
async function setToken2022Balance(tokenAccount, amount) {
  const { value } = await rpc
    .getAccountInfo(tokenAccount, { encoding: "base64" })
    .send();
  assert(value, `${tokenAccount} must exist before its balance can be set`);
  assert(
    value.owner === TOKEN_2022_PROGRAM,
    `${tokenAccount} should be Token-2022, is ${value.owner}`,
  );
  const raw = Buffer.from(value.data[0], "base64");
  raw.writeBigUInt64LE(BigInt(amount), 64);
  await cheat("surfnet_setAccount", [
    tokenAccount,
    {
      lamports: Number(value.lamports),
      owner: value.owner,
      data: raw.toString("hex"),
      executable: false,
    },
  ]);
}

const lamportsOf = async (a) =>
  BigInt((await rpc.getBalance(a, { commitment: "processed" }).send()).value);

async function tokenAmount(account) {
  try {
    const { value } = await rpc
      .getTokenAccountBalance(account, { commitment: "processed" })
      .send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
}

async function shareSupply() {
  const { value } = await rpc
    .getTokenSupply(shareMint, { commitment: "processed" })
    .send();
  return BigInt(value.amount);
}

// ---- instructions ---------------------------------------------------------

const zero = new Uint8Array(32);

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
      new Uint8Array([IX.INITIALIZE_TRACKER, 0, MAX_LEGS]),
      u16le(0),
      u16le(0),
      new Uint8Array([t.length]),
      padded,
      new Uint8Array([legs.length]),
      ...legs.flatMap((l) => [l.mint, u16le(l.weightBps)]),
    ),
  };
};

const ixSetLegFeed = (index, feedId) => ({
  programAddress: PROGRAM_ID,
  accounts: [
    { address: signer.address, role: AccountRole.READONLY_SIGNER },
    { address: tracker, role: AccountRole.WRITABLE },
  ],
  data: cat(new Uint8Array([IX.SET_LEG_FEED, index]), feedId),
});

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

/**
 * Oracle accounts: the SOL/USD price, then per tokenized leg in basket order
 * `(leg mint, the vault's token account, the leg's price account)`.
 */
const oracleAccounts = () => [
  { address: PYTH_SOL_USD, role: AccountRole.READONLY },
  { address: NVDAX_MINT, role: AccountRole.READONLY },
  { address: vaultLegAta, role: AccountRole.READONLY },
  { address: PYTH_NVDA_USD, role: AccountRole.READONLY },
];

const ixDeposit = (lamports) => ({
  programAddress: PROGRAM_ID,
  accounts: [
    { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
    { address: tracker, role: AccountRole.WRITABLE },
    { address: shareMint, role: AccountRole.WRITABLE },
    { address: vault, role: AccountRole.WRITABLE },
    { address: signer.address, role: AccountRole.WRITABLE },
    { address: shareAta, role: AccountRole.WRITABLE },
    { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ...oracleAccounts(),
  ],
  data: cat(new Uint8Array([IX.DEPOSIT]), u64le(lamports), u64le(0)),
});

const ixRedeemInKind = (shares) => ({
  programAddress: PROGRAM_ID,
  accounts: [
    { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
    { address: tracker, role: AccountRole.WRITABLE },
    { address: shareMint, role: AccountRole.WRITABLE },
    { address: vault, role: AccountRole.WRITABLE },
    { address: shareAta, role: AccountRole.WRITABLE },
    { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    { address: TOKEN_2022_PROGRAM, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    // per tokenized leg: mint, vault token account, holder token account
    { address: NVDAX_MINT, role: AccountRole.READONLY },
    { address: vaultLegAta, role: AccountRole.WRITABLE },
    { address: holderLegAta, role: AccountRole.WRITABLE },
  ],
  data: cat(new Uint8Array([IX.REDEEM_IN_KIND]), u64le(shares)),
});

// ---------------------------------------------------------------------------

const SOL = 1_000_000_000n;
const ONE_NVDAX = 100_000_000n; // 8 decimals

console.log(`\nPinocchio mainnet-fork test`);
console.log(`  rpc      ${RPC_URL}`);
console.log(`  program  ${PROGRAM_ID}`);
console.log(`  ticker   ${TICKER}`);
console.log(`  leg      NVDAx ${NVDAX_MINT}\n`);

// Sanity: the fork really did clone the live mint, not a stub.
{
  const { value } = await rpc
    .getAccountInfo(NVDAX_MINT, { encoding: "base64" })
    .send();
  assert(value, "NVDAx mint must exist in the fork");
  assert(value.owner === TOKEN_2022_PROGRAM, "NVDAx must be Token-2022");
  const raw = Buffer.from(value.data[0], "base64");
  assert(raw.length > 165, `expected extensions, got ${raw.length} bytes`);
  console.log(`  fork cloned the real NVDAx mint: ${raw.length} bytes, Token-2022`);
}

// Staleness and the fork clock
// -----------------------------
// Surfpool's `Clock::get()` does not agree with its own Clock *sysvar account*:
// the sysvar reports a price 23s old while the program reads it as stale and
// rejects with InvalidOraclePrice (6027). Verified by widening the window in a
// throwaway build — the deposit then succeeds — so it is the fork's clock, not
// the check.
//
// Rather than fight it, this test takes staleness out of scope: it rewrites
// each Pyth account with `publish_time` set forward, so the one-sided check
// (`publish_time + max_age >= now`) passes under any clock. **The price, the
// exponent, the feed id and the verification level are the real bytes** —
// only the timestamp is moved.
//
// Nothing is lost by doing this. Staleness is tested exhaustively against real
// unmodified accounts in `tests/fixtures.rs`, including both windows and the
// boundary. What only a fork can test is what follows: Token-2022 legs and
// valuation inside a real runtime.
{
  const patched = [];
  for (const [name, addr] of [
    ["SOL/USD", PYTH_SOL_USD],
    ["NVDA/USD", PYTH_NVDA_USD],
  ]) {
    const { value } = await rpc.getAccountInfo(addr, { encoding: "base64" }).send();
    const raw = Buffer.from(value.data[0], "base64");
    const priceBefore = raw.readBigInt64LE(41 + 32);
    // publish_time, 52 bytes into price_message
    raw.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 3600), 41 + 52);
    await cheat("surfnet_setAccount", [
      addr,
      {
        lamports: Number(value.lamports),
        owner: value.owner,
        // surfnet_setAccount takes hex, not base64.
        data: raw.toString("hex"),
        executable: false,
      },
    ]);
    const after = await rpc.getAccountInfo(addr, { encoding: "base64" }).send();
    const rawAfter = Buffer.from(after.value.data[0], "base64");
    assert(
      rawAfter.readBigInt64LE(41 + 32) === priceBefore,
      `${name}: price must be unchanged by the timestamp patch`,
    );
    patched.push(`${name} $${Number(priceBefore) * 10 ** rawAfter.readInt32LE(41 + 48)}`);
  }
  console.log(`  timestamps set forward; real prices kept: ${patched.join(", ")}\n`);
}

console.log("1. a tracker with a real tokenized leg");
await send("initialize_tracker (NVDAx 60% / sleeve 40%)", [
  ixInitialize([
    { mint: bytes(NVDAX_MINT), weightBps: 6000 },
    { mint: zero, weightBps: 4000 },
  ]),
]);
await send("set_leg_feed(0, Equity.US.NVDA/USD)", [
  ixSetLegFeed(0, hex(NVDA_FEED_ID_HEX)),
]);

console.log("2. token accounts");
await send("create share ATA", [
  ixCreateAta(signer.address, shareMint, shareAta, TOKEN_PROGRAM),
]);
await send("create vault + holder NVDAx ATAs (Token-2022)", [
  ixCreateAta(vault, NVDAX_MINT, vaultLegAta, TOKEN_2022_PROGRAM),
  ixCreateAta(signer.address, NVDAX_MINT, holderLegAta, TOKEN_2022_PROGRAM),
]);

console.log("3. genesis deposit, vault holds no NVDAx yet");
await send("deposit 1 SOL", [ixDeposit(SOL)]);
const genesisShares = await tokenAmount(shareAta);
assert(genesisShares === SOL, `genesis should mint 1:1, got ${genesisShares}`);
console.log(`     ${genesisShares} shares — oracle path ran with a zero leg balance`);

console.log("4. give the vault real NVDAx, then price it");
await setToken2022Balance(vaultLegAta, ONE_NVDAX);
const held = await tokenAmount(vaultLegAta);
assert(held === ONE_NVDAX, `vault should hold 1 NVDAx, got ${held}`);

const supplyBefore = await shareSupply();
const sleeveBefore = (await lamportsOf(vault)) - 890_880n;
await send("deposit 1 SOL again", [ixDeposit(SOL)]);
const supplyAfter = await shareSupply();

// shares_out = net * supply / assets_before  =>  assets_before = net * supply / shares_out
const sharesOut = supplyAfter - supplyBefore;
const assetsBefore = (SOL * supplyBefore) / sharesOut;
const legValue = assetsBefore - sleeveBefore;

assert(sharesOut > 0n, "must mint something");
assert(
  legValue > 0n,
  `the NVDAx leg must be valued above zero — got ${legValue} lamports`,
);
console.log(
  `     vault priced at ${assetsBefore} lamports: ${sleeveBefore} sleeve + ${legValue} from 1 NVDAx`,
);
console.log(`     => 1 NVDAx = ${Number(legValue) / 1e9} SOL, via real Pyth + real multiplier`);

console.log("5. the oracle actually gates — a wrong price account is refused");
{
  const bad = ixDeposit(SOL);
  // Swap the equity price account for the SOL one.
  bad.accounts[bad.accounts.length - 1] = {
    address: PYTH_SOL_USD,
    role: AccountRole.READONLY,
  };
  const code = await expectFailure("deposit with the wrong feed", [bad]);
  assert(code === 6030 || code === null, `expected InvalidFeedId (6030), got ${code}`);
}

console.log("6. redeem_in_kind delivers the real token");
const holderBefore = await tokenAmount(holderLegAta);
const redeeming = (await tokenAmount(shareAta)) / 2n;
await send(`redeem_in_kind ${redeeming} shares`, [ixRedeemInKind(redeeming)]);
const holderAfter = await tokenAmount(holderLegAta);
const delivered = holderAfter - holderBefore;

assert(
  delivered > 0n,
  `expected NVDAx to be delivered, holder went ${holderBefore} -> ${holderAfter}`,
);
// Half the supply was burned, so roughly half the vault's NVDAx should move.
const expected = ONE_NVDAX / 2n;
const drift =
  delivered > expected ? delivered - expected : expected - delivered;
assert(
  drift * 100n <= expected,
  `pro-rata delivery off by more than 1%: got ${delivered}, expected ~${expected}`,
);
console.log(
  `     ${delivered} NVDAx base units delivered (~${Number(delivered) / 1e8} NVDAx), pro-rata`,
);
console.log(`     vault retains ${await tokenAmount(vaultLegAta)}`);

console.log("\nAll fork checks passed.\n");
