//! Deposit SOL, receive shares priced off vault NAV.
//!
//! Ported from `autopilot-vault/src/instructions/deposit.rs`. One deliberate
//! narrowing:
//!
//! - **The share token account must already exist.** Anchor used
//!   `init_if_needed`, which pulls in the associated-token program and an
//!   instruction class with a known reinitialization footgun. Creating the ATA
//!   is one extra instruction the caller puts in the same transaction —
//!   standard practice, identical rent, and it keeps `init_if_needed` out of an
//!   unaudited program.
//!
//! Everything else is intended to be behaviourally identical, and
//! `tests/differential.rs` is what says so.

use pinocchio::{AccountView, Address, ProgramResult};

use crate::error::VaultError;

/// `lamports_in: u64 || min_shares_out: u64`, little-endian.
pub const ARGS_LEN: usize = 16;

pub fn parse_args(data: &[u8]) -> Result<(u64, u64), VaultError> {
    if data.len() != ARGS_LEN {
        return Err(VaultError::MalformedInstructionData);
    }
    let lamports_in = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let min_shares_out = u64::from_le_bytes(data[8..16].try_into().unwrap());
    Ok((lamports_in, min_shares_out))
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
    pinocchio_token::instructions::MintTo,
};

/// ```text
/// 0 depositor         signer, writable
/// 1 tracker           writable
/// 2 share_mint        writable
/// 3 vault             writable
/// 4 fee_recipient     writable
/// 5 depositor_shares  writable  — must already exist
/// 6 token_program
/// 7 system_program
/// 8.. remaining       SOL price, then (leg mint, vault token account, price) per tokenized leg
/// ```
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
pub fn handle(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (lamports_in, min_shares_out) = parse_args(data)?;
    if lamports_in == 0 {
        return Err(VaultError::ZeroAmount.into());
    }

    let [depositor, tracker_ai, share_mint_ai, vault_ai, fee_recipient_ai, depositor_shares, token_program, system_program, remaining @ ..] =
        accounts
    else {
        return Err(VaultError::RemainingAccountsMismatch.into());
    };

    // ---- account validation ----
    require_signer(depositor)?;
    require_writable(depositor)?;
    require_writable(tracker_ai)?;
    require_writable(share_mint_ai)?;
    require_writable(vault_ai)?;
    require_writable(fee_recipient_ai)?;
    require_writable(depositor_shares)?;
    require_program(token_program, &TOKEN_PROGRAM_ID)?;
    require_program(system_program, &SYSTEM_PROGRAM_ID)?;

    // The tracker must be ours before a single field is believed.
    require_owned_by(tracker_ai, program_id)?;
    let tracker_data = tracker_ai.try_borrow()?;
    let tracker = Tracker::load(&tracker_data)?;

    if tracker.paused() {
        return Err(VaultError::TrackerPaused.into());
    }

    // `seeds`/`bump` and `has_one`, by hand.
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

    // The destination must be the depositor's own account for this mint, or a
    // caller could mint someone else's shares into an account they control.
    let (shares_mint, shares_owner, _) = read_token_account(depositor_shares)?;
    if shares_mint != tracker.share_mint() {
        return Err(VaultError::TokenAccountMintMismatch.into());
    }
    if shares_owner != depositor.address().to_bytes() {
        return Err(VaultError::TokenAccountOwnerMismatch.into());
    }

    // ---- price the vault as it stands *before* this deposit lands ----
    let fee = fee_on(lamports_in, tracker.deposit_fee_ppm())?;
    let net = lamports_in
        .checked_sub(fee)
        .ok_or(VaultError::MathOverflow)?;
    if net == 0 {
        return Err(VaultError::ZeroAmount.into());
    }

    let (supply_before, _) = read_mint(share_mint_ai)?;

    let vault_key = vault_ai.address().to_bytes();
    let now = Clock::get()?.unix_timestamp;
    let leg_value = value_tokenized_legs(&tracker, &vault_key, remaining, now)?;

    // Counting lamports alone — which is all this did before the vault could
    // hold equities — would price a token-heavy vault at a fraction of its
    // worth and mint the depositor a correspondingly huge number of shares,
    // diluting everyone already in it.
    let assets_before = tracker
        .net_assets(vault_ai.lamports())
        .checked_add(leg_value)
        .ok_or(VaultError::MathOverflow)?;

    let shares_out = if supply_before == 0 {
        // Genesis: one share per lamport, so NAV per token starts at exactly
        // 1.0 given the share mint shares SOL's 9 decimals.
        net
    } else {
        if assets_before == 0 {
            return Err(VaultError::EmptyVault.into());
        }
        mul_div(net, supply_before, assets_before)?
    };

    if shares_out == 0 {
        return Err(VaultError::DepositTooSmall.into());
    }
    // The caller's slippage floor, enforced on chain rather than trusted from
    // the UI: NAV can move between the quote they saw and the slot this lands in.
    if shares_out < min_shares_out {
        return Err(VaultError::SlippageExceeded.into());
    }

    // Everything the signing seeds need, copied out before the borrow ends.
    // The borrow has to end before the CPIs, which re-enter the runtime and
    // take their own borrows of these same accounts.
    let bump = tracker.bump();
    let ticker_len = tracker.ticker().len();
    let mut ticker_buf = [0u8; MAX_TICKER_LEN];
    ticker_buf[..ticker_len].copy_from_slice(tracker.ticker());
    drop(tracker_data);

    // ---- move the money ----
    Transfer {
        from: depositor,
        to: vault_ai,
        lamports: net,
    }
    .invoke()?;

    if fee > 0 {
        Transfer {
            from: depositor,
            to: fee_recipient_ai,
            lamports: fee,
        }
        .invoke()?;
    }

    let bump_seed = [bump];
    let tracker_seeds = [
        Seed::from(TRACKER_SEED),
        Seed::from(&ticker_buf[..ticker_len]),
        Seed::from(&bump_seed[..]),
    ];

    MintTo::new(share_mint_ai, depositor_shares, tracker_ai, shares_out)
        .invoke_signed(&[Signer::from(&tracker_seeds)])?;

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
        d[0..8].copy_from_slice(&1_000_000_000u64.to_le_bytes());
        d[8..16].copy_from_slice(&999u64.to_le_bytes());
        assert_eq!(parse_args(&d).unwrap(), (1_000_000_000, 999));
    }

    /// Exact length, so a caller cannot omit the slippage floor and have it
    /// read as zero.
    #[test]
    fn rejects_a_wrong_length_payload() {
        assert!(parse_args(&[0u8; ARGS_LEN - 1]).is_err());
        assert!(parse_args(&[0u8; ARGS_LEN + 1]).is_err());
    }
}
