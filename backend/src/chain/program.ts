/**
 * Kit client for the autopilot_vault program, worker side.
 *
 * A deliberate copy of the browser client's layout knowledge rather than a
 * shared package: the two run on different release cadences and a backend that
 * silently changed shape when the site was redeployed would be worse than a
 * duplicated struct. The discriminators and field order here MUST match
 * `web/src/lib/vault/program.ts`; `npm run typecheck` will not catch a drift,
 * only a decode failure at runtime will, so the decoder validates aggressively.
 */

import {
  addDecoderSizePrefix,
  addEncoderSizePrefix,
  getAddressDecoder,
  getAddressEncoder,
  getBooleanDecoder,
  getBytesEncoder,
  getI64Decoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getStructEncoder,
  getU16Decoder,
  getU16Encoder,
  getU32Decoder,
  getU32Encoder,
  getU64Decoder,
  getU8Decoder,
  getUtf8Decoder,
  getUtf8Encoder,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";

import { env } from "../env.ts";

export const VAULT_PROGRAM_ADDRESS = env.programId as Address;

/** Anchor's `sha256("global:<name>")[0..8]`, pinned so nothing hashes at runtime. */
export const IX_DISCRIMINATORS = {
  initializeTracker: new Uint8Array([27, 157, 128, 87, 48, 201, 132, 35]),
  deposit: new Uint8Array([242, 35, 198, 137, 82, 225, 242, 182]),
  redeemForSol: new Uint8Array([60, 155, 227, 70, 252, 132, 98, 231]),
  redeemInKind: new Uint8Array([102, 58, 189, 252, 192, 219, 140, 89]),
  rebalance: new Uint8Array([108, 158, 77, 9, 210, 52, 88, 62]),
  setPaused: new Uint8Array([91, 60, 125, 192, 176, 225, 166, 218]),
  setFees: new Uint8Array([137, 178, 49, 58, 0, 245, 242, 190]),
} as const;

export const TRACKER_DISCRIMINATOR = new Uint8Array([
  31, 18, 229, 12, 35, 100, 128, 68,
]);

export const TOKEN_PROGRAM_ADDRESS =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
export const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111" as Address;
/** `Pubkey::default()`, which the program reads as "leg has no tokenized form". */
export const ZERO_ADDRESS = SYSTEM_PROGRAM_ADDRESS;

const utf8 = new TextEncoder();

// ── PDAs ──────────────────────────────────────────────────────────────

export async function findTrackerPda(ticker: string): Promise<Address> {
  const [address] = await getProgramDerivedAddress({
    programAddress: VAULT_PROGRAM_ADDRESS,
    seeds: [utf8.encode("tracker"), utf8.encode(ticker)],
  });
  return address;
}

export async function findVaultPda(tracker: Address): Promise<Address> {
  const [address] = await getProgramDerivedAddress({
    programAddress: VAULT_PROGRAM_ADDRESS,
    seeds: [utf8.encode("vault"), getAddressEncoder().encode(tracker)],
  });
  return address;
}

export async function findShareMintPda(tracker: Address): Promise<Address> {
  const [address] = await getProgramDerivedAddress({
    programAddress: VAULT_PROGRAM_ADDRESS,
    seeds: [utf8.encode("share"), getAddressEncoder().encode(tracker)],
  });
  return address;
}

export async function findAssociatedTokenPda(
  owner: Address,
  mint: Address,
): Promise<Address> {
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

// ── Accounts ──────────────────────────────────────────────────────────

export type OnChainLegAccount = {
  mint: Address;
  symbol: string;
  weightBps: number;
};

export type TrackerAccount = {
  authority: Address;
  shareMint: Address;
  feeRecipient: Address;
  ticker: string;
  name: string;
  legs: OnChainLegAccount[];
  depositFeePpm: number;
  redeemFeePpm: number;
  rebalanceInterval: bigint;
  lastRebalanceTs: bigint;
  rebalanceCount: number;
  filingDelayDays: number;
  rentReserve: bigint;
  paused: boolean;
  createdAt: bigint;
  bump: number;
  vaultBump: number;
  mintBump: number;
};

const legDecoder = getStructDecoder([
  ["mint", getAddressDecoder()],
  // Borsh strings are u32-length-prefixed; a bare utf8 decoder would swallow
  // the rest of the account.
  ["symbol", addDecoderSizePrefix(getUtf8Decoder(), getU32Decoder())],
  ["weightBps", getU16Decoder()],
]);

/**
 * Anchor allocates the account at max size, so the tail is zero padding and a
 * whole-buffer decoder would fail. Fields are read at explicit offsets.
 */
export function decodeTracker(data: ReadonlyUint8Array): TrackerAccount | null {
  if (data.length < 8) return null;
  for (let i = 0; i < 8; i++) {
    if (data[i] !== TRACKER_DISCRIMINATOR[i]) return null;
  }

  const addr = getAddressDecoder();
  const u32 = getU32Decoder();
  const u16 = getU16Decoder();
  const u8 = getU8Decoder();
  const u64 = getU64Decoder();
  const i64 = getI64Decoder();
  const bool = getBooleanDecoder();

  let offset = 8;
  const [authority, a1] = addr.read(data, offset);
  offset = a1;
  const [shareMint, a2] = addr.read(data, offset);
  offset = a2;
  const [feeRecipient, a3] = addr.read(data, offset);
  offset = a3;

  const readString = (): string => {
    const [length, next] = u32.read(data, offset);
    if (length > 1024) throw new Error("tracker string length out of range");
    const bytes = data.slice(next, next + length);
    offset = next + length;
    return new TextDecoder().decode(bytes as Uint8Array);
  };

  const ticker = readString();
  const name = readString();

  const [legCount, afterCount] = u32.read(data, offset);
  offset = afterCount;
  if (legCount > 16) throw new Error(`tracker reports ${legCount} legs, max is 16`);

  const legs: OnChainLegAccount[] = [];
  for (let i = 0; i < legCount; i++) {
    const [leg, next] = legDecoder.read(data, offset);
    offset = next;
    legs.push(leg as OnChainLegAccount);
  }

  const [depositFeePpm, b1] = u16.read(data, offset);
  offset = b1;
  const [redeemFeePpm, b2] = u16.read(data, offset);
  offset = b2;
  const [rebalanceInterval, b3] = i64.read(data, offset);
  offset = b3;
  const [lastRebalanceTs, b4] = i64.read(data, offset);
  offset = b4;
  const [rebalanceCount, b5] = u32.read(data, offset);
  offset = b5;
  const [filingDelayDays, b6] = u16.read(data, offset);
  offset = b6;
  const [rentReserve, b7] = u64.read(data, offset);
  offset = b7;
  const [paused, b8] = bool.read(data, offset);
  offset = b8;
  const [createdAt, b9] = i64.read(data, offset);
  offset = b9;
  const [bump, b10] = u8.read(data, offset);
  offset = b10;
  const [vaultBump, b11] = u8.read(data, offset);
  offset = b11;
  const [mintBump] = u8.read(data, offset);

  return {
    authority,
    shareMint,
    feeRecipient,
    ticker,
    name,
    legs,
    depositFeePpm,
    redeemFeePpm,
    rebalanceInterval,
    lastRebalanceTs,
    rebalanceCount,
    filingDelayDays,
    rentReserve,
    paused,
    createdAt,
    bump,
    vaultBump,
    mintBump,
  };
}

/** SPL Mint is a fixed 82-byte layout; supply is a LE u64 at offset 36. */
export const decodeMintSupply = (data: ReadonlyUint8Array): bigint =>
  getU64Decoder().read(data, 36)[0];

/** SPL token account: amount is a LE u64 at offset 64. */
export const decodeTokenAmount = (data: ReadonlyUint8Array): bigint =>
  getU64Decoder().read(data, 64)[0];

// ── Instruction data ──────────────────────────────────────────────────

const stringEncoder = addEncoderSizePrefix(getUtf8Encoder(), getU32Encoder());
const legEncoder = getStructEncoder([
  ["mint", getAddressEncoder()],
  ["symbol", stringEncoder],
  ["weightBps", getU16Encoder()],
]);

export type EncodableLeg = { mint: Address; symbol: string; weightBps: number };

/**
 * `rebalance(legs: Vec<BasketLeg>)`.
 *
 * A Vec is a u32 count followed by the elements, so this is assembled by hand
 * rather than through a fixed struct encoder.
 */
export function encodeRebalanceData(legs: EncodableLeg[]): Uint8Array {
  const count = getU32Encoder().encode(legs.length);
  const encoded = legs.map((leg) => legEncoder.encode(leg));

  const size =
    IX_DISCRIMINATORS.rebalance.length +
    count.length +
    encoded.reduce((total, bytes) => total + bytes.length, 0);

  const out = new Uint8Array(size);
  let offset = 0;
  out.set(IX_DISCRIMINATORS.rebalance, offset);
  offset += IX_DISCRIMINATORS.rebalance.length;
  out.set(count, offset);
  offset += count.length;
  for (const bytes of encoded) {
    out.set(bytes, offset);
    offset += bytes.length;
  }
  return out;
}

export function encodeSetPausedData(paused: boolean): Uint8Array {
  const out = new Uint8Array(9);
  out.set(IX_DISCRIMINATORS.setPaused, 0);
  out[8] = paused ? 1 : 0;
  return out;
}

export function encodeSetFeesData(
  depositFeePpm: number,
  redeemFeePpm: number,
): Uint8Array {
  const u16 = getU16Encoder();
  const out = new Uint8Array(12);
  out.set(IX_DISCRIMINATORS.setFees, 0);
  out.set(u16.encode(depositFeePpm), 8);
  out.set(u16.encode(redeemFeePpm), 10);
  return out;
}
