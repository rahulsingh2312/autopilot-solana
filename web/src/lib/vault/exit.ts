/**
 * Exiting a position for SOL when the vault's sleeve cannot pay for it.
 *
 * # The problem this solves
 *
 * `redeem_for_sol` pays out of the SOL sleeve and checks the holder's *gross*
 * claim against it, so on a vault that has bought its basket it computes a
 * correct payout and then reverts. habitSOL holds 3% SOL and 97% stock: the
 * only redemption that path can settle is a rounding error.
 *
 * The vault cannot sell on the holder's behalf either. `swap_leg` is a manager
 * instruction, deliberately — repositioning the basket must never come with the
 * ability to take anything out — and it needs a Jupiter route computed off
 * chain, which a program cannot do inside a redemption.
 *
 * So the sale happens in the holder's own transactions instead: take the
 * basket in kind, then sell each leg to SOL through Jupiter. The holder ends up
 * with SOL, which is what they asked for, and pays the swap costs they would
 * have paid anyway. No keeper, no protocol change, and nothing about it depends
 * on us being online.
 *
 * # Why it is a sequence and not one transaction
 *
 * The amounts are only known after the redemption lands. `redeem_in_kind` pays
 * `vault_balance × shares ÷ supply`, and the vault's balance can move between
 * quoting and signing, so quoting up front risks selling an amount the holder
 * does not have. Reading the balance after the burn removes the guess.
 *
 * Four legs is therefore five signatures. That is worse than one, and it is the
 * honest cost of a vault that holds its assets rather than a float.
 */

import {
  AccountRole,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
} from "@solana/kit";

const JUP_API = "https://lite-api.jup.ag/swap/v1";
const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const WSOL_MINT = "So11111111111111111111111111111111111111112" as Address;

/**
 * Slippage on the way out.
 *
 * Wider than a deposit's because these are thin pairs and a redemption that
 * fails leaves the holder holding stock they explicitly asked not to hold.
 * Jupiter still enforces a floor derived from this, so it bounds the loss
 * rather than waiving it.
 */
const SLIPPAGE_BPS = 300;

/**
 * Route accounts to ask for.
 *
 * Unlike `swap_leg`, nothing here forwards a route through our program, so the
 * 46-account stack bound does not apply — the only ceiling is the 1232-byte
 * transaction, and Jupiter's own transaction builder is what has to fit inside
 * it.
 */
const MAX_ACCOUNTS = 30;

export type ExitLeg = {
  mint: Address;
  symbol: string;
  decimals: number;
};

export type SwapPlan = {
  symbol: string;
  mint: Address;
  /** Base units being sold. */
  amount: bigint;
  /** Lamports Jupiter expects to return. */
  expectedLamports: bigint;
  /** The floor it will enforce. */
  minLamports: bigint;
  instructions: Instruction[];
  lookupTables: Record<string, Address[]>;
  routeLabel: string;
};

const roleOf = (a: { isSigner: boolean; isWritable: boolean }) =>
  a.isSigner
    ? a.isWritable
      ? AccountRole.WRITABLE_SIGNER
      : AccountRole.READONLY_SIGNER
    : a.isWritable
      ? AccountRole.WRITABLE
      : AccountRole.READONLY;

const toInstruction = (ix: {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}): Instruction => ({
  programAddress: ix.programId as Address,
  accounts: ix.accounts.map((a) => ({
    address: a.pubkey as Address,
    role: roleOf(a),
  })),
  data: Uint8Array.from(atob(ix.data), (c) => c.charCodeAt(0)),
});

/**
 * Everything needed to sell one leg's balance for SOL, signed by the holder.
 *
 * Returns null when no route exists at this size, which is a real outcome on a
 * pair with a few thousand dollars of liquidity and has to be surfaced rather
 * than thrown — the other legs can still be sold, and the holder keeps the one
 * that could not be.
 */
export async function planSwapToSol(params: {
  owner: Address;
  leg: ExitLeg;
  amount: bigint;
}): Promise<SwapPlan | null> {
  const { owner, leg, amount } = params;
  if (amount <= 0n) return null;

  const quoteUrl =
    `${JUP_API}/quote?inputMint=${leg.mint}&outputMint=${WSOL_MINT}` +
    `&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&maxAccounts=${MAX_ACCOUNTS}`;

  const quote = await fetch(quoteUrl).then((r) => r.json());
  if (!quote?.outAmount) return null;

  const built = await fetch(`${JUP_API}/swap-instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: owner,
      // The holder wants SOL, not wSOL. Jupiter wraps, swaps and unwraps in
      // the same transaction and closes the temporary account, returning the
      // rent — doing it ourselves would leave them a wSOL account to find.
      wrapAndUnwrapSol: true,
      useSharedAccounts: true,
      // The holder's accounts genuinely exist by this point, and the legs are
      // Token-2022 — assuming the classic program derives an account that is
      // not theirs.
      skipUserAccountsRpcCalls: false,
    }),
  }).then((r) => r.json());

  if (!built?.swapInstruction) return null;
  if (built.swapInstruction.programId !== JUPITER_PROGRAM) return null;

  // `setup` creates any account the route needs; `cleanup` unwraps the wSOL
  // back to native SOL. Dropping either leaves the swap either impossible or
  // settled in the wrong token.
  const instructions: Instruction[] = [
    ...(built.setupInstructions ?? []).map(toInstruction),
    toInstruction(built.swapInstruction),
    ...(built.cleanupInstruction ? [toInstruction(built.cleanupInstruction)] : []),
  ];

  const lookupTables: Record<string, Address[]> = {};
  for (const [table, addresses] of Object.entries(
    (built.addressesByLookupTableAddress ?? {}) as Record<string, string[]>,
  )) {
    lookupTables[table] = addresses as Address[];
  }

  return {
    symbol: leg.symbol,
    mint: leg.mint,
    amount,
    expectedLamports: BigInt(quote.outAmount),
    minLamports: BigInt(quote.otherAmountThreshold),
    instructions,
    lookupTables,
    routeLabel: (quote.routePlan ?? [])
      .map((r: { swapInfo: { label: string } }) => r.swapInfo.label)
      .join(" → "),
  };
}

/**
 * What the holder would net by taking the basket and selling it, before they
 * commit to doing so.
 *
 * Quoted against the amounts the redemption *will* deliver, which is the same
 * arithmetic the program uses. It is an estimate: the vault's balances can move
 * before the burn lands, and the real sale is quoted again from the balances
 * that actually arrive.
 */
export async function quoteExitToSol(params: {
  owner: Address;
  legs: { leg: ExitLeg; amount: bigint }[];
  sleeveShare: bigint;
}): Promise<{
  lamports: bigint;
  minLamports: bigint;
  unsellable: string[];
}> {
  const plans = await Promise.all(
    params.legs.map(({ leg, amount }) => planSwapToSol({ owner: params.owner, leg, amount })),
  );

  let lamports = params.sleeveShare;
  let minLamports = params.sleeveShare;
  const unsellable: string[] = [];

  plans.forEach((plan, i) => {
    if (!plan) {
      unsellable.push(params.legs[i].leg.symbol);
      return;
    }
    lamports += plan.expectedLamports;
    minLamports += plan.minLamports;
  });

  return { lamports, minLamports, unsellable };
}

/**
 * Send one leg's sale, compressed against the route's lookup tables.
 *
 * Built by hand rather than through `client.sendTransaction` because the
 * transaction planner has no lookup-table support, and a Jupiter route
 * references around thirty accounts. Inlined that is over 900 bytes of pubkeys
 * against a 1232-byte limit, and the transaction is rejected for size before it
 * is rejected for anything interesting. Compressed, the same route costs a byte
 * per account.
 */
export async function sendSwapPlan(
  client: {
    rpc: {
      getLatestBlockhash: () => { send: () => Promise<{ value: { blockhash: string; lastValidBlockHeight: bigint } }> };
      sendTransaction: (tx: string, config: object) => { send: () => Promise<string> };
      getSignatureStatuses: (sigs: string[]) => { send: () => Promise<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }> };
    };
    payer: Parameters<typeof setTransactionMessageFeePayerSigner>[0];
  },
  plan: SwapPlan,
  abortSignal?: AbortSignal,
): Promise<string> {
  const { value: blockhash } = await client.rpc.getLatestBlockhash().send();

  let message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(client.payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash as never, m),
    (m) => appendTransactionMessageInstructions(plan.instructions, m),
  );
  if (Object.keys(plan.lookupTables).length > 0) {
    message = compressTransactionMessageUsingAddressLookupTables(
      message,
      plan.lookupTables as never,
    ) as typeof message;
  }

  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  await client.rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: "base64",
      preflightCommitment: "confirmed",
    })
    .send();

  // Polled rather than subscribed: the app has no websocket endpoint on
  // mainnet, deliberately, so that a keyed RPC never reaches the browser over a
  // channel a proxy cannot cover.
  for (let i = 0; i < 60; i++) {
    if (abortSignal?.aborted) throw new Error("cancelled");
    const { value } = await client.rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error(`swap failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return signature;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out confirming the sale");
}
