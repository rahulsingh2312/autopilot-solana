"use client";

import useSWR from "swr";

import type { XStockAsset } from "@/app/api/xstocks/assets/route";

export type { XStockAsset };

const fetcher = (url: string) =>
  fetch(url).then(
    (r) => r.json() as Promise<{ assets: Record<string, XStockAsset> }>,
  );

/**
 * Backed's asset directory, fetched once and shared by every holdings row on
 * the page. Immutable for the session: the list changes when Backed lists a
 * new equity, which is not something a visitor needs to watch happen.
 */
export function useXstocks() {
  const { data } = useSWR("/api/xstocks/assets", fetcher, {
    revalidateOnFocus: false,
    revalidateIfStale: false,
    revalidateOnReconnect: false,
  });
  return data?.assets ?? {};
}

/**
 * The mark beside a holding. A name with an xStock gets Backed's own token
 * artwork; a name without one gets its initial set in ink. The difference is
 * the point — an unmarked row is a holding this vault cannot actually buy on
 * chain, and it should not be able to borrow the look of one that can.
 */
export function TokenMark({
  symbol,
  asset,
  size = 20,
}: {
  symbol: string;
  asset?: XStockAsset;
  size?: number;
}) {
  if (asset) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element -- the src is a
         runtime value from Backed's CDN, and at 20px the optimizer would cost
         a round trip to save nothing. */
      <img
        src={asset.logo}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        title={`${asset.symbol} · ${asset.name}`}
        className="shrink-0 rounded-[5px] ring-1 ring-black/10"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      aria-hidden
      title={`${symbol} has no xStock. Held in the SOL sleeve.`}
      className="num flex shrink-0 items-center justify-center rounded-[5px] border border-rule bg-paper text-[0.5rem] font-semibold text-faint"
      style={{ width: size, height: size }}
    >
      {symbol.slice(0, 2)}
    </span>
  );
}
