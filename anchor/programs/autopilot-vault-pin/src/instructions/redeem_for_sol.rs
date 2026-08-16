//! Burn shares, take SOL out of the sleeve.
//!
//! Ported from `autopilot-vault/src/instructions/redeem_for_sol.rs`.
//!
//! # Redemption stays open while paused
//!
//! `set_paused` gates deposits only, and this handler deliberately never reads
//! the flag. Pausing stops new money coming in; it must never trap money that
//! is already in. That property is asserted in `lib.rs`'s role table and again
//! in the differential suite.
//!
//! # The reserve check uses `gross`, not `net`
//!
//! `gross` is the holder's full pro-rata claim including the value of every
//! tokenized leg, so a large redemption out of a mostly-tokenized vault
//! computes a correct payout and then fails here, because the SOL sleeve
//! cannot cover it. That is the right failure rather than a partial one: the
//! holder's recourse is `redeem_in_kind`, which delivers the legs themselves,
//! needs no oracle, and is correct at any price.
//!
//! Operationally it also means **the sleeve is the peg-defence budget** — an
//! arbitrageur can only pull the pool back toward NAV through this path as far
//! as the sleeve reaches.

use pinocchio::{AccountView, Address, ProgramResult};

use crate::error::VaultError;

/// `shares_in: u64 || min_lamports_out: u64`, little-endian.
pub const ARGS_LEN: usize = 16;

pub fn parse_args(data: &[u8]) -> Result<(u64, u64), VaultError> {
    if data.len() != ARGS_LEN {
        return Err(VaultError::MalformedInstructionData);
    }
    let shares_in = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let min_lamports_out = u64::from_le_bytes(data[8..16].try_into().unwrap());
    Ok((shares_in, min_lamports_out))
}

#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
use {
    crate::accounts::*,
    crate::constants::*,
    crate::oracle::value_tokenized_legs,
    crate::spl::{read_mint, read_token_account},
    crate::state::{fee_on, mul_div, Tracker},
    pinocchio::cpi::{Seed, Signer},
    pinocchio::sysvars::{clock::Clock, Sysvar},
    pinocchio_system::instructions::Transfer,
    pinocchio_token::instructions::Burn,
};

/// ```text
/// 0 holder          signer, writable
/// 1 tracker         writable
/// 2 share_mint      writable
/// 3 vault           writable
/// 4 fee_recipient   writable
/// 5 holder_shares   writable
/// 6 token_program
/// 7 system_program
/// 8.. remaining     SOL price, then (leg mint, vault token account, price) per tokenized leg
/// ```
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
pub fn handle(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (shares_in, min_lamports_out) = parse_args(data)?;
    if shares_in == 0 {
        return Err(VaultError::ZeroAmount.into());
    }

    let [holder, tracker_ai, share_mint_ai, vault_ai, fee_recipient_ai, holder_shares, token_program, system_program, remaining @ ..] =
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
    require_writable(fee_recipient_ai)?;
    require_writable(holder_shares)?;
    require_program(token_program, &TOKEN_PROGRAM_ID)?;
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
    if fee_recipient_ai.address().to_bytes() != tracker.fee_recipient() {
        return Err(VaultError::SeedsMismatch.into());
    }

    let (shares_mint, shares_owner, _) = read_token_account(holder_shares)?;
    if shares_mint != tracker.share_mint() {
        return Err(VaultError::TokenAccountMintMismatch.into());
    }
    if shares_owner != holder.address().to_bytes() {
        return Err(VaultError::TokenAccountOwnerMismatch.into());
    }

    // ---- price the vault ----
    let (supply_before, _) = read_mint(share_mint_ai)?;
    if supply_before == 0 {
        return Err(VaultError::NoSharesOutstanding.into());
    }

    let vault_lamports = vault_ai.lamports();
    let vault_key = vault_ai.address().to_bytes();
    let now = Clock::get()?.unix_timestamp;

    // Valued the same way a deposit is, and for the same reason in reverse: a
    // holder redeeming out of a vault that holds equities is owed a share of
    // those equities too, not just of the SOL sleeve.
    let leg_value = value_tokenized_legs(&tracker, &vault_key, remaining, now)?;
    let assets_before = tracker
        .net_assets(vault_lamports)
        .checked_add(leg_value)
        .ok_or(VaultError::MathOverflow)?;
    if assets_before == 0 {
        return Err(VaultError::EmptyVault.into());
    }

    let gross = mul_div(assets_before, shares_in, supply_before)?;
    if gross == 0 {
        return Err(VaultError::RedemptionTooSmall.into());
    }

    let fee = fee_on(gross, tracker.redeem_fee_ppm())?;
    let net = gross.checked_sub(fee).ok_or(VaultError::MathOverflow)?;
    if net == 0 {
        return Err(VaultError::RedemptionTooSmall.into());
    }
    if net < min_lamports_out {
        return Err(VaultError::SlippageExceeded.into());
    }

    // The rent reserve is not depositor money and must survive the transfer.
    // Checked against `gross`, so the sleeve has to cover the whole claim —
    // see the module docs.
    if vault_lamports
        .checked_sub(gross)
        .ok_or(VaultError::MathOverflow)?
        < tracker.rent_reserve()
    {
        return Err(VaultError::InsufficientVaultBalance.into());
    }

    let vault_bump = tracker.vault_bump();
    drop(tracker_data);

    // ---- burn, then pay ----
    //
    // The holder signs the burn directly, so no seeds are needed here. Burning
    // first means a failed payout reverts the whole transaction rather than
    // leaving shares destroyed and nothing delivered.
    Burn::new(holder_shares, share_mint_ai, holder, shares_in).invoke()?;

    let vault_bump_seed = [vault_bump];
    let vault_seeds = [
        Seed::from(VAULT_SEED),
        Seed::from(&tracker_key[..]),
        Seed::from(&vault_bump_seed[..]),
    ];

    Transfer {
        from: vault_ai,
        to: holder,
        lamports: net,
    }
    .invoke_signed(&[Signer::from(&vault_seeds)])?;

    if fee > 0 {
        Transfer {
            from: vault_ai,
            to: fee_recipient_ai,
            lamports: fee,
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
        let mut d = [0u8; ARGS_LEN];
        d[0..8].copy_from_slice(&500u64.to_le_bytes());
        d[8..16].copy_from_slice(&400u64.to_le_bytes());
        assert_eq!(parse_args(&d).unwrap(), (500, 400));
    }

    #[test]
    fn rejects_a_wrong_length_payload() {
        assert!(parse_args(&[0u8; ARGS_LEN - 1]).is_err());
        assert!(parse_args(&[0u8; ARGS_LEN + 1]).is_err());
    }
}
