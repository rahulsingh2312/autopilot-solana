/**
 * Put a vault's idle SOL back into its basket.
 *
 * Called after a deposit confirms, and after a redemption that left the sleeve
 * fat. Those are the only two ways a vault ends up holding cash it was not
 * meant to hold:
 *
 * - a deposit arrives as SOL and buys nothing by itself
 * - a sale is raised for a redemption the holder then abandons
 *
 * Both leave the fund dragging against its own basket for as long as the cash
 * sits there. Neither is anyone's fault, and neither fixes itself.
 *
 * # Safe to call, by anyone, at any time
 *
 * This endpoint takes no user input beyond which tracker to settle, and it
 * cannot move value to a caller: every trade is the vault buying its own
 * published legs, signed by the vault, bounded by `min_amount_out`. The worst
 * a caller achieves by hammering it is nothing at all — below
 * `MIN_TRADE_LAMPORTS` of idle cash it returns without trading, which is the
 * state it leaves the vault in.
 *
 * That is deliberate. `prepare-redeem` spends the vault's money on request and
 * therefore has to check who is asking; this one cannot be made to spend
 * anything that was not already going to be spent.
 */

import { NextResponse } from "next/server";

import { TRACKERS } from "@/lib/config";
import {
  investIdleSol,
  managerSigner,
  readVault,
  serverRpc,
} from "@/lib/server/vault-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: { ticker?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const ticker = String(body.ticker ?? "");
  if (!TRACKERS.some((t) => t.ticker === ticker)) {
    return NextResponse.json({ error: "unknown tracker" }, { status: 400 });
  }

  const rpc = serverRpc();
  const vault = await readVault(rpc, ticker);
  if (!vault) {
    return NextResponse.json({ error: "tracker not initialized" }, { status: 404 });
  }

  const signer = await managerSigner();
  if (vault.manager !== signer.address) {
    return NextResponse.json({ error: "server key is not the manager" }, { status: 500 });
  }

  const result = await investIdleSol(rpc, signer, vault);

  return NextResponse.json({
    invested: result.invested.toString(),
    bought: result.bought,
    sleeveBefore: vault.sleeve.toString(),
  });
}
