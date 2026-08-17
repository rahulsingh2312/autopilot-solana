/**
 * Deposit and redeem against mainnet, through the frontend's own builders.
 *
 *   RPC_URL=... SOLANA_KEYPAIR=... node --experimental-strip-types \
 *     scripts/mainnet-smoke.mjs [ticker] [lamports]
 *
 * Defaults to simulating. `SEND=1` makes it real.
 *
 * # Why it imports from `src/lib`
 *
 * The point is not to check that *a* deposit works — it is to check that the
 * deposit **the website builds** works. So this imports `getDepositInstruction`
 * and `buildOracleAccounts` rather than re-deriving the accounts, and a bug in
 * either shows up here instead of in a user's wallet. A hand-rolled copy of the
 * account list would pass while the site failed, which is the failure mode
 * worth designing against.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
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

import { TRACKERS, shareMintOf } from "../src/lib/config.ts";
import { tokenProgramOfMint } from "../src/lib/leg-bindings.ts";
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getDepositInstruction,
  getRedeemForSolInstruction,
} from "../src/lib/vault/instructions.ts";
import { buildOracleAccounts } from "../src/lib/vault/oracle.ts";
import {
  decodeTracker,
  findAssociatedTokenPda,
  findTrackerPda,
  findVaultPda,
} from "../src/lib/vault/program.ts";

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("RPC_URL is required");
  process.exit(1);
}
const SEND = process.env.SEND === "1";
const TICKER = process.argv[2] ?? "mg7SOL";
const LAMPORTS = BigInt(process.argv[3] ?? 10_000_000); // 0.01 SOL

if (!TRACKERS.some((t) => t.ticker === TICKER)) {
  console.error(`unknown tracker ${TICKER}`);
  process.exit(1);
}

const rpc = createSolanaRpc(RPC_URL);
const signer = await createKeyPairSignerFromBytes(
  new Uint8Array(
    JSON.parse(
      await readFile(
        process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json"),
        "utf8",
      ),
    ),
  ),
);

const trackerAddress = await findTrackerPda(TICKER);
const vaultAddress = await findVaultPda(trackerAddress);
const shareMint = shareMintOf(TICKER);

const { value: info } = await rpc
  .getAccountInfo(trackerAddress, { encoding: "base64", commitment: "confirmed" })
  .send();
if (!info) throw new Error(`${TICKER} does not exist on this cluster`);
const tracker = decodeTracker(
  Uint8Array.from(Buffer.from(info.data[0], "base64")),
);

const holderShares = await findAssociatedTokenPda(signer.address, shareMint);
const oracleAccounts = await buildOracleAccounts(
  tracker,
  vaultAddress,
  tokenProgramOfMint,
);

console.log(`${TICKER}  ${SEND ? "SENDING" : "simulating"}  ${Number(LAMPORTS) / 1e9} SOL`);
console.log(`  tracker  ${trackerAddress}`);
console.log(`  vault    ${vaultAddress}`);
console.log(`  legs     ${tracker.legs.length}, ${oracleAccounts.length} oracle accounts\n`);

async function run(label, instructions) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => addSignersToTransactionMessage([signer], m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);

  const { value: sim } = await rpc
    .simulateTransaction(wire, {
      encoding: "base64",
      commitment: "confirmed",
      replaceRecentBlockhash: false,
      sigVerify: true,
    })
    .send();
  if (sim.err) {
    console.error(`${label}: FAILED ${JSON.stringify(sim.err)}`);
    for (const l of sim.logs ?? []) console.error(`    ${l}`);
    process.exit(1);
  }
  console.log(`  ${label}: ok, ${sim.unitsConsumed} CU`);

  if (!SEND) return null;
  const sig = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" })
    .send();
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    if (value[0]?.err) throw new Error(`${label} failed: ${JSON.stringify(value[0].err)}`);
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") {
      console.log(`  ${label}: ${sig}`);
      return sig;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label}: timed out`);
}

await run("deposit", [
  getCreateAssociatedTokenIdempotentInstruction({
    payer: signer.address,
    owner: signer.address,
    mint: shareMint,
    ata: holderShares,
  }),
  getDepositInstruction({
    depositor: signer.address,
    tracker: trackerAddress,
    shareMint,
    vault: vaultAddress,
    feeRecipient: tracker.feeRecipient,
    depositorShares: holderShares,
    lamportsIn: LAMPORTS,
    minSharesOut: 0n,
    oracleAccounts,
  }),
]);

// Only meaningful once the deposit actually landed — simulating a redemption of
// shares that were never minted reverts, and would report a false failure.
if (SEND) {
  const { value: bal } = await rpc
    .getTokenAccountBalance(holderShares, { commitment: "confirmed" })
    .send();
  const shares = BigInt(bal.amount);
  console.log(`\n  holding ${shares} shares`);
  await run("redeem", [
    getRedeemForSolInstruction({
      holder: signer.address,
      tracker: trackerAddress,
      shareMint,
      vault: vaultAddress,
      feeRecipient: tracker.feeRecipient,
      holderShares,
      sharesIn: shares,
      minLamportsOut: 0n,
      oracleAccounts,
    }),
  ]);
}

console.log(`\n${SEND ? "lifecycle complete" : "simulation clean — set SEND=1 to run it for real"}`);
