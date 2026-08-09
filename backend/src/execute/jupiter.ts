/**
 * Jupiter client: quotes for sizing, instructions for execution.
 *
 * Legs are valued with real quotes rather than a USD price feed, because the
 * question a rebalance actually asks is "what is this position worth if I sell
 * it right now", and only the venue can answer that. It also means sizing and
 * execution share one price source, so a plan cannot be built against a number
 * the swap will not honour.
 *
 * The Pyth feed is still needed — but for NAV inside the program, where a
 * depositor's share price must be derived on chain rather than asserted by
 * this worker. Different question, different source.
 */

import { env } from "../env.ts";
import { errText, log } from "../log.ts";
import { getJson, postJson } from "../sources/http.ts";

/** Wrapped SOL. Jupiter routes in tokens, so the SOL sleeve is wSOL here. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export type QuoteResponse = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
  slippageBps: number;
  [key: string]: unknown;
};

/**
 * An exact-in quote.
 *
 * Returns null instead of throwing when no route exists: an unroutable leg is
 * a planning fact the diff engine records as a blocker, not an exception that
 * should abort the other six trackers in the cycle.
 */
export async function getQuote(input: {
  inputMint: string;
  outputMint: string;
  /** Base units of the input mint. */
  amount: bigint;
  slippageBps?: number;
}): Promise<QuoteResponse | null> {
  if (input.amount <= 0n) return null;

  const params = new URLSearchParams({
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amount: input.amount.toString(),
    slippageBps: String(input.slippageBps ?? env.swapSlippageBps),
    // Direct routes only would miss most equity pairs; multi-hop is required
    // because xStocks liquidity is overwhelmingly against USDC, not SOL.
    onlyDirectRoutes: "false",
    restrictIntermediateTokens: "true",
  });

  try {
    return await getJson<QuoteResponse>(
      `${env.jupiterApiUrl}/quote?${params.toString()}`,
      { timeoutMs: 12_000, retries: 2 },
    );
  } catch (error) {
    log.debug("no jupiter route", {
      from: input.inputMint.slice(0, 8),
      to: input.outputMint.slice(0, 8),
      error: errText(error),
    });
    return null;
  }
}

/** What a holding is worth in lamports right now, per the venue. */
export async function valueInLamports(
  mint: string,
  amount: bigint,
): Promise<bigint | null> {
  if (amount <= 0n) return 0n;
  if (mint === WSOL_MINT) return amount;
  const quote = await getQuote({ inputMint: mint, outputMint: WSOL_MINT, amount });
  return quote ? BigInt(quote.outAmount) : null;
}

export type JupiterInstruction = {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
};

export type SwapInstructionsResponse = {
  tokenLedgerInstruction?: JupiterInstruction | null;
  computeBudgetInstructions: JupiterInstruction[];
  setupInstructions: JupiterInstruction[];
  swapInstruction: JupiterInstruction;
  cleanupInstruction?: JupiterInstruction | null;
  addressLookupTableAddresses: string[];
};

/**
 * The CPI-ready form of a route.
 *
 * `/swap-instructions` returns the route already decomposed, which is what a
 * program CPI needs: the vault PDA cannot sign a pre-built transaction, so the
 * worker takes `swapInstruction`'s accounts and data and forwards them into
 * our own `swap_leg`, which re-signs the same route with the vault's seeds.
 *
 * `useSharedAccounts` is required. Jupiter's non-shared route assumes the
 * user's own token accounts and a signer that is not a PDA; the shared-accounts
 * variant is the one designed for program-owned callers.
 */
export async function getSwapInstructions(input: {
  quote: QuoteResponse;
  /** The vault PDA. It never signs the outer transaction, only the CPI. */
  userPublicKey: string;
  /** Where the output lands. Defaults to the vault's own ATA. */
  destinationTokenAccount?: string;
}): Promise<SwapInstructionsResponse | null> {
  try {
    return await postJson<SwapInstructionsResponse>(
      `${env.jupiterApiUrl}/swap-instructions`,
      {
        quoteResponse: input.quote,
        userPublicKey: input.userPublicKey,
        useSharedAccounts: true,
        // The vault holds native SOL, and the program wraps and unwraps around
        // the CPI itself, so Jupiter must not try to manage wSOL for us.
        wrapAndUnwrapSol: false,
        destinationTokenAccount: input.destinationTokenAccount,
        dynamicComputeUnitLimit: true,
        skipUserAccountsRpcCalls: true,
      },
      { timeoutMs: 20_000 },
    );
  } catch (error) {
    log.warn("swap-instructions failed", { error: errText(error) });
    return null;
  }
}

/** Price impact as bps, for the blocker check and for the audit trail. */
export const priceImpactBps = (quote: QuoteResponse): number =>
  Math.round(Math.abs(Number.parseFloat(quote.priceImpactPct) || 0) * 10_000);
