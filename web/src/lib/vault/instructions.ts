import {
  AccountRole,
  type AccountMeta,
  type Address,
  type Instruction,
} from "@solana/kit";

import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  VAULT_PROGRAM_ADDRESS,
  encodeDepositData,
  encodeRedeemForSolData,
  encodeRedeemInKindData,
} from "./program";

type DepositParams = {
  depositor: Address;
  tracker: Address;
  shareMint: Address;
  vault: Address;
  feeRecipient: Address;
  depositorShares: Address;
  lamportsIn: bigint;
  minSharesOut: bigint;
  /**
   * From `buildOracleAccounts`: the SOL price, then a
   * `(mint, vault token account, price)` triple per tokenized leg.
   *
   * Required whenever the basket holds anything tokenized — the program counts
   * these and rejects a mismatch with `RemainingAccountsMismatch` rather than
   * valuing a partial basket. Empty is correct only for an all-SOL basket.
   */
  oracleAccounts: AccountMeta[];
};

/**
 * Account order must match the handler's destructuring, slot for slot.
 *
 * The associated-token program is **not** in this list any more. Anchor's
 * `deposit` created the share account with `init_if_needed`; the port requires
 * it to exist, so the caller batches
 * [`getCreateAssociatedTokenIdempotentInstruction`] ahead of this one. Same
 * rent, one fewer instruction class in an unaudited program.
 */
export function getDepositInstruction(params: DepositParams): Instruction {
  return {
    programAddress: VAULT_PROGRAM_ADDRESS,
    accounts: [
      { address: params.depositor, role: AccountRole.WRITABLE_SIGNER },
      { address: params.tracker, role: AccountRole.WRITABLE },
      { address: params.shareMint, role: AccountRole.WRITABLE },
      { address: params.vault, role: AccountRole.WRITABLE },
      { address: params.feeRecipient, role: AccountRole.WRITABLE },
      { address: params.depositorShares, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ...params.oracleAccounts,
    ],
    data: encodeDepositData(params.lamportsIn, params.minSharesOut),
  };
}

/**
 * Create the share token account if it does not exist.
 *
 * Idempotent, so it is safe to prepend to every deposit without first checking
 * whether the account is there — which saves a round trip and removes a race
 * between the check and the send.
 */
export function getCreateAssociatedTokenIdempotentInstruction(params: {
  payer: Address;
  owner: Address;
  mint: Address;
  ata: Address;
}): Instruction {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    accounts: [
      { address: params.payer, role: AccountRole.WRITABLE_SIGNER },
      { address: params.ata, role: AccountRole.WRITABLE },
      { address: params.owner, role: AccountRole.READONLY },
      { address: params.mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([1]),
  };
}

type RedeemParams = {
  holder: Address;
  tracker: Address;
  shareMint: Address;
  vault: Address;
  feeRecipient: Address;
  holderShares: Address;
  sharesIn: bigint;
  minLamportsOut: bigint;
  /** See `DepositParams.oracleAccounts` — a redemption values the basket too. */
  oracleAccounts: AccountMeta[];
};

export function getRedeemForSolInstruction(params: RedeemParams): Instruction {
  return {
    programAddress: VAULT_PROGRAM_ADDRESS,
    accounts: [
      { address: params.holder, role: AccountRole.WRITABLE_SIGNER },
      { address: params.tracker, role: AccountRole.WRITABLE },
      { address: params.shareMint, role: AccountRole.WRITABLE },
      { address: params.vault, role: AccountRole.WRITABLE },
      { address: params.feeRecipient, role: AccountRole.WRITABLE },
      { address: params.holderShares, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ...params.oracleAccounts,
    ],
    data: encodeRedeemForSolData(params.sharesIn, params.minLamportsOut),
  };
}

type RedeemInKindParams = {
  holder: Address;
  tracker: Address;
  shareMint: Address;
  vault: Address;
  holderShares: Address;
  sharesIn: bigint;
  /**
   * Per tokenized leg, in basket order:
   * `[leg mint, the vault's token account, the holder's token account]`.
   *
   * The holder's accounts must already exist — this instruction creates
   * nothing, and the legs are Token-2022 so their ATAs are derived under that
   * program, not the classic one.
   */
  legAccounts: Address[];
};

/**
 * Take delivery of the basket instead of selling it.
 *
 * Both token programs appear because the two halves genuinely use different
 * ones: the share mint is classic SPL Token and is burned through it, while
 * every leg is Token-2022 and moves through that. The Anchor program passed a
 * single token program for both, which could not have worked on mainnet.
 *
 * There is no fee recipient here: the redemption fee is a haircut that stays in
 * the vault and accrues to the remaining holders, rather than being swept out
 * in dust-sized token transfers.
 */
export function getRedeemInKindInstruction(
  params: RedeemInKindParams,
): Instruction {
  return {
    programAddress: VAULT_PROGRAM_ADDRESS,
    accounts: [
      { address: params.holder, role: AccountRole.WRITABLE_SIGNER },
      { address: params.tracker, role: AccountRole.WRITABLE },
      { address: params.shareMint, role: AccountRole.WRITABLE },
      { address: params.vault, role: AccountRole.WRITABLE },
      { address: params.holderShares, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ...params.legAccounts.map((address, i) => ({
        address,
        // Every third account is the leg mint, which is only read.
        role: i % 3 === 0 ? AccountRole.READONLY : AccountRole.WRITABLE,
      })),
    ],
    data: encodeRedeemInKindData(params.sharesIn),
  };
}

/**
 * Maps the program's custom error codes to the sentence a person should read.
 *
 * 6000..=6030 are **frozen** and match the Anchor program's numbering exactly.
 * That was deliberate on the Rust side: keeping them identical is what let this
 * table survive the port unchanged. Codes from 6031 are new to the port.
 */
const PROGRAM_ERRORS: Record<number, string> = {
  6000: "Enter an amount above zero.",
  6001: "Those holdings do not add up to 100%.",
  6002: "That tracker has too many positions.",
  6003: "That tracker has no holdings.",
  6004: "That ticker is not valid.",
  6005: "That name is not valid.",
  6006: "That symbol is not valid.",
  6007: "That fee is above the protocol maximum.",
  6008: "This tracker is paused, so deposits are closed. Redemption still works.",
  6009: "The vault is empty, so there is no price to mint against.",
  6010: "No tokens are outstanding, so there is nothing to redeem.",
  6011: "That deposit is too small to mint a whole token unit.",
  6012: "That redemption rounds down to zero. Try a larger amount.",
  6013: "The numbers overflowed. Try a smaller amount.",
  6014: "The vault cannot go below its rent reserve.",
  6015: "The tokenized positions passed in did not match the tracker's holdings.",
  6016: "A token account did not match the expected mint.",
  6017: "A token account is not owned by the expected wallet.",
  6018: "The price moved past your limit before this landed. Nothing was spent.",
  6019: "That swap was routed through an unexpected program.",
  6020: "That swap had no route attached.",
  6021: "A swap cannot trade a token for itself.",
  6022: "That token is not in this tracker's published basket.",
  6023: "That swap spent more than it was allowed to.",
  6024: "That swap did not take the tokens it was supposed to.",
  6025: "Tokens are still outstanding, so this tracker cannot be retired.",
  6026: "This tracker still holds tokenized positions. Empty them first.",
  6027: "A price feed returned an unusable price.",
  6028: "A price record did not match the position it was passed for.",
  6029: "That token's multiplier is outside the range the program accepts.",
  6030: "A price feed id did not match the one this position expects.",
  // ---- new in the Pinocchio port ----
  6031: "That signer is not allowed to do this.",
  6032: "An account was not the type this instruction expected.",
  6033: "That account uses a newer layout than this site can read.",
  6034: "An account was smaller than its layout requires.",
  6035: "That tracker was not sized for this many positions.",
  6036: "That position count is not valid.",
  6037: "Only the tracker's manager can change what it holds.",
  6038: "Only the tracker's authority can do this.",
  6039: "A required signature was missing.",
  6040: "An account was not owned by the program it should be.",
  6041: "A derived address did not match the account passed in.",
  6042: "That instruction was malformed.",
  6043: "This site sent an instruction the program does not have.",
  6044: "That instruction is not implemented.",
  6045: "An account this needs to write to was passed as read-only.",
};

/**
 * Turns a Kit or wallet error into one sentence a person can act on. Falls
 * back to the raw message rather than swallowing anything.
 */
export function explainTransactionError(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : String(error ?? "Unknown error");

  const custom = raw.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (custom) {
    const code = parseInt(custom[1], 16);
    if (PROGRAM_ERRORS[code]) return PROGRAM_ERRORS[code];
  }
  const anchorCode = raw.match(/"Custom":\s*(\d+)/);
  if (anchorCode) {
    const code = Number(anchorCode[1]);
    if (PROGRAM_ERRORS[code]) return PROGRAM_ERRORS[code];
  }

  if (/user rejected|rejected the request|declined/i.test(raw))
    return "You rejected the signature. Nothing was sent.";
  if (/insufficient lamports|insufficient funds|0x1\b/i.test(raw))
    return "Not enough SOL to cover the deposit plus fees.";
  if (/blockhash not found|block height exceeded/i.test(raw))
    return "That took too long and expired. Try again.";
  if (/fetch|network|timeout|failed to fetch/i.test(raw))
    return "The RPC did not answer. Check your connection and try again.";
  if (/already in use/i.test(raw))
    return "That account already exists on this cluster.";

  return raw;
}
