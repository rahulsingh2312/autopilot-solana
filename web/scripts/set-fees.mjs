/**
 * Sets deposit and redemption fees on every tracker.
 *
 *   node scripts/set-fees.mjs 10 10    # 0.001% in, 0.001% out
 *   node scripts/set-fees.mjs 0 0      # free
 *
 * Fees are parts per million against a 1,000,000 denominator, so one unit is
 * 0.0001%. 0.001% is 10 ppm.
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
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getBytesEncoder,
  getStructEncoder,
  getU16Encoder,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

// No default endpoint: this line used to carry a Helius key inline, in a file
// committed to a public repository. Pass RPC_URL explicitly.
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("RPC_URL is required");
  process.exit(1);
}
const PROGRAM_ID =
  process.env.PROGRAM_ID ?? "7Z3DAC8q4vgFr2ofxXonHT2jgJx3xk1bmQHsRjUmVAnY";
// One byte, not an Anchor sighash: this targets the Pinocchio program.
const IX_SET_FEES = 8;
const MAX_FEE_PPM = 30_000; // 3%, mirrors the program's compiled ceiling

const TICKERS = ["mbtSOL", "icSOL", "pltSOL", "cgSOL", "bwSOL", "jstSOL", "psqSOL"];

const depositPpm = Number(process.argv[2] ?? 1);
const redeemPpm = Number(process.argv[3] ?? depositPpm);

for (const [name, value] of [
  ["deposit", depositPpm],
  ["redeem", redeemPpm],
]) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_FEE_PPM) {
    console.error(
      `${name} fee must be a whole number of parts per million between 0 and ${MAX_FEE_PPM}. ` +
        `Got ${value}. One ppm is 0.0001%.`,
    );
    process.exit(1);
  }
}

const utf8 = new TextEncoder();
const secret = JSON.parse(
  await readFile(
    process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json"),
    "utf8",
  ),
);
const signer = await createKeyPairSignerFromBytes(new Uint8Array(secret));

const rpc = createSolanaRpc(RPC_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({
  rpc,
  rpcSubscriptions: createSolanaRpcSubscriptions(RPC_URL.replace(/^http/, "ws")),
});

const data = getStructEncoder([
  ["disc", getBytesEncoder()],
  ["depositFeePpm", getU16Encoder()],
  ["redeemFeePpm", getU16Encoder()],
]).encode({ disc: new Uint8Array([IX_SET_FEES]), depositFeePpm: depositPpm, redeemFeePpm: redeemPpm });

console.log(
  `setting fees to ${(depositPpm / 10_000).toFixed(4)}% in / ` +
    `${(redeemPpm / 10_000).toFixed(4)}% out\n`,
);

for (const ticker of TICKERS) {
  const [tracker] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [utf8.encode("tracker"), utf8.encode(ticker)],
  });

  const { value: existing } = await rpc
    .getAccountInfo(tracker, { encoding: "base64" })
    .send();
  if (!existing) {
    console.log(`${ticker.padEnd(8)} not initialized, skipped`);
    continue;
  }

  const instruction = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: signer.address, role: AccountRole.READONLY_SIGNER },
      { address: tracker, role: AccountRole.WRITABLE },
    ],
    data,
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
  console.log(`${ticker.padEnd(8)} updated  ${getSignatureFromTransaction(signed)}`);
}
