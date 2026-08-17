/**
 * What a vault actually holds, against what it says it holds.
 *
 * Valued the way `value_tokenized_legs` values it, from the same Pyth accounts,
 * so a drift between this and on-chain NAV is a bug rather than a rounding
 * difference.
 */
import { createSolanaRpc } from "@solana/kit";
import { decodeTracker, findTrackerPda, findVaultPda } from "../src/lib/vault/program.ts";
import { LEG_BINDINGS } from "../src/lib/leg-bindings.ts";
import { findAssociatedTokenPdaFor, findPythPriceAccount } from "../src/lib/vault/oracle.ts";
import { shareMintOf, TRACKERS } from "../src/lib/config.ts";

const rpc = createSolanaRpc(process.env.RPC_URL);
const SOL_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const price = async (f) => {
  const { value } = await rpc
    .getAccountInfo(await findPythPriceAccount(f), { encoding: "base64", commitment: "confirmed" })
    .send();
  const d = Buffer.from(value.data[0], "base64");
  return Number(d.readBigInt64LE(73)) * 10 ** d.readInt32LE(89);
};

const solP = await price(SOL_FEED);
for (const cfg of TRACKERS.filter((t) => !process.argv[2] || t.ticker === process.argv[2])) {
  const tp = await findTrackerPda(cfg.ticker);
  const vault = await findVaultPda(tp);
  const { value: ti } = await rpc.getAccountInfo(tp, { encoding: "base64", commitment: "confirmed" }).send();
  if (!ti) continue;
  const t = decodeTracker(Uint8Array.from(Buffer.from(ti.data[0], "base64")));
  const { value: lam } = await rpc.getBalance(vault, { commitment: "confirmed" }).send();
  const sleeve = BigInt(lam) - t.rentReserve;
  let legTotal = 0n;
  const rows = [];
  for (const leg of t.legs) {
    const b = Object.values(LEG_BINDINGS).find((x) => x.mint === leg.mint);
    if (!b) continue;
    const ata = await findAssociatedTokenPdaFor(vault, leg.mint, b.tokenProgram);
    const r = await rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send().catch(() => ({ value: null }));
    const amt = r.value ? Number(r.value.amount) / 10 ** r.value.decimals : 0;
    const lp = amt > 0 ? BigInt(Math.floor((amt * (await price(b.pythFeed)) / solP) * 1e9)) : 0n;
    legTotal += lp;
    rows.push([b.symbol, leg.weightBps, amt, lp]);
  }
  const nav = sleeve + legTotal;
  const sup = await rpc.getTokenSupply(shareMintOf(cfg.ticker), { commitment: "confirmed" }).send();
  const supply = Number(sup.value.uiAmountString);
  console.log(`\n${cfg.ticker}   NAV ${(Number(nav) / 1e9).toFixed(6)} SOL   supply ${supply}`);
  if (supply > 0) console.log(`  NAV/share   ${(Number(nav) / 1e9 / supply).toFixed(6)}`);
  console.log(`  SOL sleeve  ${(Number(sleeve) / 1e9).toFixed(6)}  ${(Number(sleeve) * 100 / Number(nav || 1n)).toFixed(1)}%`);
  for (const [s, w, amt, lp] of rows) {
    const actual = Number(lp) * 100 / Number(nav || 1n);
    const drift = actual - w / 100;
    console.log(
      `  ${s.padEnd(6)} ${(w / 100).toFixed(0).padStart(3)}% target  ${actual.toFixed(1).padStart(5)}% actual  ` +
        `${drift >= 0 ? "+" : ""}${drift.toFixed(1)}pp   ${amt.toFixed(6)} units`,
    );
  }
}
