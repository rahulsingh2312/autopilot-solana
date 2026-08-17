"use client";

import { useCallback } from "react";
import { getBase64Encoder, type Address } from "@solana/kit";
import { useClient } from "@solana/react";
import useSWR from "swr";

import type { AppClient } from "@/app/providers";
import { shareMintOf } from "@/lib/config";
import { tokenProgramOfMint } from "@/lib/leg-bindings";
import {
  decodeMintSupply,
  decodeTokenAmount,
  decodeTracker,
  findAssociatedTokenPda,
  findTrackerPda,
  findVaultPda,
  type TrackerAccount,
} from "./program";
import { findAssociatedTokenPdaFor, findPythPriceAccount, SOL_USD_FEED_ID, isZeroMint } from "./oracle";
import {
  computeNav,
  legValueLamports,
  readMintDecimals,
  readPythPrice,
  scaledUiMultiplierMicros,
  type Holding,
} from "./nav";

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
  /**
   * Everything the fund owns, in lamports: the SOL sleeve plus every leg
   * valued at its Pyth price.
   *
   * This used to be the vault's lamport balance alone, which was right only
   * while the vaults held nothing but SOL. Once habitSOL bought its legs, the
   * sleeve was 3% of the fund and the site published a NAV of 0.0301 against a
   * true 0.9792.
   */
  netAssets: bigint;
  /** The uninvested part. Equal to `netAssets` for a vault that holds no legs. */
  sleeveLamports: bigint;
  /** Per-leg composition, in basket order. */
  holdings: Holding[];
  /**
   * False when a leg could not be priced, which makes `netAssets` a lower
   * bound rather than a valuation. The UI must not print a NAV as fact when
   * this is false.
   */
  navComplete: boolean;
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
    // it comes from config.
    const shareMintAddress = shareMintOf(ticker) as Address;

    const { value: trackerValue } = await client.rpc
      .getAccountInfo(trackerAddress, { commitment: "confirmed", encoding: "base64" })
      .send();

    const tracker = trackerValue
      ? decodeTracker(decodeBase64(trackerValue.data[0]))
      : null;

    const empty = {
      ticker,
      trackerAddress,
      vaultAddress,
      shareMintAddress,
      tracker,
      supply: 0n,
      vaultLamports: 0n,
      netAssets: 0n,
      sleeveLamports: 0n,
      holdings: [] as Holding[],
      navComplete: true,
    };
    if (!tracker) return empty;

    // A second round trip is unavoidable: the legs are only known once the
    // tracker is decoded. Everything NAV depends on goes in *this* batch —
    // the vault, the share mint, and all three accounts per leg — so the
    // number is computed from one slot and cannot mix a supply from one block
    // with a price from another.
    const legs = tracker.legs.filter((leg) => !isZeroMint(leg.mint));
    const solPriceAddress = await findPythPriceAccount(SOL_USD_FEED_ID);

    const legAddresses: Address[] = [];
    for (const leg of legs) {
      const tokenProgram = tokenProgramOfMint(leg.mint) as Address;
      legAddresses.push(
        await findAssociatedTokenPdaFor(vaultAddress, leg.mint, tokenProgram),
        leg.mint,
        await findPythPriceAccount(leg.feedId),
      );
    }

    const { value } = await client.rpc
      .getMultipleAccounts(
        [vaultAddress, shareMintAddress, solPriceAddress, ...legAddresses],
        { commitment: "confirmed", encoding: "base64" },
      )
      .send();

    const [vaultInfo, mintInfo, solPriceInfo, ...legInfos] = value;

    const vaultLamports = vaultInfo ? BigInt(vaultInfo.lamports) : 0n;
    const supply = mintInfo ? decodeMintSupply(decodeBase64(mintInfo.data[0])) : 0n;
    const rentReserve = tracker.rentReserve ?? 0n;
    const sleeveLamports =
      vaultLamports > rentReserve ? vaultLamports - rentReserve : 0n;

    const sol = solPriceInfo ? readPythPrice(decodeBase64(solPriceInfo.data[0])) : null;
    const now = BigInt(Math.floor(Date.now() / 1000));

    const holdings: Holding[] = legs.map((leg, i) => {
      const [tokenInfo, mintAccount, priceInfo] = legInfos.slice(i * 3, i * 3 + 3);
      const balance = tokenInfo ? decodeTokenAmount(decodeBase64(tokenInfo.data[0])) : 0n;
      const mintData = mintAccount ? decodeBase64(mintAccount.data[0]) : null;
      const decimals = mintData ? (readMintDecimals(mintData) ?? 0) : 0;
      const multiplierMicros = mintData ? scaledUiMultiplierMicros(mintData, now) : 1_000_000n;
      const equity = priceInfo ? readPythPrice(decodeBase64(priceInfo.data[0])) : null;

      // A zero balance is worth zero whether or not the oracle answered, so it
      // is not "unpriced" — only a position we hold and cannot value is.
      const unpriced = balance > 0n && (!equity || !sol);
      const lamports =
        equity && sol && balance > 0n
          ? legValueLamports({ balance, decimals, multiplierMicros, equity, sol })
          : 0n;

      return {
        index: i,
        mint: leg.mint,
        weightBps: leg.weightBps,
        balance,
        decimals,
        units: Number(balance) / 10 ** decimals * (Number(multiplierMicros) / 1e6),
        lamports,
        actualBps: null,
        priceUsd: equity ? Number(equity.price) * 10 ** equity.exponent : null,
        unpriced,
      };
    });

    const { netAssets, complete } = computeNav({ sleeveLamports, holdings });
    for (const h of holdings) {
      h.actualBps = netAssets > 0n ? Number((h.lamports * 10_000n) / netAssets) : null;
    }

    return {
      ticker,
      trackerAddress,
      vaultAddress,
      shareMintAddress,
      tracker,
      supply,
      vaultLamports,
      netAssets,
      sleeveLamports,
      holdings,
      navComplete: complete,
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
