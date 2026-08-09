export const LAMPORTS_PER_SOL = 1_000_000_000n;

const solFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const navFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

export function lamportsToSolNumber(lamports: bigint): number {
  // Divide in bigint down to micro-SOL first so large vaults keep precision.
  return Number((lamports * 1_000_000n) / LAMPORTS_PER_SOL) / 1_000_000;
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

export const formatSol = (lamports: bigint) =>
  solFmt.format(lamportsToSolNumber(lamports));

export const formatUsd = (value: number) => usdFmt.format(value);

/** NAV per token, always four places so the column never changes width. */
export const formatNav = (nav: number) => navFmt.format(nav);

/**
 * Fees are parts per million on chain, so one unit is 0.0001%. Trailing zeros
 * are trimmed: 10 ppm reads "0.001%", not "0.0010%".
 */
export const formatPpm = (ppm: number) => {
  if (ppm === 0) return "0%";
  const pct = ppm / 10_000;
  return `${pct.toFixed(4).replace(/\.?0+$/, "")}%`;
};

export const formatWeight = (bps: number) => `${(bps / 100).toFixed(2)}%`;

export function formatShares(raw: bigint): string {
  return solFmt.format(lamportsToSolNumber(raw));
}

export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 1) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

export function formatTimestamp(unix: bigint | number): string {
  const ms = Number(unix) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return "n/a";
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function relativeDays(unix: bigint | number): string {
  const days = Math.floor((Date.now() - Number(unix) * 1000) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

/**
 * NAV per share. Returns 1 for an empty vault: before anyone deposits, one
 * share is worth exactly one lamport by construction, and showing 0 would be
 * a lie about the mint price.
 */
export function computeNav(netAssets: bigint, supply: bigint): number {
  if (supply === 0n) return 1;
  return Number((netAssets * 1_000_000n) / supply) / 1_000_000;
}
