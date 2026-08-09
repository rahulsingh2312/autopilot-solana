/**
 * Hand-rolled Kit client for the autopilot_vault program.
 *
 * Small enough that a codegen step would cost more than it saves: three
 * account layouts and two instructions. Discriminators are Anchor's
 * `sha256("global:<ix>")[0..8]` and `sha256("account:<T>")[0..8]`, computed
 * once and pinned here so nothing has to hash at runtime.
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
  getU32Decoder,
  getU32Encoder,
  getU64Decoder,
  getU64Encoder,
  getU8Decoder,
  getUtf8Decoder,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";

import { PROGRAM_ID } from "@/lib/config";

export const VAULT_PROGRAM_ADDRESS = PROGRAM_ID as Address;

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
export const SYSTEM_PROGRAM_ADDRESS =
  "11111111111111111111111111111111" as Address;

const utf8 = new TextEncoder();

// ── PDAs ──────────────────────────────────────────────────────────────

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

// ── Account decoding ──────────────────────────────────────────────────

export type OnChainLeg = {
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
  legs: OnChainLeg[];
  depositFeeBps: number;
  redeemFeeBps: number;
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

// Borsh strings are u32-length-prefixed; a bare utf8 decoder would swallow
// the rest of the account.
const legDecoder = getStructDecoder([
  ["mint", getAddressDecoder()],
  ["symbol", addDecoderSizePrefix(getUtf8Decoder(), getU32Decoder())],
  ["weightBps", getU16Decoder()],
]);

/**
 * Anchor allocates the account at max size, so the tail is zero padding.
 * Reading field by field with explicit offsets avoids a decoder that insists
 * on consuming the whole buffer.
 */
export function decodeTracker(data: ReadonlyUint8Array): TrackerAccount | null {
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

  let o = 8;
  const [authority, o1] = addr.read(data, o);
  o = o1;
  const [shareMint, o2] = addr.read(data, o);
  o = o2;
  const [feeRecipient, o3] = addr.read(data, o);
  o = o3;

  const readString = (): string => {
    const [len, next] = u32.read(data, o);
    const bytes = data.slice(next, next + len);
    o = next + len;
    return new TextDecoder().decode(bytes as Uint8Array);
  };

  const ticker = readString();
  const name = readString();

  const [legCount, oLegs] = u32.read(data, o);
  o = oLegs;
  const legs: OnChainLeg[] = [];
  for (let i = 0; i < legCount; i++) {
    const [leg, next] = legDecoder.read(data, o);
    o = next;
    legs.push(leg as OnChainLeg);
  }

  const [depositFeeBps, o4] = u16.read(data, o);
  o = o4;
  const [redeemFeeBps, o5] = u16.read(data, o);
  o = o5;
  const [rebalanceInterval, o6] = i64.read(data, o);
  o = o6;
  const [lastRebalanceTs, o7] = i64.read(data, o);
  o = o7;
  const [rebalanceCount, o8] = u32.read(data, o);
  o = o8;
  const [filingDelayDays, o9] = u16.read(data, o);
  o = o9;
  const [rentReserve, o10] = u64.read(data, o);
  o = o10;
  const [paused, o11] = bool.read(data, o);
  o = o11;
  const [createdAt, o12] = i64.read(data, o);
  o = o12;
  const [bump, o13] = u8.read(data, o);
  o = o13;
  const [vaultBump, o14] = u8.read(data, o);
  o = o14;
  const [mintBump] = u8.read(data, o);

  return {
    authority,
    shareMint,
    feeRecipient,
    ticker,
    name,
    legs,
    depositFeeBps,
    redeemFeeBps,
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

const depositArgsEncoder = getStructEncoder([
  ["discriminator", getBytesEncoder()],
  ["lamportsIn", getU64Encoder()],
  ["minSharesOut", getU64Encoder()],
]);

export function encodeDepositData(lamportsIn: bigint, minSharesOut: bigint) {
  return depositArgsEncoder.encode({
    discriminator: IX_DISCRIMINATORS.deposit,
    lamportsIn,
    minSharesOut,
  });
}

const redeemArgsEncoder = getStructEncoder([
  ["discriminator", getBytesEncoder()],
  ["sharesIn", getU64Encoder()],
  ["minLamportsOut", getU64Encoder()],
]);

export function encodeRedeemForSolData(
  sharesIn: bigint,
  minLamportsOut: bigint,
) {
  return redeemArgsEncoder.encode({
    discriminator: IX_DISCRIMINATORS.redeemForSol,
    sharesIn,
    minLamportsOut,
  });
}

/** Exported for the init script, which runs in Node rather than the browser. */
export const stringEncoder = addEncoderSizePrefix(
  getBytesEncoder(),
  getU32Encoder(),
);
