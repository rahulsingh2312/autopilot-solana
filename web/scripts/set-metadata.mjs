/**
 * Creates Metaplex token metadata for each tracker's share mint, via the
 * program's set_token_metadata instruction (the mint authority is a PDA, so
 * only the program can sign the CPI).
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
  getBytesEncoder,
  getU32Encoder,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

const RPC_URL =
  process.env.RPC_URL ??
  "https://devnet.helius-rpc.com/?api-key=397b5828-cbba-479e-992e-7000c78d482b";
const PROGRAM_ID = "8cKanyTRdgbdf8eWiLpqzy3kwzsXWXNxQdd6NRauCSNK";
const METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111";
const SITE = "https://autopilot-solana.vercel.app";

const SET_METADATA_DISC = new Uint8Array([218, 126, 122, 193, 220, 149, 103, 39]);

const TOKENS = [
  {
    ticker: "mbtSOL",
    name: "Michael Burry Tracker",
    symbol: "mbtSOL",
    uri: `${SITE}/tokens/mbtsol.json`,
  },
  {
    ticker: "icSOL",
    name: "Inverse Cramer Index",
    symbol: "icSOL",
    uri: `${SITE}/tokens/icsol.json`,
  },
  {
    ticker: "pltSOL",
    name: "Pelosi Tracker",
    symbol: "pltSOL",
    uri: `${SITE}/tokens/pltsol.json`,
  },
  {
    ticker: "cgSOL",
    name: "Congress Tracker",
    symbol: "cgSOL",
    uri: `${SITE}/tokens/cgsol.json`,
  },
  {
    ticker: "bwSOL",
    name: "Buffett Tracker",
    symbol: "bwSOL",
    uri: `${SITE}/tokens/bwsol.json`,
  },
  {
    ticker: "jstSOL",
    name: "Jim Simons Tracker",
    symbol: "jstSOL",
    uri: `${SITE}/tokens/jstsol.json`,
  },
  {
    ticker: "psqSOL",
    name: "Ackman Tracker",
    symbol: "psqSOL",
    uri: `${SITE}/tokens/psqsol.json`,
  },
];

const utf8 = new TextEncoder();
const addrEnc = getAddressEncoder();
const u32 = getU32Encoder();

const concat = (chunks) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
};
const str = (v) => {
  const b = utf8.encode(v);
  return concat([new Uint8Array(u32.encode(b.length)), b]);
};
const pda = async (programAddress, seeds) =>
  (await getProgramDerivedAddress({ programAddress, seeds }))[0];

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

for (const token of TOKENS) {
  const tracker = await pda(PROGRAM_ID, [utf8.encode("tracker"), utf8.encode(token.ticker)]);
  const mint = await pda(PROGRAM_ID, [
    utf8.encode("share"),
    new Uint8Array(addrEnc.encode(tracker)),
  ]);
  const metadata = await pda(METADATA_PROGRAM, [
    utf8.encode("metadata"),
    new Uint8Array(addrEnc.encode(METADATA_PROGRAM)),
    new Uint8Array(addrEnc.encode(mint)),
  ]);

  const { value: existing } = await rpc.getAccountInfo(metadata, { encoding: "base64" }).send();
  if (existing) {
    console.log(`${token.ticker.padEnd(8)} metadata already exists  ${metadata}`);
    continue;
  }

  const instruction = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: tracker, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: metadata, role: AccountRole.WRITABLE },
      { address: METADATA_PROGRAM, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: RENT_SYSVAR, role: AccountRole.READONLY },
    ],
    data: concat([SET_METADATA_DISC, str(token.name), str(token.symbol), str(token.uri)]),
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

  console.log(`${token.ticker.padEnd(8)} metadata created`);
  console.log(`  mint     ${mint}`);
  console.log(`  metadata ${metadata}`);
  console.log(`  tx       ${getSignatureFromTransaction(signed)}\n`);
}
