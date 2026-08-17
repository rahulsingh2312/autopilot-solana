/**
 * The oracle accounts a deposit or redemption has to carry.
 *
 * `value_tokenized_legs` takes them as trailing accounts in a fixed shape:
 *
 * ```text
 * [0]        SOL/USD price
 * [1 + 3n]   leg mint
 * [2 + 3n]   the *vault's* token account for that leg
 * [3 + 3n]   the leg's price account
 * ```
 *
 * in basket order, counting only tokenized legs. The program walks the basket
 * itself and matches the Nth tokenized leg to the Nth triple, so untokenized
 * legs are skipped on both sides and must not be given a triple.
 *
 * Every account here is checked on chain — the mint against the leg's recorded
 * mint, the token account against both that mint and the vault as owner, the
 * price account against the leg's feed id, its owner, its discriminator and its
 * publish time. Getting one wrong produces a failed transaction, not a
 * mispriced one. That is worth stating plainly, because this file derives
 * addresses that a caller could otherwise be tempted to pass loosely.
 */

import {
  getAddressEncoder,
  getProgramDerivedAddress,
  AccountRole,
  type Address,
  type AccountMeta,
  type ReadonlyUint8Array,
} from "@solana/kit";

import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, type TrackerAccount } from "./program";

/**
 * Pyth's sponsored feed accounts are PDAs of the *push oracle* program, though
 * the accounts themselves are owned by the receiver.
 *
 * Deriving these against the receiver instead is a mistake that looks like it
 * works — it produces a valid-looking address for every feed, and every one of
 * them is empty.
 */
const PUSH_ORACLE_PROGRAM =
  "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT" as Address;

/** `Crypto.SOL/USD`. The program compiles this id in and checks it. */
export const SOL_USD_FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/** Shard 0 is the sponsored shard the vault's feed ids were bound against. */
const SHARD_ID = 0;

const encoder = getAddressEncoder();

const hexToBytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));

/** The sponsored price account for one feed. */
export async function findPythPriceAccount(
  feedId: ReadonlyUint8Array | string,
  shardId = SHARD_ID,
): Promise<Address> {
  const shard = new Uint8Array(2);
  new DataView(shard.buffer).setUint16(0, shardId, true);
  const id = typeof feedId === "string" ? hexToBytes(feedId) : feedId;
  const [address] = await getProgramDerivedAddress({
    programAddress: PUSH_ORACLE_PROGRAM,
    seeds: [shard, id],
  });
  return address;
}

/**
 * An associated token account for an arbitrary token program.
 *
 * `findAssociatedTokenPda` in `program.ts` hardcodes the classic program
 * because the share mint is classic. The legs are Token-2022, and the token
 * program is part of the ATA seeds — so using that helper for a leg derives a
 * plausible address that no account will ever exist at.
 */
export async function findAssociatedTokenPdaFor(
  owner: Address,
  mint: Address,
  tokenProgram: Address,
): Promise<Address> {
  const [address] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [
      encoder.encode(owner),
      encoder.encode(tokenProgram),
      encoder.encode(mint),
    ],
  });
  return address;
}

/**
 * Build the trailing accounts for one tracker, in the order the program walks.
 *
 * `tokenProgramOf` maps a leg mint to the token program that owns it, which is
 * what decides the vault's token account address. It comes from the checked-in
 * bindings rather than from an RPC read, so this stays synchronous with respect
 * to the network and cannot start returning different addresses because a
 * lookup failed.
 *
 * All accounts are read-only: valuation reads, it never writes.
 */
export async function buildOracleAccounts(
  tracker: TrackerAccount,
  vault: Address,
  tokenProgramOf: (mint: Address) => Address,
): Promise<AccountMeta[]> {
  const tokenized = tracker.legs.filter((leg) => !isZeroMint(leg.mint));
  if (tokenized.length === 0) return [];

  const readonly = (address: Address): AccountMeta => ({
    address,
    role: AccountRole.READONLY,
  });

  const metas: AccountMeta[] = [readonly(await findPythPriceAccount(SOL_USD_FEED_ID))];

  for (const leg of tokenized) {
    const tokenProgram = tokenProgramOf(leg.mint);
    metas.push(
      readonly(leg.mint),
      readonly(await findAssociatedTokenPdaFor(vault, leg.mint, tokenProgram)),
      readonly(await findPythPriceAccount(leg.feedId)),
    );
  }

  return metas;
}

/**
 * The zero mint marks a leg held as SOL rather than as a token.
 *
 * The program's own test is the same one: a leg is tokenized iff its mint is
 * not all zeroes. Devnet baskets were entirely zero mints, which is why the
 * frontend could ignore oracles until now.
 */
export function isZeroMint(mint: Address): boolean {
  return mint === "11111111111111111111111111111111";
}
