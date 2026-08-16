/**
 * Initializes the curated trackers on whichever cluster CLUSTER points at.
 *
 * Idempotent: a tracker whose PDA already holds an account is skipped, so this
 * is safe to re-run after a partial failure.
 *
 *   node --experimental-strip-types scripts/init-trackers.mjs
 *   CLUSTER=mainnet-beta node --experimental-strip-types scripts/init-trackers.mjs
 *
 * Type stripping is needed because the basket definitions are imported from
 * `src/lib/config.ts` rather than duplicated here. That duplication is exactly
 * how an earlier version of this script ended up seeding baskets that did not
 * match the site: `config.ts` is the single source of truth, so it is the thing
 * to read.
 *
 * Also **reconciles**: a tracker whose on-chain basket has drifted from
 * `config.ts` is rebalanced rather than skipped.
 *
 * # Targets the Pinocchio program
 *
 * Three things differ from the Anchor version this replaces:
 *
 * - **One-byte discriminator** instead of an 8-byte sighash.
 * - **Fixed-width arguments.** The old payload was borsh with length-prefixed
 *   strings; this is a fixed header plus 66 bytes per leg.
 * - **`name`, `rebalanceInterval` and `filingDelayDays` are gone.** All three
 *   were written on chain and read by nothing. The name lives in the Metaplex
 *   metadata (see `set-metadata.mjs`) and the cadence lives in `config.ts`,
 *   which is where the UI was reading them from anyway.
 *
 * A tracker created here is **not** the one the Anchor program created for the
 * same ticker: the program id is part of PDA derivation, so these are new
 * accounts at new addresses.
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

import { TRACKERS as CONFIG_TRACKERS } from "../src/lib/config.ts";

const CLUSTER = process.env.CLUSTER ?? "devnet";
const RPC_URL =
  process.env.RPC_URL ??
  (CLUSTER === "devnet"
    ? "https://api.devnet.solana.com"
    : "https://api.mainnet-beta.solana.com");

const PROGRAM_ID =
  process.env.PROGRAM_ID ?? "7Z3DAC8q4vgFr2ofxXonHT2jgJx3xk1bmQHsRjUmVAnY";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const ZERO_ADDRESS = "11111111111111111111111111111111";

const IX_INITIALIZE_TRACKER = 0;
const IX_REBALANCE = 4;
const STRATEGY_SPOT_BASKET = 0;

/** Offsets into a `Tracker`, mirroring `state::tracker`. */
const T_LEG_COUNT = 8;
const T_LEGS = 170;
const LEG_SIZE = 66;
const LEG_WEIGHT_BPS = 32;

/**
 * Sized for the protocol ceiling rather than the current basket.
 *
 * The account is allocated once at `max_legs` and never reallocated, so a
 * rebalance can never need more room than it was created with — and a 13F that
 * adds a position must not be blocked by an account that was sized tight. The
 * headroom costs about 0.004 SOL per tracker, which is the cheapest insurance
 * in the whole deployment.
 */
const MAX_LEGS = 16;

/**
 * Legs that fit in one transaction.
 *
 * At 34 bytes per leg the protocol ceiling of 16 is 546 bytes of instruction
 * data, comfortably inside the 1232-byte transaction limit — so this is no
 * longer a real constraint and simply mirrors `MAX_LEGS`.
 *
 * It was a real constraint: an earlier layout carried the 32-byte `feed_id`
 * inline, making a leg 66 bytes and a full basket 1,058 bytes of data, which
 * did not fit. `cgSOL` and `aiSOL` could be neither created nor rebalanced.
 * Feed ids now travel separately via `set_leg_feed`.
 */
const MAX_LEGS_PER_TX = MAX_LEGS;

/**
 * Fees are parts per million: 2500 ppm is 0.25%.
 *
 * The old table called this field `Bps` while feeding it ppm, which is how
 * every live tracker ended up at 0.001% instead of 0.5%. Named correctly here.
 */
const DEPOSIT_FEE_PPM = 2500;
const REDEEM_FEE_PPM = 2500;

/**
 * Legs carry the zero mint on devnet: no tokenized equity exists here, so the
 * program routes that weight to the SOL sleeve and the UI says so. Binding real
 * xStocks mints — and their Pyth feed ids — is a mainnet-only change, and
 * `validate_legs` enforces that a tokenized leg must carry a feed id.
 */
const TRACKERS = CONFIG_TRACKERS.map((t) => ({
  ticker: t.ticker,
  legs: t.legs.map((l) => l.weightBps),
}));

for (const t of TRACKERS) {
  const sum = t.legs.reduce((a, b) => a + b, 0);
  if (sum !== 10_000) {
    throw new Error(`${t.ticker}: weights sum to ${sum}, not 10000`);
  }
  if (t.legs.length > MAX_LEGS) {
    throw new Error(`${t.ticker}: ${t.legs.length} legs exceeds the ${MAX_LEGS} ceiling`);
  }
}

const utf8 = new TextEncoder();
const addrEnc = getAddressEncoder();

const concat = (chunks) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
};

const u16le = (n) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
};

/**
 * ```text
 * 0    1     discriminator
 * 1    1     strategy
 * 2    1     max_legs
 * 3    2     deposit_fee_ppm  (LE)
 * 5    2     redeem_fee_ppm   (LE)
 * 7    1     ticker_len
 * 8    12    ticker           (zero-padded)
 * 20   1     leg_count
 * 21   n*34  legs             (mint || weight_bps LE)
 * ```
 */
function encodeInitializeData(tracker) {
  const tickerBytes = utf8.encode(tracker.ticker);
  if (tickerBytes.length === 0 || tickerBytes.length > 12) {
    throw new Error(`${tracker.ticker}: ticker must be 1..12 bytes`);
  }
  const paddedTicker = new Uint8Array(12);
  paddedTicker.set(tickerBytes);

  const zeroMint = new Uint8Array(addrEnc.encode(ZERO_ADDRESS));

  return concat([
    new Uint8Array([
      IX_INITIALIZE_TRACKER,
      STRATEGY_SPOT_BASKET,
      MAX_LEGS,
    ]),
    u16le(DEPOSIT_FEE_PPM),
    u16le(REDEEM_FEE_PPM),
    new Uint8Array([tickerBytes.length]),
    paddedTicker,
    new Uint8Array([tracker.legs.length]),
    ...tracker.legs.flatMap((weightBps) => [zeroMint, u16le(weightBps)]),
  ]);
}

/** The basket as it currently stands on chain, as weights in order. */
function readOnChainWeights(base64) {
  const d = Buffer.from(base64, "base64");
  const count = d[T_LEG_COUNT];
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(d.readUInt16LE(T_LEGS + i * LEG_SIZE + LEG_WEIGHT_BPS));
  }
  return out;
}

function encodeRebalanceData(legs) {
  const zeroMint = new Uint8Array(addrEnc.encode(ZERO_ADDRESS));
  return concat([
    new Uint8Array([IX_REBALANCE, legs.length]),
    ...legs.flatMap((weightBps) => [zeroMint, u16le(weightBps)]),
  ]);
}

const pda = async (seeds) =>
  (await getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds }))[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The public endpoints' rate limiter, which is throttling rather than failure. */
const isRateLimit = (e) =>
  e?.context?.statusCode === 429 || String(e?.message ?? "").includes("429");

/**
 * Retry an RPC call on 429, honouring `retry-after` when the endpoint sends
 * one. Seeding eleven trackers is ~40 calls in a burst, which the free tier
 * throttles reliably.
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

/** Build, sign, send and confirm a single-instruction transaction. */
async function sendIx(signer, rpc, instruction, confirm) {
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
  return sig;
}

async function main() {
  const keypairPath =
    process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json");
  const secret = JSON.parse(await readFile(keypairPath, "utf8"));
  const signer = await createKeyPairSignerFromBytes(new Uint8Array(secret));

  const rpc = createSolanaRpc(RPC_URL);

  // Confirmation by polling, not by websocket subscription: the public
  // endpoints throttle subscriptions hard enough that a dropped socket reads
  // as a program failure when it is nothing of the kind.
  async function confirm(signature) {
    for (let i = 0; i < 60; i++) {
      const { value } = await rpcRetry(() =>
        rpc.getSignatureStatuses([signature]).send(),
      );
      const status = value[0];
      if (status?.err) {
        throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
      }
      if (
        status?.confirmationStatus === "confirmed" ||
        status?.confirmationStatus === "finalized"
      ) {
        return;
      }
      await sleep(1000);
    }
    throw new Error(`timed out confirming ${signature}`);
  }

  console.log(`cluster   ${CLUSTER}`);
  console.log(`program   ${PROGRAM_ID}`);
  console.log(`authority ${signer.address}`);

  const { value: balance } = await rpcRetry(() =>
    rpc.getBalance(signer.address).send(),
  );
  console.log(`balance   ${Number(balance) / 1e9} SOL\n`);

  let created = 0;
  let reconciled = 0;
  let skipped = 0;
  for (const tracker of TRACKERS) {
    const trackerPda = await pda([
      utf8.encode("tracker"),
      utf8.encode(tracker.ticker),
    ]);
    const trackerSeed = new Uint8Array(addrEnc.encode(trackerPda));
    const vaultPda = await pda([utf8.encode("vault"), trackerSeed]);
    const mintPda = await pda([utf8.encode("share"), trackerSeed]);

    if (tracker.legs.length > MAX_LEGS_PER_TX) {
      console.log(
        `${tracker.ticker.padEnd(8)} SKIPPED           ${tracker.legs.length} legs will not fit one transaction (max ${MAX_LEGS_PER_TX})`,
      );
      skipped += 1;
      continue;
    }

    const { value: existing } = await rpcRetry(() =>
      rpc.getAccountInfo(trackerPda, { encoding: "base64" }).send(),
    );
    if (existing) {
      const onChain = readOnChainWeights(existing.data[0]);
      const matches =
        onChain.length === tracker.legs.length &&
        onChain.every((w, i) => w === tracker.legs[i]);
      if (matches) {
        console.log(`${tracker.ticker.padEnd(8)} up to date        ${onChain.length} legs`);
        continue;
      }

      console.log(
        `${tracker.ticker.padEnd(8)} drifted           ${onChain.length} legs on chain, ${tracker.legs.length} in config — rebalancing`,
      );
      await sendIx(
        signer,
        rpc,
        {
          programAddress: PROGRAM_ID,
          accounts: [
            { address: signer.address, role: AccountRole.READONLY_SIGNER },
            { address: trackerPda, role: AccountRole.WRITABLE },
          ],
          data: encodeRebalanceData(tracker.legs),
        },
        confirm,
      );
      reconciled += 1;
      continue;
    }

    const instruction = {
      programAddress: PROGRAM_ID,
      accounts: [
        { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: signer.address, role: AccountRole.READONLY }, // fee_recipient
        { address: trackerPda, role: AccountRole.WRITABLE },
        { address: mintPda, role: AccountRole.WRITABLE },
        { address: vaultPda, role: AccountRole.WRITABLE },
        // The port declares system before token, and reads rent from a
        // compiled-in constant rather than taking the sysvar.
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      ],
      data: encodeInitializeData(tracker),
    };

    const sig = await sendIx(signer, rpc, instruction, confirm);
    created += 1;

    console.log(`${tracker.ticker.padEnd(8)} initialized  ${tracker.legs.length} legs`);
    console.log(`  tracker ${trackerPda}`);
    console.log(`  vault   ${vaultPda}`);
    console.log(`  mint    ${mintPda}`);
    console.log(`  tx      ${sig}\n`);
  }

  const { value: after } = await rpcRetry(() =>
    rpc.getBalance(signer.address).send(),
  );
  console.log(
    `${created} created, ${reconciled} rebalanced, ${skipped} skipped; ` +
      `${Number(balance - after) / 1e9} SOL spent, ${Number(after) / 1e9} SOL left`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
