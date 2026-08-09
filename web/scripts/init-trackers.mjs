/**
 * Initializes the curated trackers on whichever cluster CLUSTER points at.
 *
 * Idempotent: a tracker whose PDA already holds an account is skipped, so this
 * is safe to re-run after a partial failure.
 *
 *   node scripts/init-trackers.mjs                  # devnet, ~/.config/solana/id.json
 *   CLUSTER=mainnet-beta node scripts/init-trackers.mjs
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
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressEncoder,
  getBytesEncoder,
  getI64Encoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getU16Encoder,
  getU32Encoder,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

const CLUSTER = process.env.CLUSTER ?? "devnet";
const RPC_URL =
  process.env.RPC_URL ??
  (CLUSTER === "devnet"
    ? "https://api.devnet.solana.com"
    : "https://api.mainnet-beta.solana.com");
const WS_URL = RPC_URL.replace(/^http/, "ws");

const PROGRAM_ID = "8cKanyTRdgbdf8eWiLpqzy3kwzsXWXNxQdd6NRauCSNK";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111";
const ZERO_ADDRESS = "11111111111111111111111111111111";

const INITIALIZE_TRACKER = new Uint8Array([
  27, 157, 128, 87, 48, 201, 132, 35,
]);

/**
 * Legs carry the zero mint on devnet: no tokenized equity exists here, so the
 * program routes that weight to the SOL sleeve and the UI says so. Binding
 * real xStocks mints is a mainnet-only change.
 */
const TRACKERS = [
  {
    ticker: "mbtSOL",
    name: "Michael Burry Tracker",
    depositFeeBps: 50,
    redeemFeeBps: 50,
    rebalanceInterval: 0,
    filingDelayDays: 0,
    legs: [
      { symbol: "MOH", weightBps: 3511 },
      { symbol: "LULU", weightBps: 2611 },
      { symbol: "SLM", weightBps: 1950 },
      { symbol: "BRKR", weightBps: 1928 },
    ],
  },
  {
    ticker: "icSOL",
    name: "Inverse Cramer Index",
    depositFeeBps: 50,
    redeemFeeBps: 50,
    rebalanceInterval: 2_592_000,
    filingDelayDays: 0,
    legs: [
      { symbol: "NVDAx", weightBps: 2500 },
      { symbol: "TSLAx", weightBps: 2000 },
      { symbol: "MSTRx", weightBps: 1500 },
      { symbol: "COINx", weightBps: 1500 },
      { symbol: "HOODx", weightBps: 1500 },
      { symbol: "CRCLx", weightBps: 1000 },
    ],
  },
  {
    ticker: "pltSOL",
    name: "Pelosi Tracker",
    depositFeeBps: 50,
    redeemFeeBps: 50,
    rebalanceInterval: 0,
    filingDelayDays: 45,
    legs: [
      { symbol: "AVGO", weightBps: 2500 },
      { symbol: "NVDAx", weightBps: 2500 },
      { symbol: "PANW", weightBps: 1500 },
      { symbol: "AAPLx", weightBps: 1250 },
      { symbol: "GOOGLx", weightBps: 1250 },
      { symbol: "TEM", weightBps: 1000 },
    ],
  },
  {
    ticker: "cgSOL",
    name: "Congress Tracker",
    depositFeeBps: 50,
    redeemFeeBps: 50,
    rebalanceInterval: 7776000,
    filingDelayDays: 45,
    legs: [
      { symbol: "NVDAx", weightBps: 2000 },
      { symbol: "MSFTx", weightBps: 2000 },
      { symbol: "AAPLx", weightBps: 2000 },
      { symbol: "AMZNx", weightBps: 2000 },
      { symbol: "GOOGLx", weightBps: 2000 },
    ],
  },
  {
    ticker: "bwSOL",
    name: "Buffett Tracker",
    depositFeeBps: 50,
    redeemFeeBps: 50,
    rebalanceInterval: 7776000,
    filingDelayDays: 45,
    legs: [
      { symbol: "AAPLx", weightBps: 2680 },
      { symbol: "AXP", weightBps: 2120 },
      { symbol: "KO", weightBps: 1410 },
      { symbol: "BAC", weightBps: 1290 },
      { symbol: "CVX", weightBps: 1250 },
      { symbol: "GOOGLx", weightBps: 1250 },
    ],
  },
  {
    ticker: "jstSOL",
    name: "Jim Simons Tracker",
    depositFeeBps: 50,
    redeemFeeBps: 50,
    rebalanceInterval: 7776000,
    filingDelayDays: 45,
    legs: [
      { symbol: "UTHR", weightBps: 2400 },
      { symbol: "PLTRx", weightBps: 2300 },
      { symbol: "AAPLx", weightBps: 1800 },
      { symbol: "KGC", weightBps: 1800 },
      { symbol: "MU", weightBps: 1700 },
    ],
  },
  {
    ticker: "psqSOL",
    name: "Ackman Tracker",
    depositFeeBps: 50,
    redeemFeeBps: 50,
    rebalanceInterval: 7776000,
    filingDelayDays: 45,
    legs: [
      { symbol: "BN", weightBps: 2200 },
      { symbol: "AMZNx", weightBps: 2150 },
      { symbol: "UBER", weightBps: 1950 },
      { symbol: "MSFTx", weightBps: 1900 },
      { symbol: "QSR", weightBps: 1800 },
    ],
  },
];

const utf8 = new TextEncoder();
const addrEnc = getAddressEncoder();
const u16 = getU16Encoder();
const u32 = getU32Encoder();
const i64 = getI64Encoder();

const concat = (chunks) => {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
};

const encodeString = (value) => {
  const bytes = utf8.encode(value);
  return concat([new Uint8Array(u32.encode(bytes.length)), bytes]);
};

function encodeInitializeData(tracker) {
  const legs = tracker.legs.map((leg) =>
    concat([
      new Uint8Array(addrEnc.encode(ZERO_ADDRESS)),
      encodeString(leg.symbol),
      new Uint8Array(u16.encode(leg.weightBps)),
    ]),
  );

  return concat([
    INITIALIZE_TRACKER,
    encodeString(tracker.ticker),
    encodeString(tracker.name),
    new Uint8Array(u32.encode(legs.length)),
    ...legs,
    new Uint8Array(u16.encode(tracker.depositFeeBps)),
    new Uint8Array(u16.encode(tracker.redeemFeeBps)),
    new Uint8Array(i64.encode(BigInt(tracker.rebalanceInterval))),
    new Uint8Array(u16.encode(tracker.filingDelayDays)),
  ]);
}

async function pda(seeds) {
  const [address] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds,
  });
  return address;
}

async function main() {
  const keypairPath =
    process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json");
  const secret = JSON.parse(await readFile(keypairPath, "utf8"));
  const signer = await createKeyPairSignerFromBytes(new Uint8Array(secret));

  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });

  console.log(`cluster   ${CLUSTER}`);
  console.log(`authority ${signer.address}`);

  const { value: balance } = await rpc.getBalance(signer.address).send();
  console.log(`balance   ${Number(balance) / 1e9} SOL\n`);

  for (const tracker of TRACKERS) {
    const trackerPda = await pda([utf8.encode("tracker"), utf8.encode(tracker.ticker)]);
    const vaultPda = await pda([
      utf8.encode("vault"),
      new Uint8Array(addrEnc.encode(trackerPda)),
    ]);
    const mintPda = await pda([
      utf8.encode("share"),
      new Uint8Array(addrEnc.encode(trackerPda)),
    ]);

    const { value: existing } = await rpc.getAccountInfo(trackerPda, { encoding: "base64" }).send();
    if (existing) {
      console.log(`${tracker.ticker.padEnd(8)} already initialized  ${trackerPda}`);
      continue;
    }

    const instruction = {
      programAddress: PROGRAM_ID,
      accounts: [
        { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: signer.address, role: AccountRole.READONLY },
        { address: trackerPda, role: AccountRole.WRITABLE },
        { address: mintPda, role: AccountRole.WRITABLE },
        { address: vaultPda, role: AccountRole.WRITABLE },
        { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        { address: RENT_SYSVAR, role: AccountRole.READONLY },
      ],
      data: encodeInitializeData(tracker),
    };

    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions([instruction], m),
      (m) => addSignersToTransactionMessage([signer], m),
    );

    const signed = await signTransactionMessageWithSigners(message);
    await sendAndConfirm(signed, { commitment: "confirmed" });

    console.log(`${tracker.ticker.padEnd(8)} initialized`);
    console.log(`  tracker ${trackerPda}`);
    console.log(`  vault   ${vaultPda}`);
    console.log(`  mint    ${mintPda}`);
    console.log(`  tx      ${getSignatureFromTransaction(signed)}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
