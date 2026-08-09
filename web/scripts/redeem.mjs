/**
 * CLI smoke test for redeem_for_sol, mirroring the site's account order.
 *
 *   node scripts/redeem.mjs mbtSOL 0.1
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
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getStructEncoder,
  getBytesEncoder,
  getU64Encoder,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = "8cKanyTRdgbdf8eWiLpqzy3kwzsXWXNxQdd6NRauCSNK";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const [ticker, shareAmount] = process.argv.slice(2);
if (!ticker || !shareAmount) {
  console.error("usage: node scripts/redeem.mjs <ticker> <shares>");
  process.exit(1);
}

const utf8 = new TextEncoder();
const addrEnc = getAddressEncoder();
const pda = async (programAddress, seeds) =>
  (await getProgramDerivedAddress({ programAddress, seeds }))[0];

const secret = JSON.parse(
  await readFile(
    process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json"),
    "utf8",
  ),
);
const signer = await createKeyPairSignerFromBytes(new Uint8Array(secret));

const tracker = await pda(PROGRAM_ID, [utf8.encode("tracker"), utf8.encode(ticker)]);
const trackerSeed = new Uint8Array(addrEnc.encode(tracker));
const vault = await pda(PROGRAM_ID, [utf8.encode("vault"), trackerSeed]);
const mint = await pda(PROGRAM_ID, [utf8.encode("share"), trackerSeed]);
const ata = await pda(ATA_PROGRAM, [
  new Uint8Array(addrEnc.encode(signer.address)),
  new Uint8Array(addrEnc.encode(TOKEN_PROGRAM)),
  new Uint8Array(addrEnc.encode(mint)),
]);

const data = getStructEncoder([
  ["disc", getBytesEncoder()],
  ["sharesIn", getU64Encoder()],
  ["minLamportsOut", getU64Encoder()],
]).encode({
  disc: new Uint8Array([60, 155, 227, 70, 252, 132, 98, 231]),
  sharesIn: BigInt(Math.round(Number(shareAmount) * 1e9)),
  minLamportsOut: 0n,
});

const instruction = {
  programAddress: PROGRAM_ID,
  accounts: [
    { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
    { address: tracker, role: AccountRole.WRITABLE },
    { address: mint, role: AccountRole.WRITABLE },
    { address: vault, role: AccountRole.WRITABLE },
    { address: signer.address, role: AccountRole.WRITABLE },
    { address: ata, role: AccountRole.WRITABLE },
    { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
  ],
  data,
};

const rpc = createSolanaRpc(RPC_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({
  rpc,
  rpcSubscriptions: createSolanaRpcSubscriptions(RPC_URL.replace(/^http/, "ws")),
});

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
console.log(`redeemed ${shareAmount} ${ticker} for SOL`);
console.log(`tx ${getSignatureFromTransaction(signed)}`);
