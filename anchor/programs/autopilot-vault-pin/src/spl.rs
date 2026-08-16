//! Reading SPL Token and Token-2022 accounts.
//!
//! Anchor's `InterfaceAccount<TokenAccount>` did three things at once: checked
//! the account is owned by *a* token program, deserialized it, and bounds-
//! checked the read. All three are explicit here.
//!
//! # Why both programs are accepted
//!
//! The share mint is classic SPL Token — `initialize_tracker` creates it that
//! way — while every tokenized equity leg is Token-2022, because xStocks carry
//! a permanent delegate, a pausable config and a scaled-UI-amount multiplier.
//! A reader pinned to either program alone makes half of this program's
//! accounts unreadable.
//!
//! # Why fixed offsets are safe here
//!
//! Token-2022 appends its extensions *after* the 165-byte base account, and
//! the base layout is identical to classic SPL Token's. The three fields read
//! below all sit inside that shared prefix, so one set of offsets serves both.
//! Anything beyond `amount` would need extension-aware parsing.

use pinocchio::AccountView;

use crate::accounts::{TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID};
use crate::error::VaultError;
use crate::state::Address as RawAddress;

// Token account, shared prefix.
const TA_MINT: usize = 0;
const TA_OWNER: usize = 32;
const TA_AMOUNT: usize = 64;
const TA_MIN_LEN: usize = 72;

// Mint, shared prefix: `COption<Address> mint_authority` is 4 + 32.
const MINT_SUPPLY: usize = 36;
const MINT_DECIMALS: usize = 44;
const MINT_MIN_LEN: usize = 45;

/// True if the account belongs to either token program.
#[inline]
fn owned_by_a_token_program(a: &AccountView) -> bool {
    a.owned_by(&TOKEN_PROGRAM_ID) || a.owned_by(&TOKEN_2022_PROGRAM_ID)
}

/// `(mint, owner, amount)` from a token account of either program.
pub fn read_token_account(a: &AccountView) -> Result<(RawAddress, RawAddress, u64), VaultError> {
    if !owned_by_a_token_program(a) {
        return Err(VaultError::InvalidAccountOwner);
    }
    let data = a.try_borrow().map_err(|_| VaultError::InvalidAccountOwner)?;
    if data.len() < TA_MIN_LEN {
        return Err(VaultError::AccountTooSmall);
    }

    let mut mint = [0u8; 32];
    mint.copy_from_slice(&data[TA_MINT..TA_MINT + 32]);
    let mut owner = [0u8; 32];
    owner.copy_from_slice(&data[TA_OWNER..TA_OWNER + 32]);
    let amount = u64::from_le_bytes(
        data[TA_AMOUNT..TA_AMOUNT + 8]
            .try_into()
            .map_err(|_| VaultError::AccountTooSmall)?,
    );

    Ok((mint, owner, amount))
}

/// `(supply, decimals)` from a mint of either program.
///
/// Supply *is* the share count for this program — there is no second copy on
/// the `Tracker` that could drift out of sync — so this is read fresh on every
/// deposit and redemption rather than cached.
pub fn read_mint(a: &AccountView) -> Result<(u64, u8), VaultError> {
    if !owned_by_a_token_program(a) {
        return Err(VaultError::InvalidAccountOwner);
    }
    let data = a.try_borrow().map_err(|_| VaultError::InvalidAccountOwner)?;
    if data.len() < MINT_MIN_LEN {
        return Err(VaultError::AccountTooSmall);
    }

    let supply = u64::from_le_bytes(
        data[MINT_SUPPLY..MINT_SUPPLY + 8]
            .try_into()
            .map_err(|_| VaultError::AccountTooSmall)?,
    );
    Ok((supply, data[MINT_DECIMALS]))
}
