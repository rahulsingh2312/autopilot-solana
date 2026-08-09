/**
 * What a tracker is right now, read from the chain in one shot.
 *
 * Everything here comes from a single `getMultipleAccounts` so the vault
 * balance, share supply, and basket can never be stitched together from
 * different slots. NAV computed from a mismatched pair is the classic way a
 * vault UI shows a number that was never true.
 */

import type { Address } from "@solana/kit";

import { log } from "../log.ts";
import {
  decodeMintSupply,
  decodeTokenAmount,
  decodeTracker,
  findAssociatedTokenPda,
  findShareMintPda,
  findTrackerPda,
  findVaultPda,
  ZERO_ADDRESS,
  type TrackerAccount,
} from "./program.ts";
import { rpc } from "./rpc.ts";

export type LegHolding = {
  symbol: string;
  mint: Address;
  weightBps: number;
  /** Vault's ATA for this mint. Present whether or not it has been created. */
  ata: Address;
  /** Base units held. Zero also means "ATA does not exist yet". */
  amount: bigint;
  exists: boolean;
};

export type TrackerState = {
  ticker: string;
  trackerPda: Address;
  vaultPda: Address;
  shareMint: Address;
  account: TrackerAccount;
  /** Total lamports sitting in the vault PDA, rent reserve included. */
  vaultLamports: bigint;
  /** Lamports that belong to holders: vault balance less the rent reserve. */
  netLamports: bigint;
  shareSupply: bigint;
  /**
   * Lamports per share, scaled by 1e9. Only meaningful while the vault holds
   * SOL alone — once it holds tokenized equities this understates NAV until
   * the program's oracle valuation ships. Callers must check `tokenized`.
   */
  navPerShare: number;
  holdings: LegHolding[];
  /** True when any leg carries a real mint, i.e. the vault holds more than SOL. */
  tokenized: boolean;
  slot: bigint;
};

const decodeBase64 = (data: string): Uint8Array =>
  Uint8Array.from(Buffer.from(data, "base64"));

/**
 * Reads one tracker's complete state.
 *
 * Returns null when the tracker PDA holds no account, which is the normal
 * answer for a ticker that has not been deployed yet rather than an error.
 */
export async function readTrackerState(ticker: string): Promise<TrackerState | null> {
  const trackerPda = await findTrackerPda(ticker);
  const vaultPda = await findVaultPda(trackerPda);
  const shareMint = await findShareMintPda(trackerPda);

  const first = await rpc
    .getMultipleAccounts([trackerPda, vaultPda, shareMint], {
      encoding: "base64",
      commitment: "confirmed",
    })
    .send();

  const [trackerInfo, vaultInfo, mintInfo] = first.value;
  if (!trackerInfo) return null;

  const account = decodeTracker(decodeBase64(trackerInfo.data[0]));
  if (!account) {
    log.warn("tracker account failed to decode", { ticker, pda: trackerPda });
    return null;
  }

  const vaultLamports = BigInt(vaultInfo?.lamports ?? 0);
  const shareSupply = mintInfo ? decodeMintSupply(decodeBase64(mintInfo.data[0])) : 0n;
  const netLamports =
    vaultLamports > account.rentReserve ? vaultLamports - account.rentReserve : 0n;

  // Second round trip: the vault's token account per tokenized leg. Their
  // addresses derive from the basket, which we only learned above.
  const tokenizedLegs = account.legs.filter((leg) => leg.mint !== ZERO_ADDRESS);
  const atas = await Promise.all(
    tokenizedLegs.map((leg) => findAssociatedTokenPda(vaultPda, leg.mint)),
  );

  const holdings: LegHolding[] = [];
  if (atas.length > 0) {
    const tokenAccounts = await rpc
      .getMultipleAccounts(atas, { encoding: "base64", commitment: "confirmed" })
      .send();

    tokenizedLegs.forEach((leg, index) => {
      const info = tokenAccounts.value[index];
      const ata = atas[index]!;
      holdings.push({
        symbol: leg.symbol,
        mint: leg.mint,
        weightBps: leg.weightBps,
        ata,
        amount: info ? decodeTokenAmount(decodeBase64(info.data[0])) : 0n,
        exists: Boolean(info),
      });
    });
  }

  return {
    ticker: account.ticker,
    trackerPda,
    vaultPda,
    shareMint,
    account,
    vaultLamports,
    netLamports,
    shareSupply,
    navPerShare:
      shareSupply === 0n
        ? 1
        : Number((netLamports * 1_000_000_000n) / shareSupply) / 1_000_000_000,
    holdings,
    tokenized: tokenizedLegs.length > 0,
    slot: first.context.slot,
  };
}

/** Reads several trackers concurrently, dropping any that are not deployed. */
export async function readAllTrackerStates(
  tickers: string[],
): Promise<Map<string, TrackerState>> {
  const results = await Promise.all(
    tickers.map(async (ticker) => {
      try {
        return [ticker, await readTrackerState(ticker)] as const;
      } catch (error) {
        log.warn("tracker state read failed", { ticker, error: String(error) });
        return [ticker, null] as const;
      }
    }),
  );

  const map = new Map<string, TrackerState>();
  for (const [ticker, state] of results) {
    if (state) map.set(ticker, state);
  }
  return map;
}
