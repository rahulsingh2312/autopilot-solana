/**
 * Verified on-chain bindings for every tokenized leg.
 *
 * The data lives in `leg-bindings.json` and this file only types it. That split
 * is not cosmetic: the oracle pusher is a CommonJS script — the Pyth SDK cannot
 * be loaded as ESM — and it has to read the same feed ids the vault was seeded
 * with. Two hand-maintained copies of that list is exactly the bug worth
 * designing out, so both sides read one JSON file.
 *
 * Checked in rather than resolved from an API at deploy time. Binding a vault
 * leg to the wrong mint is unrecoverable, and the search endpoints that would
 * resolve these carry impostors: a query for SpaceX returns eight tokens all
 * named "SpaceX - Backpack Securities", one with a fire emoji, ranging from $11
 * to $2,212 of liquidity. A reviewable file beats a live lookup.
 *
 * Every entry was confirmed against Jupiter's `verified` tag with a matching
 * symbol, and every Pyth feed is the `Equity.US.<SYM>/USD` id.
 *
 * `mint`     the SPL Token-2022 mint the vault holds
 * `pythFeed` the price feed for the *underlying equity*, not for the token
 */

import bindings from "./leg-bindings.json" with { type: "json" };

export type LegBinding = {
  symbol: string;
  mint: string;
  pythFeed: string;
  issuer: string;
  /**
   * The token program that owns this mint, recorded because it is a seed of the
   * vault's associated token account. Every leg is Token-2022 today; deriving
   * one with the classic program yields a well-formed address that no account
   * exists at, which fails as a missing account rather than as a wrong one.
   */
  tokenProgram: string;
};

export const LEG_BINDINGS: Record<string, LegBinding> = bindings;

/**
 * Throws rather than returning undefined: an unbound leg must never silently
 * become a zero mint, which would route its weight into the SOL sleeve without
 * anyone deciding to.
 */
export function legBinding(xstock: string): LegBinding {
  const b = LEG_BINDINGS[xstock];
  if (!b) throw new Error(`no verified binding for ${xstock}`);
  return b;
}

/** Reverse index, built once — the on-chain basket names legs by mint. */
const BY_MINT = new Map(
  Object.values(LEG_BINDINGS).map((b) => [b.mint, b] as const),
);

/**
 * The token program owning a leg mint.
 *
 * Throws on an unknown mint. A default would be worse than a failure here: the
 * wrong guess derives a token account address the vault does not hold, and the
 * program reports it as an account that is not a token account — an error that
 * says nothing about the actual cause.
 */
export function tokenProgramOfMint(mint: string): string {
  const b = BY_MINT.get(mint);
  if (!b) throw new Error(`no verified binding for mint ${mint}`);
  return b.tokenProgram;
}
