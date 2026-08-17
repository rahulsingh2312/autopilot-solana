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
 *
 * # It is still rate-limited, and the reason is not this endpoint
 *
 * Investing and selling are individually harmless and jointly a loop. A holder
 * can raise cash through `prepare-redeem` and never claim it; anyone can then
 * call this to put it back; and the first step can be repeated. Each lap pays
 * a spread in both directions, and the cost falls on every holder in the vault
 * rather than on whoever set it going.
 *
 * A cooldown per tracker breaks the loop cheaply. It costs nothing real —
 * idle cash sitting for a few minutes changes nobody's share of anything —
 * while capping the churn a determined caller can force to a rounding error.
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

/** Per tracker, not per caller: the loop is about the vault, not the wallet. */
const COOLDOWN_MS = 5 * 60_000;
const lastSettled = new Map<string, number>();

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

  const since = Date.now() - (lastSettled.get(ticker) ?? 0);
  if (since < COOLDOWN_MS) {
    return NextResponse.json(
      { invested: "0", bought: [], skipped: "cooling down" },
      { status: 200 },
    );
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

  lastSettled.set(ticker, Date.now());
  const result = await investIdleSol(rpc, signer, vault);

  return NextResponse.json({
    invested: result.invested.toString(),
    bought: result.bought,
    sleeveBefore: vault.sleeve.toString(),
  });
}
