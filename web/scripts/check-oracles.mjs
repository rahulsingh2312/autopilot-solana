/**
 * Can each tracker actually be valued right now?
 *
 *   RPC_URL=... node --experimental-strip-types scripts/check-oracles.mjs
 *
 * The program values a tokenized leg by reading a Pyth `PriceUpdateV2` account
 * and rejecting it if `publish_time` is older than the bound in `oracle.rs` —
 * 180s for SOL, 4 days for an equity. A deposit into a tracker whose legs have
 * no usable price account does not mint mispriced shares; it reverts. This
 * script reports that condition before a user hits it.
 *
 * # Why the on-chain accounts are not enough
 *
 * Pyth on Solana is a *pull* oracle. The canonical price lives off-chain and a
 * caller posts it on demand. Sponsored push accounts exist at
 * `[shard_id_le_u16, feed_id]` under the push-oracle program, but they are
 * maintained per-feed and most tokenized-equity feeds are not maintained at all
 * — measured here, several were months stale and five had no account.
 *
 * A stale account is worse than a missing one. MSFT's push account read $390.92
 * while Hermes served $495.18 for the same feed: a 21% error, in a direction
 * that would have minted shares far too cheaply. The staleness bound is what
 * turns that into a failed transaction instead of a loss, which is why this
 * script treats "stale" and "missing" as the same verdict.
 */

import { createSolanaRpc, getProgramDerivedAddress } from "@solana/kit";

import { TRACKERS } from "../src/lib/config.ts";
import { LEG_BINDINGS } from "../src/lib/leg-bindings.ts";

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("RPC_URL is required");
  process.exit(1);
}

/** Sponsored feed accounts are PDAs of the push oracle, owned by the receiver. */
const PUSH_ORACLE = "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT";
const RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
const SOL_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/** Mirrors `oracle.rs`. */
const MAX_SOL_AGE = 180;
const MAX_EQUITY_AGE = 4 * 24 * 60 * 60;

/**
 * `PriceUpdateV2`, and the offset trap that comes with it.
 *
 * `verification_level` is a borsh enum: `Partial{num_signatures}` is two bytes,
 * `Full` is one. Every offset below is valid only once byte 40 is confirmed to
 * be `Full` (1) — reading them unconditionally is how a `Partial` update gets
 * parsed one byte out of alignment, silently.
 */
const VERIFICATION_LEVEL = 40;
const FULL = 1;
const FEED_ID = 41;
const PRICE = 73;
const EXPO = 89;
const PUBLISH_TIME = 93;

const hex = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));

async function feedAccount(feedHex, shard = 0) {
  const s = new Uint8Array(2);
  new DataView(s.buffer).setUint16(0, shard, true);
  const [addr] = await getProgramDerivedAddress({
    programAddress: PUSH_ORACLE,
    seeds: [s, hex(feedHex)],
  });
  return addr;
}

/** The verdict the program would reach, given this account and this clock. */
function verdict(info, expectedFeed, maxAge, now) {
  if (!info) return { ok: false, why: "no account" };
  const d = Buffer.from(info.data[0], "base64");
  if (info.owner !== RECEIVER) return { ok: false, why: `owner ${info.owner}` };
  if (d.length < PUBLISH_TIME + 8) return { ok: false, why: `${d.length} bytes` };
  if (d[VERIFICATION_LEVEL] !== FULL) {
    return { ok: false, why: `verification ${d[VERIFICATION_LEVEL]}, not Full` };
  }
  if (d.subarray(FEED_ID, FEED_ID + 32).toString("hex") !== expectedFeed) {
    return { ok: false, why: "feed id mismatch" };
  }
  const age = now - Number(d.readBigInt64LE(PUBLISH_TIME));
  const price = Number(d.readBigInt64LE(PRICE)) * 10 ** d.readInt32LE(EXPO);
  if (age > maxAge) return { ok: false, why: `stale ${(age / 86400).toFixed(1)}d`, price, age };
  return { ok: true, price, age };
}

const rpc = createSolanaRpc(RPC_URL);
const now = Math.floor(Date.now() / 1000);

const solAccount = await feedAccount(SOL_FEED);
const { value: solInfo } = await rpc
  .getAccountInfo(solAccount, { encoding: "base64", commitment: "confirmed" })
  .send();
const sol = verdict(solInfo, SOL_FEED, MAX_SOL_AGE, now);
console.log(
  `SOL/USD  ${sol.ok ? `$${sol.price.toFixed(2)} (${sol.age}s old)` : `UNUSABLE — ${sol.why}`}\n`,
);

let blocked = 0;
for (const tracker of TRACKERS) {
  const legs = tracker.legs.filter((l) => l.tokenized && l.xstock);
  const addrs = [];
  for (const l of legs) addrs.push(await feedAccount(LEG_BINDINGS[l.xstock].pythFeed));
  const { value } = await rpc
    .getMultipleAccounts(addrs, { encoding: "base64", commitment: "confirmed" })
    .send();

  const results = legs.map((l, i) =>
    verdict(value[i], LEG_BINDINGS[l.xstock].pythFeed, MAX_EQUITY_AGE, now),
  );
  const usable = results.filter((r) => r.ok).length;
  const can = usable === legs.length && sol.ok;
  if (!can) blocked++;

  console.log(`${tracker.ticker}  ${usable}/${legs.length} legs priceable  ${can ? "OK" : "CANNOT BE VALUED"}`);
  for (let i = 0; i < legs.length; i++) {
    const r = results[i];
    console.log(
      `  ${legs[i].xstock.padEnd(7)}${r.ok ? `$${r.price.toFixed(2)} (${(r.age / 86400).toFixed(1)}d)` : r.why}`,
    );
  }
  console.log();
}

console.log(
  blocked
    ? `${blocked}/${TRACKERS.length} trackers cannot be valued from on-chain push accounts.\n` +
        `Deposits into them revert rather than mispricing. Posting the price\n` +
        `updates from Hermes in the deposit transaction is the fix.`
    : `All ${TRACKERS.length} trackers are priceable.`,
);
process.exit(blocked ? 1 : 0);
