/**
 * RPC handles, the operator signer, and one way to send a transaction.
 *
 * The send path mirrors `web/scripts/*.mjs` exactly — same builder pipeline,
 * same commitment — so a transaction the worker sends is indistinguishable
 * from one an operator sent by hand. That matters when something goes wrong at
 * 4am and the question is "did the worker do this, or did I?"
 */

import {
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";

import { env } from "../env.ts";
import { log } from "../log.ts";

export const rpc = createSolanaRpc(env.rpcUrl);
export const rpcSubscriptions = createSolanaRpcSubscriptions(env.rpcWsUrl);

const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

let cachedSigner: KeyPairSigner | null = null;

/**
 * The operator keypair, or null when the worker was started without one.
 *
 * Read-only operation is a supported mode, not a broken one: ingestion,
 * planning, and the whole HTTP surface work without a key, and the admin panel
 * shows plans it cannot send.
 */
export async function getSigner(): Promise<KeyPairSigner | null> {
  if (!env.signerBytes) return null;
  cachedSigner ??= await createKeyPairSignerFromBytes(env.signerBytes);
  return cachedSigner;
}

export async function requireSigner(): Promise<KeyPairSigner> {
  const signer = await getSigner();
  if (!signer) {
    throw new Error(
      "worker is read-only: set SIGNER_KEYPAIR_PATH or SIGNER_SECRET_KEY to sign",
    );
  }
  return signer;
}

export type SendOptions = {
  /** Simulate and report, without sending. Used by the admin panel's preview. */
  dryRun?: boolean;
  /** Extra signers beyond the fee payer. */
  additionalSigners?: KeyPairSigner[];
  /** Address lookup tables, required once Jupiter routes are in the message. */
  addressLookupTables?: Record<Address, Address[]>;
};

export type SendResult = {
  signature: string | null;
  simulated: boolean;
  unitsConsumed?: number;
  logs?: string[];
};

/**
 * Builds, simulates, and sends one transaction.
 *
 * Simulation is not optional. Every instruction this worker sends is either a
 * basket change or a swap, and a failed landing costs a fee and leaves the
 * published weights disagreeing with the vault's actual holdings. Failing in
 * simulation is free; failing on chain is not.
 */
export async function sendInstructions(
  instructions: Instruction[],
  options: SendOptions = {},
): Promise<SendResult> {
  const signer = await requireSigner();
  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => addSignersToTransactionMessage([signer, ...(options.additionalSigners ?? [])], m),
  );

  // The message was built with a blockhash lifetime a few lines up, but the
  // signed type widens to "blockhash or durable nonce" and `sendAndConfirm`
  // only accepts the former. Asserting narrows it back to what we built.
  const signed = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signed);

  const simulation = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: "base64",
      commitment: "confirmed",
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();

  if (simulation.value.err) {
    const logs = simulation.value.logs ?? [];
    log.error("simulation failed", {
      err: JSON.stringify(simulation.value.err),
      logs: logs.slice(-6),
    });
    throw new Error(
      `simulation failed: ${explainLogs(logs) ?? JSON.stringify(simulation.value.err)}`,
    );
  }

  const unitsConsumed = Number(simulation.value.unitsConsumed ?? 0n);

  if (options.dryRun) {
    return {
      signature: null,
      simulated: true,
      unitsConsumed,
      logs: simulation.value.logs ?? [],
    };
  }

  await sendAndConfirm(signed, { commitment: "confirmed" });
  const signature = getSignatureFromTransaction(signed);
  log.info("transaction confirmed", { signature, unitsConsumed });

  return { signature, simulated: false, unitsConsumed };
}

/**
 * Pulls the program's own error message out of simulation logs.
 *
 * Anchor prints `Error Message: <text>` next to the code, which is far more
 * use in an alert than `custom program error: 0x1771`.
 */
export function explainLogs(logs: string[]): string | null {
  for (const line of logs) {
    const match = /Error Message: (.+?)\.?$/.exec(line);
    if (match?.[1]) return match[1];
  }
  const failure = logs.find((line) => line.includes("failed:"));
  return failure ?? null;
}
