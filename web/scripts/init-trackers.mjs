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
import { legBinding } from "../src/lib/leg-bindings.ts";

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
const IX_CLOSE_TRACKER = 13;
const IX_SET_LEG_FEED = 14;
const STRATEGY_SPOT_BASKET = 0;

/** Offsets into a `Tracker`, mirroring `state::tracker`. */
const T_LEG_COUNT = 8;
const T_SHARE_MINT = 86;
const T_LEGS = 170;
const LEG_SIZE = 66;
const LEG_MINT = 0;
const LEG_WEIGHT_BPS = 32;
const LEG_FEED_ID = 34;

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

const IS_MAINNET = CLUSTER === "mainnet-beta";

/**
 * `DRY_RUN=1` simulates every transaction instead of sending it.
 *
 * A simulated run still exercises the whole program — the payload encoding, the
 * PDA derivations, `validate_legs`, the fee ceiling — and reports the compute
 * used, but writes nothing. Run it once before any mainnet run; the failure it
 * catches costs nothing here and is unrecoverable on chain.
 */
const DRY_RUN = process.env.DRY_RUN === "1";

/**
 * Legs carry the zero mint on devnet: no tokenized equity exists there, so the
 * program routes that weight to the SOL sleeve and the UI says so.
 *
 * On mainnet each leg is bound to the real xStocks mint and its Pyth feed, read
 * from the checked-in `leg-bindings.ts` rather than from a live search — see
 * that file for why. `legBinding` throws on an unknown symbol, so a leg the
 * repo has no verified binding for stops the run instead of quietly becoming a
 * zero mint and folding its weight into the SOL sleeve.
 *
 * The feed does not travel in this payload. `write_legs` writes a zero feed id
 * for a mint it has not seen before, and valuation fails closed on a zero feed,
 * so every leg needs a following `set_leg_feed` — bundled into the same
 * transaction below, which is what keeps a tracker from ever being visible in a
 * state where its oracles are unset.
 */
const TRACKERS = CONFIG_TRACKERS.map((t) => ({
  ticker: t.ticker,
  shareMint: t.shareMint,
  legs: t.legs.map((l) => {
    if (!IS_MAINNET || !l.tokenized || !l.xstock) {
      return { symbol: l.symbol, mint: ZERO_ADDRESS, weightBps: l.weightBps, feed: null };
    }
    const b = legBinding(l.xstock);
    return { symbol: l.xstock, mint: b.mint, weightBps: l.weightBps, feed: b.pythFeed };
  }),
}));

/**
 * The vanity mint keypairs, gitignored under `.keys/warh/`.
 *
 * The share mint is caller-supplied rather than derived, so creating a tracker
 * needs its private key to co-sign. Losing these before launch means regrinding
 * and editing config; losing them after costs nothing, because the mint
 * authority is the tracker PDA and these keys sign exactly once.
 */
const KEY_DIR = process.env.MINT_KEY_DIR ?? join(homedir(), "autopilot-solana/.keys/warh");

async function loadMintSigner(ticker, expected) {
  const path = join(KEY_DIR, `${ticker}.json`);
  const secret = JSON.parse(await readFile(path, "utf8"));
  const kp = await createKeyPairSignerFromBytes(new Uint8Array(secret));
  if (kp.address !== expected) {
    throw new Error(
      `${ticker}: ${path} is ${kp.address}, config says ${expected}`,
    );
  }
  return kp;
}

for (const t of TRACKERS) {
  const sum = t.legs.reduce((a, l) => a + l.weightBps, 0);
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
    ...tracker.legs.flatMap((l) => [
      new Uint8Array(addrEnc.encode(l.mint)),
      u16le(l.weightBps),
    ]),
  ]);
}

/** `leg_index: u8 || feed_id: [u8; 32]` — see `handle_set_leg_feed`. */
function encodeSetLegFeed(index, feedHex) {
  const hex = feedHex.startsWith("0x") ? feedHex.slice(2) : feedHex;
  if (hex.length !== 64) {
    throw new Error(`feed id must be 32 bytes, got ${hex.length / 2}`);
  }
  const feed = Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
  return concat([new Uint8Array([IX_SET_LEG_FEED, index]), feed]);
}

/**
 * The basket as it currently stands on chain: mint, weight and feed per leg.
 *
 * Drift is checked on all three. Weight-only comparison was enough while every
 * leg carried the zero mint, but once legs are bound to real equities a wrong
 * mint or an unset feed is the failure that matters — and neither shows up in
 * the weights.
 */
function readOnChainLegs(base64) {
  const d = Buffer.from(base64, "base64");
  const count = d[T_LEG_COUNT];
  const out = [];
  for (let i = 0; i < count; i++) {
    const off = T_LEGS + i * LEG_SIZE;
    out.push({
      mint: bs58(d.subarray(off + LEG_MINT, off + LEG_MINT + 32)),
      weightBps: d.readUInt16LE(off + LEG_WEIGHT_BPS),
      feed: d.subarray(off + LEG_FEED_ID, off + LEG_FEED_ID + 32).toString("hex"),
    });
  }
  return out;
}

const ZERO_FEED = "0".repeat(64);

/** The mint this tracker was created with, as base58. */
function readOnChainMint(base64) {
  const d = Buffer.from(base64, "base64");
  return bs58(d.subarray(T_SHARE_MINT, T_SHARE_MINT + 32));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

function encodeRebalanceData(legs) {
  return concat([
    new Uint8Array([IX_REBALANCE, legs.length]),
    ...legs.flatMap((l) => [
      new Uint8Array(addrEnc.encode(l.mint)),
      u16le(l.weightBps),
    ]),
  ]);
}

/**
 * One `set_leg_feed` per tokenized leg.
 *
 * Sent alongside the instruction that wrote the basket rather than after it.
 * `write_legs` carries a feed forward only for a mint already in the basket, so
 * a newly bound leg lands with a zero feed id — and valuation fails closed on a
 * zero feed. Bundling them means the tracker is never observable in a state
 * where a leg has a mint but no oracle.
 */
function feedInstructions(signer, trackerPda, legs) {
  return legs.flatMap((l, i) =>
    l.feed
      ? [{
          programAddress: PROGRAM_ID,
          accounts: [
            { address: signer.address, role: AccountRole.READONLY_SIGNER },
            { address: trackerPda, role: AccountRole.WRITABLE },
          ],
          data: encodeSetLegFeed(i, l.feed),
        }]
      : [],
  );
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

/** Build, sign, send and confirm one transaction carrying `instructions`. */
async function sendIx(signer, rpc, instructions, confirm, extraSigners = []) {
  const { value: blockhash } = await rpcRetry(() =>
    rpc.getLatestBlockhash().send(),
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([].concat(instructions), m),
    (m) => addSignersToTransactionMessage([signer, ...extraSigners], m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const sig = getSignatureFromTransaction(signed);

  if (DRY_RUN) {
    const { value } = await rpcRetry(() =>
      rpc
        .simulateTransaction(getBase64EncodedWireTransaction(signed), {
          encoding: "base64",
          commitment: "confirmed",
          // The transaction is fully signed, so its blockhash is real and the
          // signatures verify — no need to ask the validator to skip either.
          replaceRecentBlockhash: false,
          sigVerify: true,
        })
        .send(),
    );
    if (value.err) {
      throw new Error(
        `simulation failed: ${JSON.stringify(value.err)}\n${(value.logs ?? []).join("\n")}`,
      );
    }
    console.log(`  simulated ok, ${value.unitsConsumed} CU`);
    return "(dry run)";
  }

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
  let migrated = 0;
  for (const tracker of TRACKERS) {
    const trackerPda = await pda([
      utf8.encode("tracker"),
      utf8.encode(tracker.ticker),
    ]);
    const trackerSeed = new Uint8Array(addrEnc.encode(trackerPda));
    const vaultPda = await pda([utf8.encode("vault"), trackerSeed]);
    // Not derived any more — a ground keypair whose address starts with `warh`.
    const mintSigner = await loadMintSigner(tracker.ticker, tracker.shareMint);
    const mintPda = mintSigner.address;

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
      // A tracker created before the mint became caller-supplied carries a
      // derived PDA mint. Retire and re-create it so the token gets its vanity
      // address — but only when nobody holds shares, because closing a tracker
      // with holders is not the authority's to do and the program refuses.
      const currentMint = readOnChainMint(existing.data[0]);
      if (currentMint !== tracker.shareMint) {
        let supply = "0";
        try {
          supply = (
            await rpcRetry(() =>
              rpc.getTokenSupply(currentMint, { commitment: "confirmed" }).send(),
            )
          ).value.amount;
        } catch {
          /* mint may not exist */
        }
        if (supply !== "0") {
          console.log(
            `${tracker.ticker.padEnd(8)} SKIPPED           holds ${supply} shares; ` +
              `redeem them before the mint can be changed`,
          );
          skipped += 1;
          continue;
        }
        console.log(
          `${tracker.ticker.padEnd(8)} migrating mint    ${currentMint.slice(0, 8)}… -> ${tracker.shareMint.slice(0, 8)}…`,
        );
        await sendIx(
          signer,
          rpc,
          [{
            programAddress: PROGRAM_ID,
            accounts: [
              { address: signer.address, role: AccountRole.READONLY_SIGNER },
              { address: signer.address, role: AccountRole.WRITABLE },
              { address: trackerPda, role: AccountRole.WRITABLE },
              { address: currentMint, role: AccountRole.READONLY },
              { address: vaultPda, role: AccountRole.WRITABLE },
              { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
            ],
            data: new Uint8Array([IX_CLOSE_TRACKER]),
          }],
          confirm,
        );
        migrated += 1;
        // Fall through to creation below with the vanity mint.
      } else {
      const onChain = readOnChainLegs(existing.data[0]);
      const matches =
        onChain.length === tracker.legs.length &&
        onChain.every(
          (l, i) =>
            l.weightBps === tracker.legs[i].weightBps &&
            l.mint === tracker.legs[i].mint &&
            l.feed === (tracker.legs[i].feed ?? ZERO_FEED),
        );
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
        [
          {
            programAddress: PROGRAM_ID,
            accounts: [
              { address: signer.address, role: AccountRole.READONLY_SIGNER },
              { address: trackerPda, role: AccountRole.WRITABLE },
            ],
            data: encodeRebalanceData(tracker.legs),
          },
          // Re-issued unconditionally: `write_legs` only carries a feed forward
          // for a mint that was already in the basket, so a reweight that also
          // swaps a mint would otherwise leave that leg unpriceable.
          ...feedInstructions(signer, trackerPda, tracker.legs),
        ],
        confirm,
      );
      reconciled += 1;
      continue;
      }
    }

    const initialize = {
      programAddress: PROGRAM_ID,
      accounts: [
        { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: signer.address, role: AccountRole.READONLY }, // fee_recipient
        { address: trackerPda, role: AccountRole.WRITABLE },
        // The mint signs for its own creation.
        { address: mintPda, role: AccountRole.WRITABLE_SIGNER },
        { address: vaultPda, role: AccountRole.WRITABLE },
        // The port declares system before token, and reads rent from a
        // compiled-in constant rather than taking the sysvar.
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      ],
      data: encodeInitializeData(tracker),
    };

    const sig = await sendIx(
      signer,
      rpc,
      [initialize, ...feedInstructions(signer, trackerPda, tracker.legs)],
      confirm,
      [mintSigner],
    );
    created += 1;

    console.log(`${tracker.ticker.padEnd(8)} initialized  ${tracker.legs.length} legs`);
    for (const l of tracker.legs) {
      console.log(
        `  leg     ${l.symbol.padEnd(7)} ${(l.weightBps / 100).toFixed(2).padStart(5)}%  ` +
          `${l.mint === ZERO_ADDRESS ? "SOL sleeve" : l.mint}` +
          `${l.feed ? `  feed ${l.feed.slice(0, 8)}…` : ""}`,
      );
    }
    console.log(`  tracker ${trackerPda}`);
    console.log(`  vault   ${vaultPda}`);
    console.log(`  mint    ${mintPda}`);
    console.log(`  tx      ${sig}\n`);
  }

  const { value: after } = await rpcRetry(() =>
    rpc.getBalance(signer.address).send(),
  );
  console.log(
    `${created} created, ${migrated} mint-migrated, ${reconciled} rebalanced, ${skipped} skipped; ` +
      `${Number(balance - after) / 1e9} SOL spent, ${Number(after) / 1e9} SOL left`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
