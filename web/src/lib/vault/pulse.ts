"use client";

import { useCallback } from "react";
import { useClient } from "@solana/react";
import useSWR from "swr";

import type { AppClient } from "@/app/providers";

export type ChainPulse = {
  slot: bigint;
  tps: number | null;
  epoch: number;
  epochProgress: number;
};

/**
 * Live cluster vitals for the ticker rail. Everything here is read from the
 * chain: no simulated prices, no invented deltas. If a number is on the tape,
 * an RPC returned it.
 */
export function useChainPulse(refreshMs = 4000) {
  const client = useClient<AppClient>();

  const fetcher = useCallback(async (): Promise<ChainPulse> => {
    const [slot, epochInfo, samples] = await Promise.all([
      client.rpc.getSlot({ commitment: "confirmed" }).send(),
      client.rpc.getEpochInfo({ commitment: "confirmed" }).send(),
      client.rpc
        .getRecentPerformanceSamples(1)
        .send()
        .catch(() => []),
    ]);

    const sample = samples?.[0];
    const tps =
      sample && Number(sample.samplePeriodSecs) > 0
        ? Number(sample.numTransactions) / Number(sample.samplePeriodSecs)
        : null;

    const slotsInEpoch = Number(epochInfo.slotsInEpoch) || 1;

    return {
      slot: BigInt(slot),
      tps,
      epoch: Number(epochInfo.epoch),
      epochProgress: Number(epochInfo.slotIndex) / slotsInEpoch,
    };
  }, [client]);

  const { data } = useSWR("chain-pulse", fetcher, {
    refreshInterval: refreshMs,
    keepPreviousData: true,
  });

  return data;
}
