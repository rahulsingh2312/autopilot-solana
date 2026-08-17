/**
 * Creates the vault's token account for every tokenized leg.
 *
 *   RPC_URL=... SOLANA_KEYPAIR=... CLUSTER=mainnet-beta \
 *     node --experimental-strip-types scripts/create-vault-atas.mjs
 *
 * # Why this is required before the first deposit
 *
 * `value_tokenized_legs` calls `read_token_account` on the vault's account for
 * each leg and checks its mint and owner. It does not tolerate the account
 * being absent: a missing account is system-owned, so it fails as
 * `InvalidAccountOwner` and the whole deposit reverts. An empty balance is
 * fine — a vault that holds no NVDAx yet still values that leg at zero — but
 * the account has to be there to hold the zero.
 *
 * So every tracker needs one account per leg before it can take a deposit, and
 * that is 23 accounts across the four baskets. Creating them is permissionless
 * and idempotent, so this is safe to re-run and safe for anyone to have already
 * run.
 *
 * # Token-2022, not classic
 *
 * The token program is a seed of the address. Every leg is Token-2022 and the
 * share mint is classic SPL, so the two halves of this program derive accounts
 * under different programs — deriving a leg's account with the classic program
 * produces a valid address that will simply never exist. The token program per
 * mint is recorded in `leg-bindings.json`, verified on chain, rather than
 * assumed here.
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

import { TRACKERS } from "../src/lib/config.ts";
import { legBinding } from "../src/lib/leg-bindings.ts";

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("RPC_URL is required");
  process.exit(1);
}
const PROGRAM_ID =
  process.env.PROGRAM_ID ?? "7Z3DAC8q4vgFr2ofxXonHT2jgJx3xk1bmQHsRjUmVAnY";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** `CreateIdempotent`, not `Create` — re-running must not fail. */
const IX_CREATE_IDEMPOTENT = new Uint8Array([1]);

/**
 * Accounts per transaction.
 *
 * Each creation is six accounts and a one-byte payload, so a dozen fits inside
 * the 1232-byte limit comfortably. Eight keeps headroom and keeps a failure
 * from costing much.
 */
const PER_TX = 8;

const utf8 = new TextEncoder();
const addrEnc = getAddressEncoder();

const pda = async (seeds, programAddress = PROGRAM_ID) =>
  (await getProgramDerivedAddress({ programAddress, seeds }))[0];

const findAta = (owner, mint, tokenProgram) =>
  pda(
    [addrEnc.encode(owner), addrEnc.encode(tokenProgram), addrEnc.encode(mint)],
    ATA_PROGRAM,
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (e) =>
  e?.context?.statusCode === 429 || String(e?.message ?? "").includes("429");

async function rpcRetry(fn, attempts = 8) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimit(e) || i >= attempts - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

async function main() {
  const keypairPath =
    process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json");
  const signer = await createKeyPairSignerFromBytes(
    new Uint8Array(JSON.parse(await readFile(keypairPath, "utf8"))),
  );
  const rpc = createSolanaRpc(RPC_URL);

  console.log(`payer     ${signer.address}`);
  const { value: before } = await rpcRetry(() => rpc.getBalance(signer.address).send());
  console.log(`balance   ${Number(before) / 1e9} SOL\n`);

  // Collect every (vault, leg) pair first, then check which already exist, so
  // a re-run sends nothing at all rather than 23 no-op instructions.
  const wanted = [];
  for (const tracker of TRACKERS) {
    const trackerPda = await pda([utf8.encode("tracker"), utf8.encode(tracker.ticker)]);
    const vault = await pda([
      utf8.encode("vault"),
      new Uint8Array(addrEnc.encode(trackerPda)),
    ]);
    for (const leg of tracker.legs) {
      if (!leg.tokenized || !leg.xstock) continue;
      const b = legBinding(leg.xstock);
      wanted.push({
        ticker: tracker.ticker,
        sym: leg.xstock,
        vault,
        mint: b.mint,
        tokenProgram: b.tokenProgram,
        ata: await findAta(vault, b.mint, b.tokenProgram),
      });
    }
  }

  const existing = new Set();
  for (let i = 0; i < wanted.length; i += 100) {
    const slice = wanted.slice(i, i + 100);
    const { value } = await rpcRetry(() =>
      rpc.getMultipleAccounts(slice.map((w) => w.ata), { encoding: "base64" }).send(),
    );
    value.forEach((v, j) => v && existing.add(slice[j].ata));
  }

  const todo = wanted.filter((w) => !existing.has(w.ata));
  for (const w of wanted) {
    console.log(
      `${w.ticker.padEnd(9)}${w.sym.padEnd(8)}${w.ata}  ${existing.has(w.ata) ? "exists" : "create"}`,
    );
  }

  if (todo.length === 0) {
    console.log(`\nall ${wanted.length} vault token accounts already exist`);
    return;
  }
  console.log(`\ncreating ${todo.length} of ${wanted.length}`);

  for (let i = 0; i < todo.length; i += PER_TX) {
    const batch = todo.slice(i, i + PER_TX);
    const instructions = batch.map((w) => ({
      programAddress: ATA_PROGRAM,
      accounts: [
        { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: w.ata, role: AccountRole.WRITABLE },
        // The owner is a PDA. It never signs for its own token account —
        // creating one is permissionless, which is what makes this script
        // something anyone could have run on our behalf.
        { address: w.vault, role: AccountRole.READONLY },
        { address: w.mint, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        { address: w.tokenProgram, role: AccountRole.READONLY },
      ],
      data: IX_CREATE_IDEMPOTENT,
    }));

    const { value: blockhash } = await rpcRetry(() => rpc.getLatestBlockhash().send());
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
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

    for (let attempt = 0; attempt < 60; attempt++) {
      const { value } = await rpcRetry(() => rpc.getSignatureStatuses([sig]).send());
      const status = value[0];
      if (status?.err) throw new Error(`failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
      await sleep(1000);
    }
    console.log(`  ${batch.length} created  ${sig}`);
  }

  const { value: after } = await rpcRetry(() => rpc.getBalance(signer.address).send());
  console.log(
    `\n${todo.length} created; ${Number(before - after) / 1e9} SOL spent, ${Number(after) / 1e9} SOL left`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
