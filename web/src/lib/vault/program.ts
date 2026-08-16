/**
 * Hand-rolled Kit client for the `autopilot_vault_pin` program.
 *
 * # This targets the Pinocchio program, not the Anchor one
 *
 * Two things changed and both are visible right here:
 *
 * - **Discriminators are one byte**, not Anchor's 8-byte
 *   `sha256("global:<ix>")[0..8]`. The program numbers its instructions in a
 *   plain enum, so this table is the enum, transcribed.
 * - **Accounts are fixed-offset**, not borsh. The Anchor `Tracker` began with
 *   an 8-byte account discriminator and put a length-prefixed `ticker` and
 *   `name` before the basket, so every field after the first string sat at an
 *   offset that depended on the data and had to be *walked*. The port writes a
 *   1-byte type tag, a version, and then fixed offsets — so this decoder
 *   indexes rather than walks, and a truncated account fails a length check
 *   instead of silently decoding garbage.
 *
 * The offsets below mirror `state::tracker` in the program. They are duplicated
 * rather than generated on purpose: `header_layout_is_frozen` on the Rust side
 * asserts them, so a change has to be made in two places deliberately.
 */

import {
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU16Decoder,
  getU64Decoder,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";

import { PROGRAM_ID } from "@/lib/config";

export const VAULT_PROGRAM_ADDRESS = PROGRAM_ID as Address;

/**
 * One-byte instruction discriminators, mirroring `Instruction` in the
 * program's `lib.rs`. The values are positional — inserting a variant
 * renumbers everything after it, which is why the Rust side has
 * `discriminators_round_trip` guarding them.
 */
export const IX = {
  initializeTracker: 0,
  deposit: 1,
  redeemForSol: 2,
  redeemInKind: 3,
  rebalance: 4,
  swapLeg: 5,
  setTokenMetadata: 6,
  setPaused: 7,
  setFees: 8,
  emergencyWithdrawSol: 9,
  emergencyWithdrawToken: 10,
  setAuthority: 11,
  setManager: 12,
  closeTracker: 13,
  setLegFeed: 14,
} as const;

/** Account type tags. `2` is reserved: it was `LegOracle`, now deleted. */
export const TAG_TRACKER = 1;
export const LAYOUT_VERSION = 1;

export const TOKEN_PROGRAM_ADDRESS =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
export const TOKEN_2022_PROGRAM_ADDRESS =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
export const SYSTEM_PROGRAM_ADDRESS =
  "11111111111111111111111111111111" as Address;

const utf8 = new TextEncoder();

// ── PDAs ──────────────────────────────────────────────────────────────
//
// Seeds are unchanged from the Anchor program, but the *program id* is not, so
// every address below differs. Nothing from the old deployment is reachable
// through this client.

export async function findTrackerPda(ticker: string) {
  const [address] = await getProgramDerivedAddress({
    programAddress: VAULT_PROGRAM_ADDRESS,
    seeds: [utf8.encode("tracker"), utf8.encode(ticker)],
  });
  return address;
}

export async function findVaultPda(tracker: Address) {
  const [address] = await getProgramDerivedAddress({
    programAddress: VAULT_PROGRAM_ADDRESS,
    seeds: [utf8.encode("vault"), getAddressEncoder().encode(tracker)],
  });
  return address;
}

export async function findShareMintPda(tracker: Address) {
  const [address] = await getProgramDerivedAddress({
    programAddress: VAULT_PROGRAM_ADDRESS,
    seeds: [utf8.encode("share"), getAddressEncoder().encode(tracker)],
  });
  return address;
}

export async function findAssociatedTokenPda(owner: Address, mint: Address) {
  const encoder = getAddressEncoder();
  const [address] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [
      encoder.encode(owner),
      encoder.encode(TOKEN_PROGRAM_ADDRESS),
      encoder.encode(mint),
    ],
  });
  return address;
}

// ── Account layout ────────────────────────────────────────────────────

/** Byte offsets into a `Tracker` account. Mirrors `state::tracker`. */
const T = {
  TAG: 0,
  VERSION: 1,
  STRATEGY: 2,
  PAUSED: 3,
  BUMP: 4,
  VAULT_BUMP: 5,
  MINT_BUMP: 6,
  MAX_LEGS: 7,
  LEG_COUNT: 8,
  TICKER_LEN: 9,
  TICKER: 10,
  AUTHORITY: 22,
  MANAGER: 54,
  SHARE_MINT: 86,
  FEE_RECIPIENT: 118,
  RENT_RESERVE: 150,
  DEPOSIT_FEE_PPM: 158,
  REDEEM_FEE_PPM: 160,
  RESERVED: 162,
  LEGS: 170,
} as const;

const MAX_TICKER_LEN = 12;
export const LEG_SIZE = 66;
const LEG_MINT = 0;
const LEG_WEIGHT_BPS = 32;
const LEG_FEED_ID = 34;

export type OnChainLeg = {
  mint: Address;
  weightBps: number;
  /**
   * Pyth feed id for the underlying equity. Lives here now — the Anchor
   * program kept it in a separate `LegOracle` PDA alongside a multiplier
   * pushed over HTTP. The multiplier turned out to be readable straight off the
   * mint's Token-2022 ScaledUiAmount extension, so the PDA is gone and this is
   * all that was left of it.
   */
  feedId: ReadonlyUint8Array;
};

export type TrackerAccount = {
  /** Can reach holder funds: fees, pause, emergency withdrawal, role changes. */
  authority: Address;
  /** Can change what the basket holds, and nothing else. */
  manager: Address;
  shareMint: Address;
  feeRecipient: Address;
  ticker: string;
  strategy: number;
  legs: OnChainLeg[];
  maxLegs: number;
  depositFeePpm: number;
  redeemFeePpm: number;
  rentReserve: bigint;
  paused: boolean;
  bump: number;
  vaultBump: number;
  mintBump: number;
};

/**
 * Decode a `Tracker`, or return null if this is not one.
 *
 * Checks the type tag *and* the layout version. The version check is the part
 * worth keeping: a future layout that this build cannot read must decode to
 * nothing rather than to plausible-looking wrong numbers, because the number it
 * would get wrong is NAV.
 */
export function decodeTracker(data: ReadonlyUint8Array): TrackerAccount | null {
  if (data.length < T.LEGS) return null;
  if (data[T.TAG] !== TAG_TRACKER) return null;
  if (data[T.VERSION] !== LAYOUT_VERSION) return null;

  const maxLegs = data[T.MAX_LEGS];
  const legCount = data[T.LEG_COUNT];
  if (maxLegs === 0 || legCount > maxLegs) return null;
  if (data.length < T.LEGS + maxLegs * LEG_SIZE) return null;

  const tickerLen = data[T.TICKER_LEN];
  if (tickerLen === 0 || tickerLen > MAX_TICKER_LEN) return null;

  const addr = getAddressDecoder();
  const u16 = getU16Decoder();
  const u64 = getU64Decoder();

  const legs: OnChainLeg[] = [];
  for (let i = 0; i < legCount; i++) {
    const at = T.LEGS + i * LEG_SIZE;
    const [mint] = addr.read(data, at + LEG_MINT);
    const [weightBps] = u16.read(data, at + LEG_WEIGHT_BPS);
    legs.push({
      mint,
      weightBps,
      feedId: data.slice(at + LEG_FEED_ID, at + LEG_FEED_ID + 32),
    });
  }

  const [authority] = addr.read(data, T.AUTHORITY);
  const [manager] = addr.read(data, T.MANAGER);
  const [shareMint] = addr.read(data, T.SHARE_MINT);
  const [feeRecipient] = addr.read(data, T.FEE_RECIPIENT);
  const [rentReserve] = u64.read(data, T.RENT_RESERVE);
  const [depositFeePpm] = u16.read(data, T.DEPOSIT_FEE_PPM);
  const [redeemFeePpm] = u16.read(data, T.REDEEM_FEE_PPM);

  return {
    authority,
    manager,
    shareMint,
    feeRecipient,
    ticker: new TextDecoder().decode(
      data.slice(T.TICKER, T.TICKER + tickerLen) as Uint8Array,
    ),
    strategy: data[T.STRATEGY],
    legs,
    maxLegs,
    depositFeePpm,
    redeemFeePpm,
    rentReserve,
    paused: data[T.PAUSED] !== 0,
    bump: data[T.BUMP],
    vaultBump: data[T.VAULT_BUMP],
    mintBump: data[T.MINT_BUMP],
  };
}

/** SPL Mint is a fixed 82-byte layout; supply is a LE u64 at offset 36. */
export function decodeMintSupply(data: ReadonlyUint8Array): bigint {
  const [supply] = getU64Decoder().read(data, 36);
  return supply;
}

/** SPL token account: amount is a LE u64 at offset 64. */
export function decodeTokenAmount(data: ReadonlyUint8Array): bigint {
  const [amount] = getU64Decoder().read(data, 64);
  return amount;
}

// ── Instruction data ──────────────────────────────────────────────────
//
// Built by hand rather than through Kit's struct encoders: every payload here
// is a one-byte tag followed by fixed-width little-endian fields, which is
// less code written directly than described to an encoder.

const u16le = (n: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
};

const u64le = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export function encodeDepositData(lamportsIn: bigint, minSharesOut: bigint) {
  return concat(new Uint8Array([IX.deposit]), u64le(lamportsIn), u64le(minSharesOut));
}

export function encodeRedeemForSolData(
  sharesIn: bigint,
  minLamportsOut: bigint,
) {
  return concat(
    new Uint8Array([IX.redeemForSol]),
    u64le(sharesIn),
    u64le(minLamportsOut),
  );
}

/**
 * In-kind redemption takes no slippage floor: it delivers a pro-rata slice of
 * whatever the vault holds, which needs no price and cannot be quoted wrong.
 */
export function encodeRedeemInKindData(sharesIn: bigint) {
  return concat(new Uint8Array([IX.redeemInKind]), u64le(sharesIn));
}

export function encodeSetFeesData(depositFeePpm: number, redeemFeePpm: number) {
  return concat(
    new Uint8Array([IX.setFees]),
    u16le(depositFeePpm),
    u16le(redeemFeePpm),
  );
}

export function encodeSetPausedData(paused: boolean) {
  return new Uint8Array([IX.setPaused, paused ? 1 : 0]);
}

/**
 * A leg as an instruction carries it: **no feed id**.
 *
 * Feed ids travel separately, via [`encodeSetLegFeedData`]. Carrying them
 * inline made a leg 66 bytes on the wire, so a full sixteen-leg basket was
 * 1,058 bytes of instruction data and would not fit a 1,232-byte transaction —
 * `cgSOL` and `aiSOL` were unsendable. At 34 bytes the same basket is 546.
 *
 * It also matches how the fields behave: weights move on every filing, feed ids
 * essentially never move. `write_legs` on the program side carries existing
 * feed ids forward by mint, so a reweighting never unconfigures an oracle.
 */
export type LegInput = {
  mint: Address;
  weightBps: number;
};

export function encodeRebalanceData(legs: LegInput[]) {
  const enc = getAddressEncoder();
  return concat(
    new Uint8Array([IX.rebalance, legs.length]),
    ...legs.flatMap((l) => [new Uint8Array(enc.encode(l.mint)), u16le(l.weightBps)]),
  );
}

/** Point one leg at its Pyth feed. `legIndex` is the position in the basket. */
export function encodeSetLegFeedData(legIndex: number, feedId: Uint8Array) {
  if (feedId.length !== 32) throw new Error("feed id must be 32 bytes");
  return concat(new Uint8Array([IX.setLegFeed, legIndex]), feedId);
}
