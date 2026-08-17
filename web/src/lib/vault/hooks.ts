"use client";

import { useCallback } from "react";
import { getBase64Encoder, type Address } from "@solana/kit";
import { useClient } from "@solana/react";
import useSWR from "swr";

import type { AppClient } from "@/app/providers";
import { shareMintOf } from "@/lib/config";
import {
  decodeMintSupply,
  decodeTokenAmount,
  decodeTracker,
  findAssociatedTokenPda,
  findTrackerPda,
  findVaultPda,
  type TrackerAccount,
} from "./program";

export type VaultSnapshot = {
  /** The vault these numbers came from. Callers that swap tickers render this
   *  rather than the one they asked for: SWR keeps the previous vault's data
   *  on screen while the next one loads, and the two must not be mixed. */
  ticker: string;
  trackerAddress: Address;
  vaultAddress: Address;
  shareMintAddress: Address;
  /** Null when the tracker has not been initialized on this cluster. */
  tracker: TrackerAccount | null;
  supply: bigint;
  vaultLamports: bigint;
  netAssets: bigint;
};

const base64 = getBase64Encoder();

const decodeBase64 = (value: string) =>
  new Uint8Array(base64.encode(value) as Uint8Array);

/**
 * One `getMultipleAccounts` for the tracker, its share mint, and its SOL
 * vault. A single round trip keeps the three numbers on the card consistent
 * with each other: they are read at the same slot, so NAV can never be
 * rendered from a supply and a balance that disagree.
 */
export function useVault(ticker: string, refreshMs = 10_000) {
  const client = useClient<AppClient>();

  const fetcher = useCallback(async (): Promise<VaultSnapshot> => {
    const trackerAddress = await findTrackerPda(ticker);
    const vaultAddress = await findVaultPda(trackerAddress);
    // The share mint is a vanity keypair, not a PDA, so it cannot be derived —
    // it comes from config. That is the cost of a chosen address, and it has to
    // be known *before* the fetch below rather than read out of the tracker
    // account, or the single-round-trip guarantee above is lost.
    const shareMintAddress = shareMintOf(ticker) as Address;

    const { value } = await client.rpc
      .getMultipleAccounts([trackerAddress, shareMintAddress, vaultAddress], {
        commitment: "confirmed",
        encoding: "base64",
      })
      .send();

    const [trackerInfo, mintInfo, vaultInfo] = value;

    const tracker = trackerInfo
      ? decodeTracker(decodeBase64(trackerInfo.data[0]))
      : null;
    const supply = mintInfo ? decodeMintSupply(decodeBase64(mintInfo.data[0])) : 0n;
    const vaultLamports = vaultInfo ? BigInt(vaultInfo.lamports) : 0n;
    const rentReserve = tracker?.rentReserve ?? 0n;
    const netAssets =
      vaultLamports > rentReserve ? vaultLamports - rentReserve : 0n;

    return {
      ticker,
      trackerAddress,
      vaultAddress,
      shareMintAddress,
      tracker,
      supply,
      vaultLamports,
      netAssets,
    };
  }, [client, ticker]);

  const { data, error, isLoading, mutate } = useSWR(
    ["vault", ticker],
    fetcher,
    {
      refreshInterval: refreshMs,
      revalidateOnFocus: true,
      keepPreviousData: true,
      onError: (err) => console.error(`[vault ${ticker}]`, err),
    },
  );

  return { snapshot: data, error, isLoading, refresh: mutate };
}

/** The connected wallet's share balance for one tracker. */
export function useShareBalance(
  owner: Address | undefined,
  shareMint: Address | undefined,
) {
  const client = useClient<AppClient>();

  const fetcher = useCallback(async () => {
    if (!owner || !shareMint) return 0n;
    const ata = await findAssociatedTokenPda(owner, shareMint);
    const { value } = await client.rpc
      .getAccountInfo(ata, { commitment: "confirmed", encoding: "base64" })
      .send();
    // No token account yet simply means a zero position, not an error.
    if (!value) return 0n;
    return decodeTokenAmount(decodeBase64(value.data[0]));
  }, [client, owner, shareMint]);

  const { data, mutate, isLoading } = useSWR(
    owner && shareMint ? ["shares", owner, shareMint] : null,
    fetcher,
    { refreshInterval: 10_000, keepPreviousData: true },
  );

  return { shares: data ?? 0n, isLoading, refresh: mutate };
}

/** The connected wallet's SOL balance, for the "you cannot afford this" states. */
export function useSolBalance(owner: Address | undefined) {
  const client = useClient<AppClient>();

  const fetcher = useCallback(async () => {
    if (!owner) return 0n;
    const { value } = await client.rpc
      .getBalance(owner, { commitment: "confirmed" })
      .send();
    return BigInt(value);
  }, [client, owner]);

  const { data, mutate } = useSWR(owner ? ["balance", owner] : null, fetcher, {
    refreshInterval: 10_000,
    keepPreviousData: true,
  });

  return { lamports: data ?? 0n, refresh: mutate };
}
