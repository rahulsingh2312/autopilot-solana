/**
 * Creates Metaplex token metadata for each tracker's share mint, via the
 * program's set_token_metadata instruction (the mint authority is a PDA, so
 * only the program can sign the CPI).
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
  getSignatureFromTransaction,
  getBytesEncoder,
  getU32Encoder,
  pipe,
  getBase64EncodedWireTransaction,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

const RPC_URL =
  process.env.RPC_URL ??
  "https://devnet.helius-rpc.com/?api-key=397b5828-cbba-479e-992e-7000c78d482b";
const PROGRAM_ID =
  process.env.PROGRAM_ID ?? "7Z3DAC8q4vgFr2ofxXonHT2jgJx3xk1bmQHsRjUmVAnY";
const METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111";
// The live domain. Wallets and explorers fetch this URI forever, so it has to
// be the canonical one rather than the Vercel preview host.
const SITE = process.env.SITE ?? "https://sol.copycat.my";

/**
 * One byte, not an 8-byte Anchor sighash — this targets the Pinocchio program.
 *
 * The payload is length-prefixed with a single `u8` per field rather than
 * borsh's `u32`, and the program bounds each against Metaplex's own limits
 * (32 / 10 / 200) so an over-long name fails as our error rather than as an
 * opaque CPI failure.
 */
const IX_SET_TOKEN_METADATA = 6;
const MAX_NAME = 32;
const MAX_SYMBOL = 10;
const MAX_URI = 200;

/**
 * Read straight from config.ts rather than repeated here.
 *
 * This list used to be hand-maintained and had already drifted: it still
 * carried a tracker that had been removed from the product and knew nothing
 * about two that had been added. A token's on-chain name is the one thing a
 * wallet shows forever, so it should not depend on someone remembering to
 * edit a second list.
 */
const TOKENS = (await import("../src/lib/config.ts")).TRACKERS.map((t) => ({
  ticker: t.ticker,
  name: t.name,
  symbol: t.ticker,
  uri: `${SITE}/tokens/${t.ticker.toLowerCase()}.json`,
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (e) =>
  e?.context?.statusCode === 429 || String(e?.message ?? "").includes("429");

/**
 * Retry an RPC call on 429. The public devnet endpoint throttles a burst of
 * nine metadata writes reliably, and a throttled read is not a failure.
 */
async function rpcRetry(fn, attempts = 8) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimit(e) || i >= attempts - 1) throw e;
      const after = Number(e?.context?.headers?.["retry-after"] ?? 0);
      await sleep(after > 0 ? after * 1000 : 2000 * (i + 1));
    }
  }
}

const utf8 = new TextEncoder();

/** `disc || len:u8 || bytes` per field. */
function encodeMetadata(token) {
  const field = (value, max, label) => {
    const b = utf8.encode(value);
    if (b.length === 0 || b.length > max) {
      throw new Error(
        `${token.ticker}: ${label} is ${b.length} bytes, max ${max}`,
      );
    }
    return concat([new Uint8Array([b.length]), b]);
  };
  return concat([
    new Uint8Array([IX_SET_TOKEN_METADATA]),
    field(token.name, MAX_NAME, "name"),
    field(token.symbol, MAX_SYMBOL, "symbol"),
    field(token.uri, MAX_URI, "uri"),
  ]);
}
const addrEnc = getAddressEncoder();
const u32 = getU32Encoder();

const concat = (chunks) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
};
const str = (v) => {
  const b = utf8.encode(v);
  return concat([new Uint8Array(u32.encode(b.length)), b]);
};
const pda = async (programAddress, seeds) =>
  (await getProgramDerivedAddress({ programAddress, seeds }))[0];

const secret = JSON.parse(
  await readFile(
    process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json"),
    "utf8",
  ),
);
const signer = await createKeyPairSignerFromBytes(new Uint8Array(secret));

const rpc = createSolanaRpc(RPC_URL);
// Confirmation by polling rather than websocket subscription: the public
// endpoints throttle subscriptions hard enough that a dropped socket reads as a
// failed write when the transaction actually landed.
async function confirm(signature) {
  for (let i = 0; i < 60; i++) {
    const { value } = await rpcRetry(() =>
      rpc.getSignatureStatuses([signature]).send(),
    );
    const status = value[0];
    if (status?.err) {
      throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus) return;
    await sleep(1000);
  }
  throw new Error(`timed out confirming ${signature}`);
}

for (const token of TOKENS) {
  const tracker = await pda(PROGRAM_ID, [
    utf8.encode("tracker"),
    utf8.encode(token.ticker),
  ]);
  const mint = await pda(PROGRAM_ID, [
    utf8.encode("share"),
    new Uint8Array(addrEnc.encode(tracker)),
  ]);
  const metadata = await pda(METADATA_PROGRAM, [
    utf8.encode("metadata"),
    new Uint8Array(addrEnc.encode(METADATA_PROGRAM)),
    new Uint8Array(addrEnc.encode(mint)),
  ]);

  const { value: existing } = await rpcRetry(() =>
    rpc.getAccountInfo(metadata, { encoding: "base64" }).send(),
  );
  if (existing) {
    console.log(
      `${token.ticker.padEnd(8)} metadata already exists  ${metadata}`,
    );
    continue;
  }

  const instruction = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: tracker, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: metadata, role: AccountRole.WRITABLE },
      { address: METADATA_PROGRAM, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: RENT_SYSVAR, role: AccountRole.READONLY },
    ],
    data: encodeMetadata(token),
  };

  const { value: blockhash } = await rpcRetry(() =>
    rpc.getLatestBlockhash().send(),
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([instruction], m),
    (m) => addSignersToTransactionMessage([signer], m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const sig = getSignatureFromTransaction(signed);
  await rpcRetry(() =>
    rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), {
        encoding: "base64",
        preflightCommitment: "confirmed",
      })
      .send(),
  );
  await confirm(sig);

  console.log(`${token.ticker.padEnd(8)} metadata created`);
  console.log(`  mint     ${mint}`);
  console.log(`  metadata ${metadata}`);
  console.log(`  tx       ${sig}\n`);
}
