import { AccountRole, type Address, type Instruction } from "@solana/kit";

import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  VAULT_PROGRAM_ADDRESS,
  encodeDepositData,
  encodeRedeemForSolData,
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
};

/** Account order must match the `Deposit` struct in the program, field for field. */
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
      {
        address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
        role: AccountRole.READONLY,
      },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: encodeDepositData(params.lamportsIn, params.minSharesOut),
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
    ],
    data: encodeRedeemForSolData(params.sharesIn, params.minLamportsOut),
  };
}

/**
 * Maps the program's custom error codes to the sentence a person should read.
 * Anchor numbers `#[error_code]` variants from 6000 in declaration order.
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
