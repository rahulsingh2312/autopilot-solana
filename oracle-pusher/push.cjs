/**
 * Keeps the on-chain Pyth price accounts fresh for every tokenized leg.
 *
 *   RPC_URL=... KEYPAIR=... node --experimental-strip-types push.mjs
 *
 * # Why this exists
 *
 * Pyth on Solana is a *pull* oracle: the canonical price lives off-chain and
 * somebody has to put it on chain. Sponsored push accounts exist at
 * `[shard_id_le_u16, feed_id]` under the push-oracle program, but they are
 * maintained per feed, and for tokenized equities most are not maintained at
 * all. Measured on 2026-08-17, of seventeen legs five had no account and eight
 * were stale past the program's four-day bound — MSFT's by forty-five days.
 *
 * The vault reads those accounts. With them stale, `value_tokenized_legs`
 * rejects the price and every deposit reverts. That is the failure behaving
 * correctly rather than a bug: MSFT's push account read $390.92 while Hermes
 * served $495.18 for the same feed, and minting against the stale number would
 * have sold shares 21% too cheap. But a product whose deposits always revert is
 * not a product, so the prices have to be pushed.
 *
 * # Cadence
 *
 * `MAX_EQUITY_PRICE_AGE_SECS` is four days, sized so a Friday close is still
 * valid on Monday. So this does not need to run continuously — once per trading
 * day, after the close, is enough to keep every leg inside the bound, and the
 * generous bound is what makes the whole approach cheap. SOL is excluded
 * deliberately: its sponsored account is actively maintained by others and sits
 * a few seconds old, well inside its own 180-second bound.
 *
 * If this job stops, deposits stop. They do not misprice. That is the correct
 * direction to fail, and it is why a missed run is an outage rather than an
 * incident.
 */

const { readFileSync } = require("node:fs");

const { Wallet } = require("@coral-xyz/anchor");
const { PythSolanaReceiver } = require("@pythnetwork/pyth-solana-receiver");
const { Connection, Keypair } = require("@solana/web3.js");

// The same file the vault was seeded from. See `web/src/lib/leg-bindings.ts`
// for why this is JSON rather than a module either side owns.
const LEG_BINDINGS = require("../web/src/lib/leg-bindings.json");

const RPC_URL = process.env.RPC_URL;
const KEYPAIR = process.env.KEYPAIR;
if (!RPC_URL || !KEYPAIR) {
  console.error("RPC_URL and KEYPAIR are required");
  process.exit(1);
}

/** Shard 0 is the sponsored-feed shard the vault's bindings point at. */
const SHARD_ID = 0;

/**
 * Priority fee.
 *
 * Not optional: an unprioritized transaction on mainnet can sit unconfirmed
 * long enough that the VAA it carries expires, and the whole batch has to be
 * rebuilt. A few thousand micro-lamports is far cheaper than a retry.
 */
const COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 50_000;

async function main() {
const feeds = Object.entries(LEG_BINDINGS).map(([sym, b]) => ({
  sym,
  id: `0x${b.pythFeed}`,
}));

const connection = new Connection(RPC_URL, "confirmed");
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8"))),
);
const wallet = new Wallet(keypair);
// The vault requires `VerificationLevel::Full`, so the partial-verification
// shortcut is not available to us — `oracle.rs` rejects anything else before it
// computes an offset, on purpose.
const receiver = new PythSolanaReceiver({ connection, wallet });

console.log(`pusher    ${keypair.publicKey.toBase58()}`);
console.log(`feeds     ${feeds.length}`);
const before = await connection.getBalance(keypair.publicKey);
console.log(`balance   ${before / 1e9} SOL\n`);

  // Imported dynamically: hermes-client ships ESM only, and this file has to be
  // CommonJS for the receiver SDK's sake — its jito helper does an
  // extensionless import that Node's ESM resolver refuses.
  const { HermesClient } = await import("@pythnetwork/hermes-client");
  const hermes = new HermesClient("https://hermes.pyth.network", {});
const update = await hermes.getLatestPriceUpdates(
  feeds.map((f) => f.id),
  { encoding: "base64" },
);

for (const p of update.parsed ?? []) {
  const sym = feeds.find((f) => f.id.slice(2) === p.id)?.sym ?? p.id.slice(0, 8);
  const age = Math.floor(Date.now() / 1000) - p.price.publish_time;
  console.log(
    `  ${sym.padEnd(8)}$${(Number(p.price.price) * 10 ** p.price.expo).toFixed(2).padStart(9)}  ${(age / 86400).toFixed(1)}d old at source`,
  );
}

// `closeUpdateAccounts: false` — these writes target the *persistent* sponsored
// accounts the vault reads, not ephemeral ones to be closed at the end of a
// transaction. Closing them is what the per-transaction pull pattern does, and
// it is the opposite of what this job is for.
const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
await builder.addUpdatePriceFeed(update.binary.data, SHARD_ID);

const txs = await builder.buildVersionedTransactions({
  computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
});
console.log(`\nsending ${txs.length} transactions`);

let sent = 0;
for (const [i, { tx, signers }] of txs.entries()) {
  tx.sign([keypair, ...signers]);
  const sig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 5,
  });
  const { value } = await connection.confirmTransaction(
    {
      signature: sig,
      ...(await connection.getLatestBlockhash("confirmed")),
    },
    "confirmed",
  );
  if (value.err) throw new Error(`tx ${i + 1} failed: ${JSON.stringify(value.err)}`);
  sent += 1;
  console.log(`  ${sent}/${txs.length}  ${sig}`);
}

const after = await connection.getBalance(keypair.publicKey);
console.log(
  `\npushed ${feeds.length} feeds in ${sent} transactions; ` +
    `${((before - after) / 1e9).toFixed(6)} SOL spent, ${after / 1e9} SOL left`,
);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
