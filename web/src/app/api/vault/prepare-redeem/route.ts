/**
 * Sell a holder's share of the basket so their redemption can settle in SOL.
 *
 * The holder signs exactly one transaction. That is only possible if the vault
 * already holds the SOL, so the selling happens here first, in the vault's own
 * name, before the signature is ever requested.
 *
 * # This endpoint spends the vault's money, so it checks who is asking
 *
 * Every call makes the vault trade, and every trade costs a spread. Left open,
 * anyone could bleed the fund by requesting redemptions they never sign.
 *
 * So the caller must actually hold the shares they claim to be redeeming: the
 * balance is read on chain, not taken from the request. That is not a
 * signature — it does not prove the requester *is* that wallet — but it bounds
 * the damage to what a genuine holder could already do by redeeming for real,
 * which is the same trade at the same cost.
 */

import { NextResponse } from "next/server";
import type { Address } from "@solana/kit";

import { TRACKERS } from "@/lib/config";
import { findAssociatedTokenPda } from "@/lib/vault/program";
import {
  managerSigner,
  raiseForRedemption,
  readVault,
  serverRpc,
} from "@/lib/server/vault-admin";

export const dynamic = "force-dynamic";

/**
 * One preparation per wallet at a time, and a cooldown between them.
 *
 * A holder's principal cannot reach another holder — selling stock for SOL
 * changes what the vault holds, not what it is worth. What *is* shared is the
 * spread on every sale, so someone requesting redemptions they never sign
 * would slowly bleed the fund on everyone else's behalf. The balance check
 * below bounds who can do it; this bounds how often.
 *
 * In memory, so it resets when the instance does. That is weak against a
 * determined attacker and adequate against the accidental case this mostly
 * guards: a user clicking twice, or a page retrying.
 */
const COOLDOWN_MS = 30_000;
const lastPrepared = new Map<string, number>();
const inFlight = new Set<string>();

/** Selling can take a few Jupiter round trips and several confirmations. */
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: { ticker?: unknown; owner?: unknown; shares?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const ticker = String(body.ticker ?? "");
  const owner = String(body.owner ?? "") as Address;
  if (!TRACKERS.some((t) => t.ticker === ticker)) {
    return NextResponse.json({ error: "unknown tracker" }, { status: 400 });
  }

  let shares: bigint;
  try {
    shares = BigInt(String(body.shares ?? "0"));
  } catch {
    return NextResponse.json({ error: "invalid shares" }, { status: 400 });
  }
  if (shares <= 0n) {
    return NextResponse.json({ error: "shares must be positive" }, { status: 400 });
  }

  const rpc = serverRpc();
  const vault = await readVault(rpc, ticker);
  if (!vault) {
    return NextResponse.json({ error: "tracker not initialized" }, { status: 404 });
  }

  // The balance decides, not the request body.
  const holderAta = await findAssociatedTokenPda(owner, vault.shareMint);
  const balance = await rpc
    .getTokenAccountBalance(holderAta, { commitment: "confirmed" })
    .send()
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n);

  if (balance < shares) {
    return NextResponse.json(
      { error: "you do not hold that many shares", holds: balance.toString() },
      { status: 403 },
    );
  }

  const now = Date.now();
  const since = now - (lastPrepared.get(owner) ?? 0);
  if (inFlight.has(owner)) {
    return NextResponse.json(
      { error: "a redemption is already being prepared for this wallet" },
      { status: 429 },
    );
  }
  if (since < COOLDOWN_MS) {
    return NextResponse.json(
      { error: `try again in ${Math.ceil((COOLDOWN_MS - since) / 1000)}s` },
      { status: 429 },
    );
  }

  const signer = await managerSigner();
  if (vault.manager !== signer.address) {
    return NextResponse.json(
      { error: "server key is not the manager for this tracker" },
      { status: 500 },
    );
  }

  inFlight.add(owner);
  let result;
  try {
    result = await raiseForRedemption(rpc, signer, vault, shares);
  } finally {
    inFlight.delete(owner);
    lastPrepared.set(owner, Date.now());
  }

  return NextResponse.json({
    ready: result.shortfall === 0n,
    sleeve: result.raised.toString(),
    sold: result.sold,
    // A leg that would not route leaves the sleeve short. The holder can still
    // take the basket in kind, which needs no route and no oracle.
    shortfall: result.shortfall.toString(),
    // Named so the client can tell the holder which positions arrive as stock.
    unsold: result.unsold,
  });
}
