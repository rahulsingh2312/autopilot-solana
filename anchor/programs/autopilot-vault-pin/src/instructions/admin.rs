//! The privileged instructions, and the role split that makes them safe.
//!
//! Every handler here requires the **authority** — the role that can reach
//! holder funds. `rebalance`, `swap_leg` and `set_token_metadata` require the
//! **manager** instead and live elsewhere, because a manager may reposition a
//! basket and must never be able to take anything out of it.
//!
//! That split is the whole reason a stranger can be handed a tracker. In the
//! Anchor program one `authority` both rebalanced and swept the vault, which is
//! fine while every tracker is ours and fatal the moment it is not.
//!
//! # On `emergency_withdraw_*`
//!
//! It is a deliberate, operator-controlled escape hatch, and it is the one path
//! that can take value from holders. It exists for failure modes redemption
//! cannot reach: a leg whose route disappears, a token the issuer pauses, a
//! basket left half-swapped by a reverted transaction.
//!
//! The trade is explicit and must stay disclosed: **the authority can remove
//! depositor assets.** Holders trust the key, not only the code. Keeping it
//! behind a multisig is what makes that trust reasonable.

use pinocchio::{AccountView, Address, ProgramResult};

use crate::error::VaultError;

/// `paused: u8` — any non-zero byte is true.
pub fn parse_paused(data: &[u8]) -> Result<bool, VaultError> {
    match data {
        [b] => Ok(*b != 0),
        _ => Err(VaultError::MalformedInstructionData),
    }
}

/// `deposit_fee_ppm: u16 || redeem_fee_ppm: u16`, little-endian.
pub fn parse_fees(data: &[u8]) -> Result<(u16, u16), VaultError> {
    if data.len() != 4 {
        return Err(VaultError::MalformedInstructionData);
    }
    Ok((
        u16::from_le_bytes([data[0], data[1]]),
        u16::from_le_bytes([data[2], data[3]]),
    ))
}

/// `amount: u64`, little-endian.
pub fn parse_amount(data: &[u8]) -> Result<u64, VaultError> {
    if data.len() != 8 {
        return Err(VaultError::MalformedInstructionData);
    }
    Ok(u64::from_le_bytes(data[0..8].try_into().unwrap()))
}

#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
use {
    crate::accounts::*,
    crate::constants::*,
    crate::spl::read_mint,
    crate::state::{Tracker, TrackerMut},
    pinocchio::cpi::{Seed, Signer},
    pinocchio_system::instructions::Transfer,
    pinocchio_token_2022::instructions::TransferChecked,
};

/// Load a tracker and prove the signer holds its authority.
///
/// Every check Anchor's `has_one = authority` plus `Signer<'info>` plus
/// `Account<'info, Tracker>` did, in the order that matters: ownership first,
/// because until it holds, the `authority` field being compared is a value the
/// caller chose.
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
fn authorize<'a>(
    program_id: &Address,
    authority: &AccountView,
    tracker_ai: &'a AccountView,
    tracker_data: &'a [u8],
) -> Result<Tracker<'a>, VaultError> {
    require_signer(authority)?;
    require_owned_by(tracker_ai, program_id)?;

    let tracker = Tracker::load(tracker_data)?;
    require_pda(
        tracker_ai,
        &[TRACKER_SEED, tracker.ticker()],
        tracker.bump(),
        program_id,
    )?;

    if tracker.authority() != authority.address().to_bytes() {
        return Err(VaultError::NotAuthority);
    }
    Ok(tracker)
}

// ---------------------------------------------------------------------------
// set_paused / set_fees
// ---------------------------------------------------------------------------

/// ```text
/// 0 authority  signer
/// 1 tracker    writable
/// ```
///
/// Halts deposits. Redemption deliberately stays open — a pause must never lock
/// holders out of their own money.
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
pub fn handle_set_paused(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    let paused = parse_paused(data)?;
    let [authority, tracker_ai, ..] = accounts else {
        return Err(VaultError::RemainingAccountsMismatch.into());
    };
    require_writable(tracker_ai)?;
    {
        let d = tracker_ai.try_borrow()?;
        authorize(program_id, authority, tracker_ai, &d)?;
    }
    let mut d = tracker_ai.try_borrow_mut()?;
    TrackerMut::load(&mut d)?.set_paused(paused);
    Ok(())
}

/// ```text
/// 0 authority  signer
/// 1 tracker    writable
/// ```
///
/// Fees can move, never above the ceiling compiled into the program. A tracker
/// cannot be reconfigured into a 90% exit tax after people have deposited.
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
pub fn handle_set_fees(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    let (deposit_ppm, redeem_ppm) = parse_fees(data)?;
    let [authority, tracker_ai, ..] = accounts else {
        return Err(VaultError::RemainingAccountsMismatch.into());
    };
    require_writable(tracker_ai)?;
    {
        let d = tracker_ai.try_borrow()?;
        authorize(program_id, authority, tracker_ai, &d)?;
    }
    let mut d = tracker_ai.try_borrow_mut()?;
    TrackerMut::load(&mut d)?.set_fees(deposit_ppm, redeem_ppm)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// set_authority / set_manager
// ---------------------------------------------------------------------------

/// ```text
/// 0 authority      signer
/// 1 tracker        writable
/// 2 new_authority  readonly — stored only
/// ```
///
/// Hands the fund-reaching role to another key. Both roles are changed by the
/// authority: a manager promoting itself would defeat the split entirely.
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
pub fn handle_set_authority(
    program_id: &Address,
    accounts: &mut [AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [authority, tracker_ai, new_key, ..] = accounts else {
        return Err(VaultError::RemainingAccountsMismatch.into());
    };
    require_writable(tracker_ai)?;
    {
        let d = tracker_ai.try_borrow()?;
        authorize(program_id, authority, tracker_ai, &d)?;
    }
    let new = new_key.address().to_bytes();
    let mut d = tracker_ai.try_borrow_mut()?;
    TrackerMut::load(&mut d)?.set_authority(&new);
    Ok(())
}

/// ```text
/// 0 authority    signer
/// 1 tracker      writable
/// 2 new_manager  readonly — stored only
/// ```
///
/// The instruction a creator flow turns on: hand the basket to a stranger while
/// the vault stays with us.
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
pub fn handle_set_manager(
    program_id: &Address,
    accounts: &mut [AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [authority, tracker_ai, new_key, ..] = accounts else {
        return Err(VaultError::RemainingAccountsMismatch.into());
    };
    require_writable(tracker_ai)?;
    {
        let d = tracker_ai.try_borrow()?;
        authorize(program_id, authority, tracker_ai, &d)?;
    }
    let new = new_key.address().to_bytes();
    let mut d = tracker_ai.try_borrow_mut()?;
    TrackerMut::load(&mut d)?.set_manager(&new);
    Ok(())
}

// ---------------------------------------------------------------------------
// emergency_withdraw_sol
// ---------------------------------------------------------------------------

/// ```text
/// 0 authority       signer
/// 1 tracker
/// 2 vault           writable
/// 3 destination     writable
/// 4 system_program
/// ```
///
/// The rent reserve is protected: taking it would close the vault account and
/// make the tracker unusable rather than merely empty, turning a recovery into
/// a demolition.
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
pub fn handle_emergency_withdraw_sol(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    let lamports = parse_amount(data)?;
    if lamports == 0 {
        return Err(VaultError::ZeroAmount.into());
    }

    let [authority, tracker_ai, vault_ai, destination, system_program, ..] = accounts else {
        return Err(VaultError::RemainingAccountsMismatch.into());
    };
    require_writable(vault_ai)?;
    require_writable(destination)?;
    require_program(system_program, &SYSTEM_PROGRAM_ID)?;

    let tracker_key = tracker_ai.address().to_bytes();
    let vault_bump;
    {
        let d = tracker_ai.try_borrow()?;
        let tracker = authorize(program_id, authority, tracker_ai, &d)?;
        require_pda(
            vault_ai,
            &[VAULT_SEED, &tracker_key],
            tracker.vault_bump(),
            program_id,
        )?;

        let available = vault_ai.lamports().saturating_sub(tracker.rent_reserve());
        if lamports > available {
            return Err(VaultError::InsufficientVaultBalance.into());
        }
        vault_bump = tracker.vault_bump();
    }

    let bump_seed = [vault_bump];
    let seeds = [
        Seed::from(VAULT_SEED),
        Seed::from(&tracker_key[..]),
        Seed::from(&bump_seed[..]),
    ];
    Transfer {
        from: vault_ai,
        to: destination,
        lamports,
    }
    .invoke_signed(&[Signer::from(&seeds)])?;

    Ok(())
}

// ---------------------------------------------------------------------------
// emergency_withdraw_token
// ---------------------------------------------------------------------------

/// ```text
/// 0 authority          signer
/// 1 tracker
/// 2 vault
/// 3 vault_token        writable
/// 4 destination_token  writable
/// 5 mint
/// 6 token_program
/// ```
///
/// `transfer_checked` rather than `transfer`, and through the Token-2022
/// interface, because every leg this could ever move is a Token-2022 mint. The
/// deprecated `transfer` fails outright on a mint carrying a transfer hook or a
/// transfer fee.
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
pub fn handle_emergency_withdraw_token(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    let amount = parse_amount(data)?;
    if amount == 0 {
        return Err(VaultError::ZeroAmount.into());
    }

    let [authority, tracker_ai, vault_ai, vault_token, destination_token, mint_ai, _token_program, ..] =
        accounts
    else {
        return Err(VaultError::RemainingAccountsMismatch.into());
    };
    require_writable(vault_token)?;
    require_writable(destination_token)?;

    let tracker_key = tracker_ai.address().to_bytes();
    let vault_bump;
    {
        let d = tracker_ai.try_borrow()?;
        let tracker = authorize(program_id, authority, tracker_ai, &d)?;
        require_pda(
            vault_ai,
            &[VAULT_SEED, &tracker_key],
            tracker.vault_bump(),
            program_id,
        )?;
        vault_bump = tracker.vault_bump();
    }

    // The source must belong to the vault, or this would move somebody else's
    // tokens under our signature.
    let (ta_mint, ta_owner, _) = crate::spl::read_token_account(vault_token)?;
    if ta_owner != vault_ai.address().to_bytes() {
        return Err(VaultError::TokenAccountOwnerMismatch.into());
    }
    if ta_mint != mint_ai.address().to_bytes() {
        return Err(VaultError::TokenAccountMintMismatch.into());
    }
    let (_, decimals) = read_mint(mint_ai)?;

    let bump_seed = [vault_bump];
    let seeds = [
        Seed::from(VAULT_SEED),
        Seed::from(&tracker_key[..]),
        Seed::from(&bump_seed[..]),
    ];

    TransferChecked::new(
        vault_token,
        mint_ai,
        destination_token,
        vault_ai,
        amount,
        decimals,
    )
    .invoke_signed(&[Signer::from(&seeds)])?;

    Ok(())
}

// ---------------------------------------------------------------------------
// close_tracker
// ---------------------------------------------------------------------------

/// ```text
/// 0 authority         signer
/// 1 rent_destination  writable
/// 2 tracker           writable
/// 3 share_mint
/// 4 vault             writable
/// 5 system_program
/// ```
///
/// Retires a tracker permanently.
///
/// Two rules make this safe, and both are enforced rather than documented:
///
/// - **It refuses while any share is outstanding.** A tracker with holders is
///   not the authority's to delete. The check reads the mint's own supply, not
///   a number this program stores, so there is no bookkeeping to get wrong.
/// - **Tokenized legs must be emptied first.** Lamports can be swept here, but
///   token accounts cannot be closed without their mints present, and silently
///   stranding a vault's xStocks behind a deleted config is exactly the kind of
///   quiet loss this codebase exists to avoid.
///
/// The share mint is deliberately left in place. Its authority is the tracker
/// PDA, which is being closed, so it becomes permanently immutable at zero
/// supply — a dead token nobody can ever mint again. Better than a mint whose
/// authority outlives the config that justified it.
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
pub fn handle_close_tracker(
    program_id: &Address,
    accounts: &mut [AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [authority, rent_destination, tracker_ai, share_mint_ai, vault_ai, system_program, ..] =
        accounts
    else {
        return Err(VaultError::RemainingAccountsMismatch.into());
    };
    require_writable(rent_destination)?;
    require_writable(tracker_ai)?;
    require_writable(vault_ai)?;
    require_program(system_program, &SYSTEM_PROGRAM_ID)?;

    let tracker_key = tracker_ai.address().to_bytes();
    let vault_bump;
    {
        let d = tracker_ai.try_borrow()?;
        let tracker = authorize(program_id, authority, tracker_ai, &d)?;

        if share_mint_ai.address().to_bytes() != tracker.share_mint() {
            return Err(VaultError::SeedsMismatch.into());
        }
        require_pda(
            vault_ai,
            &[VAULT_SEED, &tracker_key],
            tracker.vault_bump(),
            program_id,
        )?;

        let (supply, _) = read_mint(share_mint_ai)?;
        if supply != 0 {
            return Err(VaultError::SharesStillOutstanding.into());
        }
        for i in 0..tracker.leg_count() {
            if tracker.leg_is_tokenized(i) {
                return Err(VaultError::TokenizedLegsRemain.into());
            }
        }
        vault_bump = tracker.vault_bump();
    }

    // Sweep the vault, rent reserve included: with no shares outstanding there
    // is nobody left for it to belong to.
    let lamports = vault_ai.lamports();
    if lamports > 0 {
        let bump_seed = [vault_bump];
        let seeds = [
            Seed::from(VAULT_SEED),
            Seed::from(&tracker_key[..]),
            Seed::from(&bump_seed[..]),
        ];
        Transfer {
            from: vault_ai,
            to: rent_destination,
            lamports,
        }
        .invoke_signed(&[Signer::from(&seeds)])?;
    }

    // Lamports must leave before the close, or the instruction ends unbalanced.
    let tracker_lamports = tracker_ai.lamports();
    let dest_lamports = rent_destination.lamports();
    rent_destination.set_lamports(
        dest_lamports
            .checked_add(tracker_lamports)
            .ok_or(VaultError::MathOverflow)?,
    );
    tracker_ai.set_lamports(0);
    tracker_ai.close()?;

    Ok(())
}


/// Host builds without `host-pda` cannot derive addresses, so every handler is
/// absent rather than half-checked. The SBF build always has the syscalls.
#[cfg(not(any(target_os = "solana", target_arch = "bpf", feature = "host-pda")))]
mod host_stubs {
    use super::*;

    macro_rules! unavailable {
        ($($name:ident),* $(,)?) => {$(
            pub fn $name(_: &Address, _: &mut [AccountView], _: &[u8]) -> ProgramResult {
                Err(VaultError::NotImplemented.into())
            }
        )*};
    }

    unavailable!(
        handle_set_paused,
        handle_set_fees,
        handle_set_authority,
        handle_set_manager,
        handle_emergency_withdraw_sol,
        handle_emergency_withdraw_token,
        handle_close_tracker,
    );
}

#[cfg(not(any(target_os = "solana", target_arch = "bpf", feature = "host-pda")))]
pub use host_stubs::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_paused_flag() {
        assert_eq!(parse_paused(&[0]), Ok(false));
        assert_eq!(parse_paused(&[1]), Ok(true));
        assert_eq!(parse_paused(&[7]), Ok(true), "any non-zero byte is true");
        assert!(parse_paused(&[]).is_err());
        assert!(parse_paused(&[0, 0]).is_err());
    }

    #[test]
    fn parses_a_fee_pair() {
        let mut d = [0u8; 4];
        d[0..2].copy_from_slice(&2_500u16.to_le_bytes());
        d[2..4].copy_from_slice(&3_000u16.to_le_bytes());
        assert_eq!(parse_fees(&d), Ok((2_500, 3_000)));
        assert!(parse_fees(&[0u8; 3]).is_err());
        assert!(parse_fees(&[0u8; 5]).is_err());
    }

    #[test]
    fn parses_an_amount() {
        assert_eq!(parse_amount(&7u64.to_le_bytes()), Ok(7));
        assert!(parse_amount(&[0u8; 7]).is_err());
        assert!(parse_amount(&[0u8; 9]).is_err());
    }
}
