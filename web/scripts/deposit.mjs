/**
 * CLI smoke test for the deposit instruction: deposits real devnet SOL into a
 * tracker with the same account order the site uses.
 *
 *   node scripts/deposit.mjs mbtSOL 0.3
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

const [ticker, solAmount] = process.argv.slice(2);
if (!ticker || !solAmount) {
  console.error("usage: node scripts/deposit.mjs <ticker> <sol>");
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

const lamports = BigInt(Math.round(Number(solAmount) * 1e9));

const data = getStructEncoder([
  ["disc", getBytesEncoder()],
  ["lamportsIn", getU64Encoder()],
  ["minSharesOut", getU64Encoder()],
]).encode({
  disc: new Uint8Array([242, 35, 198, 137, 82, 225, 242, 182]),
  lamportsIn: lamports,
  minSharesOut: 0n,
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
    { address: ATA_PROGRAM, role: AccountRole.READONLY },
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

console.log(`deposited ${solAmount} SOL into ${ticker}`);
console.log(`tx ${getSignatureFromTransaction(signed)}`);

const { value } = await rpc
  .getTokenAccountBalance(ata, { commitment: "confirmed" })
  .send();
console.log(`share balance: ${value.uiAmountString} ${ticker}`);
