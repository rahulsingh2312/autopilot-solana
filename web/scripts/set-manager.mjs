/**
 * Hand the manager role to a dedicated key.
 *
 * The manager can reposition the basket and nothing else: no upgrade, no
 * withdrawal, no fee or pause changes. Those stay with the authority. That
 * split is what makes it safe for a server to hold a key at all — the process
 * that reacts to deposits and redemptions needs to trade, and needs to be
 * unable to do anything worse if it is compromised.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AccountRole, addSignersToTransactionMessage, appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes, createSolanaRpc, createTransactionMessage,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { LIVE_TRACKERS } from "../src/lib/config.ts";
import { decodeTracker, findTrackerPda } from "../src/lib/vault/program.ts";
import { rpcRetry } from "./lib/vault-ops.mjs";

const PROGRAM_ID = "7Z3DAC8q4vgFr2ofxXonHT2jgJx3xk1bmQHsRjUmVAnY";
const IX_SET_MANAGER = 12;
const rpc = createSolanaRpc(process.env.RPC_URL);
const authority = await createKeyPairSignerFromBytes(
  new Uint8Array(JSON.parse(await readFile(process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json"), "utf8"))),
);
const NEW_MANAGER = process.argv[2];
if (!NEW_MANAGER) { console.error("usage: set-manager.mjs <pubkey>"); process.exit(1); }
const SEND = process.env.SEND === "1";

for (const t of LIVE_TRACKERS) {
  const tracker = await findTrackerPda(t.ticker);
  const { value: info } = await rpcRetry(() => rpc.getAccountInfo(tracker, { encoding: "base64", commitment: "confirmed" }).send());
  if (!info) { console.log(`${t.ticker.padEnd(9)} not initialized`); continue; }
  const decoded = decodeTracker(Uint8Array.from(Buffer.from(info.data[0], "base64")));
  if (decoded.manager === NEW_MANAGER) { console.log(`${t.ticker.padEnd(9)} already ${NEW_MANAGER.slice(0, 8)}…`); continue; }
  if (decoded.authority !== authority.address) { console.log(`${t.ticker.padEnd(9)} SKIPPED — not the authority`); continue; }

  const ix = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: authority.address, role: AccountRole.READONLY_SIGNER },
      { address: tracker, role: AccountRole.WRITABLE },
      { address: NEW_MANAGER, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([IX_SET_MANAGER]),
  };
  const { value: blockhash } = await rpcRetry(() => rpc.getLatestBlockhash().send());
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(authority, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([ix], m),
    (m) => addSignersToTransactionMessage([authority], m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  const wire = getBase64EncodedWireTransaction(signed);
  const { value: sim } = await rpcRetry(() => rpc.simulateTransaction(wire, { encoding: "base64", commitment: "confirmed", replaceRecentBlockhash: false, sigVerify: true }).send());
  if (sim.err) { console.log(`${t.ticker.padEnd(9)} FAILED ${JSON.stringify(sim.err)}`); continue; }
  if (!SEND) { console.log(`${t.ticker.padEnd(9)} would set manager -> ${NEW_MANAGER.slice(0, 8)}…`); continue; }
  const sig = getSignatureFromTransaction(signed);
  await rpcRetry(() => rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send());
  for (let i = 0; i < 60; i++) {
    const { value } = await rpcRetry(() => rpc.getSignatureStatuses([sig]).send());
    if (value[0]?.err) throw new Error(JSON.stringify(value[0].err));
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`${t.ticker.padEnd(9)} manager -> ${NEW_MANAGER.slice(0, 8)}…  ${sig}`);
}
