//! The checks Anchor used to generate.
//!
//! Every one of these corresponds to something a `#[derive(Accounts)]`
//! attribute did silently in the other program:
//!
//! | Anchor | Here |
//! | --- | --- |
//! | `Signer<'info>` | [`require_signer`] |
//! | `#[account(mut)]` | [`require_writable`] |
//! | `Account<'info, T>` owner check | [`require_owned_by`] |
//! | `seeds = [..], bump` | [`require_pda`] |
//! | `has_one = x` | [`require_address`] |
//! | `Program<'info, System>` | [`require_program`] |
//! | `init` (account must not exist) | [`require_uninitialized`] |
//!
//! They are free functions rather than a macro on purpose: a reader can see
//! exactly which checks a handler performs by reading the handler, and a
//! missing one shows up as an absent line rather than an absent attribute.

use pinocchio::{AccountView, Address};

use crate::error::VaultError;

/// The System program's address. Compared against rather than trusted from an
/// account slot, so a caller cannot pass an impostor "system program".
pub const SYSTEM_PROGRAM_ID: Address = Address::new_from_array([0u8; 32]);

/// SPL Token (classic). The share mint is a classic mint, matching the Anchor
/// program — only the tokenized equity legs are Token-2022.
pub const TOKEN_PROGRAM_ID: Address = Address::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);

/// SPL Token-2022. The tokenized equity legs are Token-2022 mints — with a
/// permanent delegate, a pausable config and a scaled-UI-amount multiplier — so
/// any path that touches a leg has to accept this program as well as the
/// classic one. Pinning either alone makes half the program's accounts
/// unreadable, which is the bug `swap_leg`'s comment records having hit once.
pub const TOKEN_2022_PROGRAM_ID: Address = Address::new_from_array([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77,
    131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252,
]);

#[inline]
pub fn require_signer(a: &AccountView) -> Result<(), VaultError> {
    if a.is_signer() {
        Ok(())
    } else {
        Err(VaultError::MissingSigner)
    }
}

#[inline]
pub fn require_writable(a: &AccountView) -> Result<(), VaultError> {
    if a.is_writable() {
        Ok(())
    } else {
        Err(VaultError::InvalidAccountOwner)
    }
}

/// The `has_one = x` equivalent: this account must be exactly the key the
/// tracker recorded.
#[inline]
pub fn require_address(a: &AccountView, expected: &Address) -> Result<(), VaultError> {
    if a.address() == expected {
        Ok(())
    } else {
        Err(VaultError::SeedsMismatch)
    }
}

/// An initialized account of ours must be owned by us. Without this, a caller
/// can hand over a look-alike account they control the bytes of, and every
/// field the handler reads afterwards is attacker-chosen. This is the single
/// most important check in the file.
#[inline]
pub fn require_owned_by(a: &AccountView, owner: &Address) -> Result<(), VaultError> {
    if a.owned_by(owner) {
        Ok(())
    } else {
        Err(VaultError::InvalidAccountOwner)
    }
}

#[inline]
pub fn require_program(a: &AccountView, id: &Address) -> Result<(), VaultError> {
    require_address(a, id)
}

/// An account about to be created: still system-owned and carrying no data.
///
/// Deliberately does *not* require a zero lamport balance. Anyone can send
/// lamports to a known PDA before it is initialized, and refusing to proceed
/// would let a stranger permanently block a tracker from ever being created
/// for the cost of one lamport. The creation path handles a prefunded account
/// instead of rejecting it.
#[inline]
pub fn require_uninitialized(a: &AccountView) -> Result<(), VaultError> {
    if !a.is_data_empty() {
        return Err(VaultError::InvalidAccountOwner);
    }
    require_owned_by(a, &SYSTEM_PROGRAM_ID)
}

/// `seeds = [..], bump = ..` — the account is at exactly the address those
/// seeds derive to under this program.
///
/// Takes the bump rather than searching for it: `create_program_address` is
/// one hash, `find_program_address` is up to 255 of them. Handlers pass the
/// bump the tracker recorded at initialization, which is the canonical one
/// because [`canonical_pda`] found it there.
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
#[inline]
pub fn require_pda(
    a: &AccountView,
    seeds: &[&[u8]],
    bump: u8,
    program_id: &Address,
) -> Result<(), VaultError> {
    let bump_seed = [bump];
    let mut all: [&[u8]; 4] = [&[], &[], &[], &[]];
    if seeds.len() > 3 {
        return Err(VaultError::SeedsMismatch);
    }
    all[..seeds.len()].copy_from_slice(seeds);
    all[seeds.len()] = &bump_seed;

    let derived = Address::create_program_address(&all[..seeds.len() + 1], program_id)
        .map_err(|_| VaultError::SeedsMismatch)?;

    if a.address() == &derived {
        Ok(())
    } else {
        Err(VaultError::SeedsMismatch)
    }
}

/// Find the canonical bump for a PDA.
///
/// Only used on initialization paths. Storing the canonical bump and checking
/// against it later is what stops a caller supplying a non-canonical bump to
/// stand up a *second* valid address for the same ticker.
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
#[inline]
pub fn canonical_pda(seeds: &[&[u8]], program_id: &Address) -> (Address, u8) {
    Address::find_program_address(seeds, program_id)
}
