/**
 * Sending things to the chain.
 *
 * Two operations, in the order they must happen:
 *
 *   publishWeights — writes the target basket into the `Tracker` account.
 *   executeSwaps   — moves the vault's assets to match what was published.
 *
 * Never the other way round. Swapping first would leave the vault holding
 * something its published weights do not describe, which is precisely the
 * disagreement between disclosure and holdings that this product exists to
 * avoid.
 */

import { AccountRole, type Address, type Instruction } from "@solana/kit";

import { env } from "../env.ts";
import { errText, log } from "../log.ts";
import { recordExecution } from "../store/db.ts";
import type { PlannedTrade, RebalancePlan } from "../types.ts";
import {
  encodeRebalanceData,
  encodeSetPausedData,
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
  VAULT_PROGRAM_ADDRESS,
  type EncodableLeg,
} from "../chain/program.ts";
import type { TrackerState } from "../chain/state.ts";
import { requireSigner, sendInstructions, type SendResult } from "../chain/rpc.ts";
import { getQuote, getSwapInstructions, WSOL_MINT } from "./jupiter.ts";

/** `sha256("global:swap_leg")[0..8]`. Ships with the program change below. */
const SWAP_LEG_DISCRIMINATOR = new Uint8Array([161, 179, 118, 153, 105, 134, 227, 67]);

export async function publishWeights(input: {
  planId: number;
  plan: RebalancePlan;
  state: TrackerState;
  legs: EncodableLeg[];
  dryRun?: boolean;
}): Promise<SendResult> {
  const signer = await requireSigner();

  if (signer.address !== input.state.account.authority) {
    throw new Error(
      `signer ${signer.address} is not the tracker authority ${input.state.account.authority}`,
    );
  }

  const instruction: Instruction = {
    programAddress: VAULT_PROGRAM_ADDRESS,
    accounts: [
      { address: signer.address, role: AccountRole.READONLY_SIGNER },
      { address: input.state.trackerPda, role: AccountRole.WRITABLE },
    ],
    data: encodeRebalanceData(input.legs),
  };

  try {
    const result = await sendInstructions([instruction], { dryRun: input.dryRun });
    recordExecution({
      planId: input.planId,
      tracker: input.plan.trackerTicker,
      kind: "rebalance",
      signature: result.signature ?? undefined,
      detail: {
        dryRun: Boolean(input.dryRun),
        driftBps: input.plan.driftBps,
        legs: input.legs.map((leg) => `${leg.symbol}:${leg.weightBps}`),
      },
    });
    return result;
  } catch (error) {
    recordExecution({
      planId: input.planId,
      tracker: input.plan.trackerTicker,
      kind: "rebalance",
      error: errText(error),
    });
    throw error;
  }
}

/**
 * Builds one `swap_leg` instruction wrapping a Jupiter route.
 *
 * The shape is: our program owns the accounts it must validate (tracker,
 * vault, both token accounts), and every account Jupiter's route needs rides
 * in `remaining_accounts` untouched. The program forwards them verbatim to a
 * CPI signed by the vault PDA, so the funds never leave vault custody at any
 * point in the transaction.
 *
 * `minOut` is the caller's floor, enforced by our program after the CPI
 * returns rather than trusted from Jupiter's own accounting.
 */
async function buildSwapLegInstruction(input: {
  trade: PlannedTrade;
  state: TrackerState;
}): Promise<{ instruction: Instruction; lookupTables: string[] } | null> {
  const buying = input.trade.side === "buy";
  const inputMint = buying ? WSOL_MINT : input.trade.mint;
  const outputMint = buying ? input.trade.mint : WSOL_MINT;

  const quote = await getQuote({
    inputMint,
    outputMint,
    amount: BigInt(input.trade.amount),
  });
  if (!quote) {
    log.warn("route vanished between planning and execution", {
      tracker: input.state.ticker,
      ticker: input.trade.ticker,
    });
    return null;
  }

  const swap = await getSwapInstructions({
    quote,
    userPublicKey: input.state.vaultPda,
    destinationTokenAccount: await findAssociatedTokenPda(
      input.state.vaultPda,
      outputMint as Address,
    ),
  });
  if (!swap) return null;

  const sourceAta = await findAssociatedTokenPda(input.state.vaultPda, inputMint as Address);
  const destinationAta = await findAssociatedTokenPda(
    input.state.vaultPda,
    outputMint as Address,
  );

  // amount_in (u64) ‖ min_out (u64) ‖ route_data_len (u32) ‖ route_data
  const routeData = Uint8Array.from(Buffer.from(swap.swapInstruction.data, "base64"));
  const data = new Uint8Array(8 + 8 + 8 + 4 + routeData.length);
  const view = new DataView(data.buffer);
  data.set(SWAP_LEG_DISCRIMINATOR, 0);
  view.setBigUint64(8, BigInt(input.trade.amount), true);
  view.setBigUint64(16, BigInt(quote.otherAmountThreshold), true);
  view.setUint32(24, routeData.length, true);
  data.set(routeData, 28);

  const accounts = [
    { address: (await requireSigner()).address, role: AccountRole.READONLY_SIGNER },
    { address: input.state.trackerPda, role: AccountRole.WRITABLE },
    { address: input.state.vaultPda, role: AccountRole.WRITABLE },
    { address: sourceAta, role: AccountRole.WRITABLE },
    { address: destinationAta, role: AccountRole.WRITABLE },
    { address: inputMint as Address, role: AccountRole.READONLY },
    { address: outputMint as Address, role: AccountRole.READONLY },
    { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    {
      address: swap.swapInstruction.programId as Address,
      role: AccountRole.READONLY,
    },
    // Everything Jupiter's route needs, forwarded untouched. The vault PDA is
    // demoted to non-signer here: the program supplies its signature via
    // `invoke_signed`, and a PDA can never sign the outer transaction.
    ...swap.swapInstruction.accounts.map((account) => ({
      address: account.pubkey as Address,
      role:
        account.pubkey === input.state.vaultPda
          ? account.isWritable
            ? AccountRole.WRITABLE
            : AccountRole.READONLY
          : account.isSigner
            ? account.isWritable
              ? AccountRole.WRITABLE_SIGNER
              : AccountRole.READONLY_SIGNER
            : account.isWritable
              ? AccountRole.WRITABLE
              : AccountRole.READONLY,
    })),
  ];

  return {
    instruction: { programAddress: VAULT_PROGRAM_ADDRESS, accounts, data },
    lookupTables: swap.addressLookupTableAddresses,
  };
}

export type SwapOutcome = {
  trade: PlannedTrade;
  signature: string | null;
  error?: string;
};

/**
 * Executes a plan's trades, one transaction each.
 *
 * One swap per transaction on purpose. A Jupiter route plus our wrapper is
 * already close to the account and compute ceiling, and batching would mean a
 * single unroutable leg reverting five good trades. Sequential also lets a
 * sell land and fund the buy that follows it.
 */
export async function executeSwaps(input: {
  planId: number;
  plan: RebalancePlan;
  state: TrackerState;
  dryRun?: boolean;
}): Promise<SwapOutcome[]> {
  const outcomes: SwapOutcome[] = [];

  for (const trade of input.plan.trades) {
    try {
      const built = await buildSwapLegInstruction({ trade, state: input.state });
      if (!built) {
        outcomes.push({ trade, signature: null, error: "no route at execution time" });
        continue;
      }

      const result = await sendInstructions([built.instruction], {
        dryRun: input.dryRun,
      });

      recordExecution({
        planId: input.planId,
        tracker: input.plan.trackerTicker,
        kind: "swap",
        signature: result.signature ?? undefined,
        detail: {
          side: trade.side,
          ticker: trade.ticker,
          amount: trade.amount,
          dryRun: Boolean(input.dryRun),
          unitsConsumed: result.unitsConsumed,
        },
      });
      outcomes.push({ trade, signature: result.signature });
    } catch (error) {
      const message = errText(error);
      log.error("swap failed", {
        tracker: input.plan.trackerTicker,
        ticker: trade.ticker,
        side: trade.side,
        error: message,
      });
      recordExecution({
        planId: input.planId,
        tracker: input.plan.trackerTicker,
        kind: "swap",
        error: message,
        detail: { side: trade.side, ticker: trade.ticker, amount: trade.amount },
      });
      outcomes.push({ trade, signature: null, error: message });
      // Stop on the first failure. Continuing would leave the basket in a
      // half-rebalanced state nobody planned for, and the next cycle re-plans
      // from wherever the vault actually ended up.
      break;
    }
  }

  return outcomes;
}

/** Pause or unpause deposits. Redemption is never gated by this. */
export async function setPaused(
  state: TrackerState,
  paused: boolean,
): Promise<SendResult> {
  const signer = await requireSigner();
  return await sendInstructions([
    {
      programAddress: VAULT_PROGRAM_ADDRESS,
      accounts: [
        { address: signer.address, role: AccountRole.READONLY_SIGNER },
        { address: state.trackerPda, role: AccountRole.WRITABLE },
      ],
      data: encodeSetPausedData(paused),
    },
  ]);
}

export const swapsSupported = (): boolean => env.cluster === "mainnet-beta";
