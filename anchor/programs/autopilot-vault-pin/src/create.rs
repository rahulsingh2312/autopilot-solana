//! Creating a PDA that a stranger may have already sent lamports to.
//!
//! # Why this is not one instruction
//!
//! The System program's plain `CreateAccount` fails if the target already
//! holds lamports. Every PDA address in this program is derivable by anyone
//! from public data — the ticker is right there in the frontend — so anyone
//! can send one lamport to a tracker's address before it is created and
//! permanently prevent that ticker from ever existing. For one lamport.
//!
//! `CreateAccountAllowPrefund` (System instruction 13) exists to solve exactly
//! this and `pinocchio-system` exposes it, but **the Agave runtime does not
//! implement it**: `solana-system-program` 3.1.14 handles instructions 0..=12
//! and rejects 13 as malformed instruction data. The differential suite caught
//! this on its first run against the real binary. Reaching for it again later
//! will look like an obvious simplification, so: it is not available, and the
//! failure mode is a mainnet `initialize_tracker` that cannot succeed at all.
//!
//! # What replaces it
//!
//! The three-step form the runtime does support, which is what Anchor's
//! `init` expands to for the same reason:
//!
//! 1. `Transfer` the shortfall from the payer, if the account is short of
//!    rent exemption. Skipped entirely when the prefund already covers it.
//! 2. `Allocate` the space, signed by the PDA's seeds.
//! 3. `Assign` ownership to this program, signed by the same seeds.
//!
//! A prefunded account is therefore *adopted* rather than rejected, and the
//! griefing vector stays closed. The un-prefunded path still uses plain
//! `CreateAccount`, because one CPI beats three when the balance is zero.

use pinocchio::cpi::Signer;
use pinocchio::{AccountView, Address, ProgramResult};
use pinocchio_system::instructions::{Allocate, Assign, CreateAccount, Transfer};

use crate::constants::rent_exempt_minimum;

/// Create `target` at `space` bytes owned by `owner`, funded by `payer`.
///
/// `signers` must carry the target PDA's seeds: `Allocate` and `Assign` both
/// require the account itself to sign, which for a PDA means seed signing.
///
/// Callers must have established that `target` is currently system-owned and
/// data-empty — [`crate::accounts::require_uninitialized`] — before calling.
/// Without that check this would happily re-allocate a live account.
pub fn create_pda_account(
    payer: &AccountView,
    target: &AccountView,
    space: u64,
    owner: &Address,
    signers: &[Signer],
) -> ProgramResult {
    let required = rent_exempt_minimum(space);
    let current = target.lamports();

    // Fast path: nobody has touched it, so one CPI does the whole job.
    if current == 0 {
        return CreateAccount {
            from: payer,
            to: target,
            lamports: required,
            space,
            owner,
        }
        .invoke_signed(signers);
    }

    // Adopt path. Top up only the shortfall — an account prefunded *above*
    // rent exemption keeps the excess, which is correct: those lamports belong
    // to the account now, and for the vault they are counted as depositor
    // assets rather than quietly pocketed.
    if let Some(shortfall) = required.checked_sub(current).filter(|s| *s > 0) {
        Transfer {
            from: payer,
            to: target,
            lamports: shortfall,
        }
        .invoke()?;
    }

    Allocate {
        account: target,
        space,
    }
    .invoke_signed(signers)?;

    Assign {
        account: target,
        owner,
    }
    .invoke_signed(signers)?;

    Ok(())
}
