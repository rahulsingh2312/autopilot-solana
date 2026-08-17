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
  getAddressDecoder,
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
  /** Needed to read lookup tables Jupiter names but does not inline. */
  fetchLookupTables?: (addresses: Address[]) => Promise<Record<string, Address[]>>;
}): Promise<SwapPlan | null> {
  const { owner, leg, amount } = params;
  if (amount <= 0n) return null;

  /**
   * Direct first, and it is a size decision rather than a price one.
   *
   * A one-hop route touches one pool; two hops touch two, and the second
   * pool's accounts are what push a transaction past 1232 bytes. Measured on
   * habitSOL's legs, the multi-hop routes came back at 1296 bytes for a single
   * swap — over the limit on its own.
   */
  const attempts = [
    `&onlyDirectRoutes=true`,
    `&maxAccounts=${MAX_ACCOUNTS}`,
    ``,
  ];

  let quote: { outAmount?: string; otherAmountThreshold?: string; routePlan?: { swapInfo: { label: string } }[] } | null = null;
  for (const extra of attempts) {
    const q = await fetch(
      `${JUP_API}/quote?inputMint=${leg.mint}&outputMint=${WSOL_MINT}` +
        `&amount=${amount}&slippageBps=${SLIPPAGE_BPS}${extra}`,
    ).then((r) => r.json());
    if (q?.outAmount) { quote = q; break; }
  }
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

  /**
   * Resolve the route's lookup tables.
   *
   * Jupiter returns `addressesByLookupTableAddress` only sometimes; when it
   * does not, `addressLookupTableAddresses` still names them and the contents
   * have to be read from chain. Skipping that step is not a missed
   * optimisation — an uncompressed route is over the transaction limit on its
   * own, so the swap simply cannot be sent.
   */
  const lookupTables: Record<string, Address[]> = {};
  for (const [table, addresses] of Object.entries(
    (built.addressesByLookupTableAddress ?? {}) as Record<string, string[]>,
  )) {
    lookupTables[table] = addresses as Address[];
  }
  const named: Address[] = (built.addressLookupTableAddresses ?? []) as Address[];
  const missing = named.filter((t) => !lookupTables[t]);
  if (missing.length > 0 && params.fetchLookupTables) {
    Object.assign(lookupTables, await params.fetchLookupTables(missing));
  }

  return {
    symbol: leg.symbol,
    mint: leg.mint,
    amount,
    expectedLamports: BigInt(quote.outAmount),
    minLamports: BigInt(quote.otherAmountThreshold ?? quote.outAmount),
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

/**
 * Bundle as many sales into each transaction as will fit.
 *
 * Two hard ceilings, and they bite in different orders depending on the routes:
 * 1232 bytes, and 64 unique account addresses. Measured on habitSOL's four
 * legs, three sales fit in 1131 bytes and the fourth trips the account limit —
 * so the exit is two transactions rather than four. Uncompressed it was one
 * swap per transaction and not even that, since a single multi-hop route came
 * to 1296 bytes on its own.
 *
 * Greedy rather than optimal: add until it stops fitting, then start a new
 * batch. An optimal packing would save at most one signature and would need to
 * re-quote to find out.
 */
export async function packSwapPlans(
  plans: SwapPlan[],
  buildMessage: (subset: SwapPlan[]) => Promise<number>,
): Promise<SwapPlan[][]> {
  const batches: SwapPlan[][] = [];
  let current: SwapPlan[] = [];

  for (const plan of plans) {
    const candidate = [...current, plan];
    let fits = false;
    try {
      fits = (await buildMessage(candidate)) <= 1232;
    } catch {
      // Throwing means a structural limit — the account ceiling — rather than
      // a size one. Same answer either way: it does not fit.
      fits = false;
    }
    if (fits) {
      current = candidate;
      continue;
    }
    if (current.length > 0) batches.push(current);
    current = [plan];
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Send one batch of sales as a single transaction. */
export async function sendSwapBatch(
  client: Parameters<typeof sendSwapPlan>[0],
  batch: SwapPlan[],
  abortSignal?: AbortSignal,
): Promise<string> {
  const merged: SwapPlan = {
    ...batch[0],
    instructions: batch.flatMap((p) => p.instructions),
    lookupTables: Object.assign({}, ...batch.map((p) => p.lookupTables)),
  };
  return sendSwapPlan(client, merged, abortSignal);
}

/**
 * Read lookup tables from chain.
 *
 * An ALT account is a 56-byte header followed by packed 32-byte addresses.
 * Needed because Jupiter names the tables a route uses but does not always
 * inline their contents, and without the contents the message cannot be
 * compressed — which for these routes means it cannot be sent at all.
 */
export async function fetchLookupTables(
  client: { rpc: { getMultipleAccounts: (a: Address[], c: object) => { send: () => Promise<{ value: ({ data: [string, string] } | null)[] }> } } },
  addresses: Address[],
): Promise<Record<string, Address[]>> {
  if (addresses.length === 0) return {};
  const { value } = await client.rpc
    .getMultipleAccounts(addresses, { encoding: "base64", commitment: "confirmed" })
    .send();

  const decoder = getAddressDecoder();
  const tables: Record<string, Address[]> = {};
  value.forEach((info, i) => {
    if (!info) return;
    const data = Uint8Array.from(atob(info.data[0]), (c) => c.charCodeAt(0));
    const list: Address[] = [];
    for (let o = 56; o + 32 <= data.length; o += 32) {
      list.push(decoder.decode(data.subarray(o, o + 32)));
    }
    tables[addresses[i]] = list;
  });
  return tables;
}

/**
 * Serialized size of a batch, used to decide whether it fits.
 *
 * Signs with the real signer because a signature is 64 bytes and leaving it
 * out would under-measure by exactly enough to matter at the boundary.
 */
export async function measureBatch(
  client: Parameters<typeof sendSwapPlan>[0],
  batch: SwapPlan[],
): Promise<number> {
  if (batch.length === 0) return 0;
  const { value: blockhash } = await client.rpc.getLatestBlockhash().send();
  const alts = Object.assign({}, ...batch.map((p) => p.lookupTables));

  let message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(client.payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash as never, m),
    (m) => appendTransactionMessageInstructions(batch.flatMap((p) => p.instructions), m),
  );
  if (Object.keys(alts).length > 0) {
    message = compressTransactionMessageUsingAddressLookupTables(message, alts) as typeof message;
  }
  const signed = await signTransactionMessageWithSigners(message);
  return Uint8Array.from(atob(getBase64EncodedWireTransaction(signed)), (c) => c.charCodeAt(0)).length;
}
