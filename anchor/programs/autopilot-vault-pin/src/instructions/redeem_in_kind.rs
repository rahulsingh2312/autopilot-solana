//! Take delivery of the basket instead of selling it.
//!
//! Burns shares and pays out a pro-rata slice of **every tokenized leg** plus a
//! pro-rata slice of the SOL sleeve. The redemption fee is applied as a haircut
//! that stays in the vault, accruing to the remaining holders, rather than
//! being swept to the fee wallet in sixteen dust-sized token transfers.
//!
//! # Why this path is load-bearing rather than a nice-to-have
//!
//! It is **oracle-free**. It pays `vault_balance × shares ÷ supply` per leg,
//! which is correct at any price, so it keeps working when `redeem_for_sol`
//! cannot:
//!
//! - When a Pyth feed is stale or broken, valuation fails and SOL redemption
//!   reverts. This does not consult a price at all.
//! - When the vault is mostly tokenized, `redeem_for_sol` computes a correct
//!   payout and then fails its reserve check because the SOL sleeve cannot
//!   cover the whole claim. This delivers the legs themselves.
//!
//! In both cases this is the holder's only exit. A vault whose only redemption
//! path depends on an oracle being healthy is a vault that can trap people.
//!
//! # Two bugs in the Anchor original, fixed here by construction
//!
//! The Anchor version could never have worked on mainnet, and neither failure
//! is visible on devnet because no devnet leg is tokenized:
//!
//! 1. **One token program cannot serve both halves.** It burned the share mint
//!    and transferred the legs through a single `token_program` account. The
//!    share mint is classic SPL Token; xStocks are Token-2022. Whichever
//!    program was passed, one half failed. Here the burn goes through
//!    `pinocchio_token` and the transfers through `pinocchio_token_2022`, which
//!    are distinct types resolved at compile time — the mistake is not
//!    expressible.
//! 2. **It disagreed with the rest of the program about who owns a leg.** It
//!    required the vault's token accounts to be owned by the *tracker* PDA and
//!    signed with tracker seeds, while `swap_leg` and `oracle.rs` both require
//!    the *vault* PDA. Resolved to the vault, which is what acquires and values
//!    the assets.
//!
//! # On Token-2022 extensions
//!
//! `transfer_checked`, never `transfer` — the deprecated form fails outright on
//! a mint carrying a transfer hook or a transfer fee.
//!
//! Delivery is computed and then transferred, which is only sound because these
//! mints charge **no transfer fee** (verified against the live NVDAx and AAPLx
//! mints). Were a fee ever enabled, the receiver would get less than computed
//! and this would need delta-aware accounting instead. `token22::has_transfer_fee`
//! exists so a keeper can watch for that.

use pinocchio::{AccountView, Address, ProgramResult};

use crate::error::VaultError;

/// `shares_in: u64`, little-endian.
pub const ARGS_LEN: usize = 8;

pub fn parse_args(data: &[u8]) -> Result<u64, VaultError> {
    if data.len() != ARGS_LEN {
        return Err(VaultError::MalformedInstructionData);
    }
    Ok(u64::from_le_bytes(data[0..8].try_into().unwrap()))
}

#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
use {
    crate::accounts::*,
    crate::constants::*,
    crate::spl::{read_mint, read_token_account},
    crate::state::{mul_div, Tracker},
    pinocchio::cpi::{Seed, Signer},
    pinocchio_system::instructions::Transfer,
    pinocchio_token::instructions::Burn,
    pinocchio_token_2022::instructions::TransferChecked,
};

/// ```text
/// 0 holder              signer, writable
/// 1 tracker             writable
/// 2 share_mint          writable
/// 3 vault               writable
/// 4 holder_shares       writable
/// 5 token_program       classic SPL Token — burns the share mint
/// 6 token_2022_program  Token-2022 — moves the legs
/// 7 system_program
/// 8.. remaining         per tokenized leg, in basket order:
///                       (leg mint, vault token account, holder token account)
/// ```
///
/// Both token programs appear because the two halves genuinely use different
/// ones. The holder's leg token accounts must already exist — this instruction
/// creates nothing.
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
pub fn handle(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let shares_in = parse_args(data)?;
    if shares_in == 0 {
        return Err(VaultError::ZeroAmount.into());
    }

    let [holder, tracker_ai, share_mint_ai, vault_ai, holder_shares, token_program, token_2022_program, system_program, remaining @ ..] =
        accounts
    else {
        return Err(VaultError::RemainingAccountsMismatch.into());
    };

    // ---- account validation ----
    require_signer(holder)?;
    require_writable(holder)?;
    require_writable(tracker_ai)?;
    require_writable(share_mint_ai)?;
    require_writable(vault_ai)?;
    require_writable(holder_shares)?;
    require_program(token_program, &TOKEN_PROGRAM_ID)?;
    require_program(token_2022_program, &TOKEN_2022_PROGRAM_ID)?;
    require_program(system_program, &SYSTEM_PROGRAM_ID)?;

    require_owned_by(tracker_ai, program_id)?;
    let tracker_data = tracker_ai.try_borrow()?;
    let tracker = Tracker::load(&tracker_data)?;

    let tracker_key = tracker_ai.address().to_bytes();
    require_pda(
        tracker_ai,
        &[TRACKER_SEED, tracker.ticker()],
        tracker.bump(),
        program_id,
    )?;
    require_pda(
        vault_ai,
        &[VAULT_SEED, &tracker_key],
        tracker.vault_bump(),
        program_id,
    )?;
    if share_mint_ai.address().to_bytes() != tracker.share_mint() {
        return Err(VaultError::SeedsMismatch.into());
    }

    let (shares_mint, shares_owner, _) = read_token_account(holder_shares)?;
    if shares_mint != tracker.share_mint() {
        return Err(VaultError::TokenAccountMintMismatch.into());
    }
    if shares_owner != holder.address().to_bytes() {
        return Err(VaultError::TokenAccountOwnerMismatch.into());
    }

    let (supply_before, _) = read_mint(share_mint_ai)?;
    if supply_before == 0 {
        return Err(VaultError::NoSharesOutstanding.into());
    }

    let tokenized = tracker.tokenized_leg_count() as usize;
    if remaining.len() != tokenized * 3 {
        return Err(VaultError::RemainingAccountsMismatch.into());
    }

    let keep_ppm = FEE_DENOMINATOR
        .checked_sub(u64::from(tracker.redeem_fee_ppm()))
        .ok_or(VaultError::MathOverflow)?;

    // ---- size every payout against pre-burn state ----
    //
    // Computed in full before anything is burned or moved, so a leg that fails
    // validation reverts the whole transaction rather than leaving shares
    // destroyed and only some of the basket delivered.
    let mut amounts = [0u64; MAX_LEGS as usize];
    let mut decimals = [0u8; MAX_LEGS as usize];
    let mut slot = 0usize;

    for i in 0..tracker.leg_count() {
        let Some(leg) = tracker.leg(i) else { continue };
        if !leg.is_tokenized() {
            continue;
        }

        let base = slot * 3;
        let mint_ai = &remaining[base];
        let vault_ta = &remaining[base + 1];
        let holder_ta = &remaining[base + 2];

        if mint_ai.address().to_bytes() != leg.mint {
            return Err(VaultError::TokenAccountMintMismatch.into());
        }

        let (v_mint, v_owner, v_amount) = read_token_account(vault_ta)?;
        if v_mint != leg.mint {
            return Err(VaultError::TokenAccountMintMismatch.into());
        }
        // The vault owns the legs — see the module docs on the Anchor
        // disagreement this resolves.
        if v_owner != vault_ai.address().to_bytes() {
            return Err(VaultError::TokenAccountOwnerMismatch.into());
        }

        let (h_mint, h_owner, _) = read_token_account(holder_ta)?;
        if h_mint != leg.mint {
            return Err(VaultError::TokenAccountMintMismatch.into());
        }
        // Without this, a caller could have the basket delivered anywhere.
        if h_owner != holder.address().to_bytes() {
            return Err(VaultError::TokenAccountOwnerMismatch.into());
        }

        let (_, mint_decimals) = read_mint(mint_ai)?;
        let pro_rata = mul_div(v_amount, shares_in, supply_before)?;
        amounts[slot] = mul_div(pro_rata, keep_ppm, FEE_DENOMINATOR)?;
        decimals[slot] = mint_decimals;
        slot += 1;
    }

    // ---- the SOL sleeve, pro-rata ----
    //
    // `net_assets` counts lamports only, deliberately: the legs are being
    // delivered in kind, so valuing them here would pay them out twice.
    let vault_lamports = vault_ai.lamports();
    let sol_gross = mul_div(
        tracker.net_assets(vault_lamports),
        shares_in,
        supply_before,
    )?;
    let sol_out = mul_div(sol_gross, keep_ppm, FEE_DENOMINATOR)?;

    if sol_out == 0 && amounts[..slot].iter().all(|a| *a == 0) {
        return Err(VaultError::RedemptionTooSmall.into());
    }
    if vault_lamports
        .checked_sub(sol_out)
        .ok_or(VaultError::MathOverflow)?
        < tracker.rent_reserve()
    {
        return Err(VaultError::InsufficientVaultBalance.into());
    }

    let vault_bump = tracker.vault_bump();
    drop(tracker_data);

    // ---- burn, then deliver ----
    Burn::new(holder_shares, share_mint_ai, holder, shares_in).invoke()?;

    let vault_bump_seed = [vault_bump];
    let vault_seeds = [
        Seed::from(VAULT_SEED),
        Seed::from(&tracker_key[..]),
        Seed::from(&vault_bump_seed[..]),
    ];

    for (index, amount) in amounts[..slot].iter().enumerate() {
        if *amount == 0 {
            continue;
        }
        let base = index * 3;
        TransferChecked::new(
            &remaining[base + 1],
            &remaining[base],
            &remaining[base + 2],
            vault_ai,
            *amount,
            decimals[index],
        )
        .invoke_signed(&[Signer::from(&vault_seeds)])?;
    }

    if sol_out > 0 {
        Transfer {
            from: vault_ai,
            to: holder,
            lamports: sol_out,
        }
        .invoke_signed(&[Signer::from(&vault_seeds)])?;
    }

    Ok(())
}

#[cfg(not(any(target_os = "solana", target_arch = "bpf", feature = "host-pda")))]
pub fn handle(_: &Address, _: &mut [AccountView], _: &[u8]) -> ProgramResult {
    Err(VaultError::NotImplemented.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_arguments() {
        assert_eq!(parse_args(&500u64.to_le_bytes()), Ok(500));
    }

    /// Exact length. There is no slippage floor on this instruction — delivery
    /// is pro-rata of whatever is there and needs no price — so a trailing
    /// field would be a caller misunderstanding worth rejecting loudly.
    #[test]
    fn rejects_a_wrong_length_payload() {
        assert!(parse_args(&[0u8; ARGS_LEN - 1]).is_err());
        assert!(parse_args(&[0u8; ARGS_LEN + 1]).is_err());
    }
}
