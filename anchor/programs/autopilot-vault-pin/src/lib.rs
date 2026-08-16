//! Autopilot vault, Pinocchio port.
//!
//! Same product as `autopilot-vault`: one generic basket vault parameterized
//! by config, deposit SOL, receive a share token priced off vault NAV, burn it
//! back for SOL or for pro-rata delivery of the underlying tokenized equities.
//!
//! The reason this crate exists is size. The Anchor program is 444,376 bytes,
//! which is 3.09 SOL of rent on the program data account and ~90% of the whole
//! deployment's on-chain footprint. Measured, its two heaviest dependencies —
//! `mpl-token-metadata` and `pyth-solana-receiver-sdk` — account for only
//! 48,376 of those bytes; the framework is the rest. This crate targets
//! ~45 KB, or about 0.32 SOL.
//!
//! # What is deliberately not free here
//!
//! Anchor supplied account validation as a side effect of its macros:
//! discriminators, `has_one`, `seeds`/`bump`, `init` rent-exemption, owner and
//! signer checks, bounds-checked deserialization. None of that exists now, and
//! every one is a named Solana exploit class when it is missing. Each check is
//! written out by hand in the handler that needs it, and the differential test
//! suite runs identical scenarios against both programs asserting the same
//! resulting account state. **Nothing here is safe because the framework said
//! so; it is safe because a test says so.**
//!
//! # Two roles, not one
//!
//! The Anchor program has a single `authority` that can rebalance *and* sweep
//! the vault. That is fine while every tracker is ours and fatal the moment a
//! stranger launches one. The layout splits it:
//!
//! - `manager` — rebalance, swap, set token metadata.
//!   Full control over *what the basket holds*. This is what a creator gets.
//! - `authority` — fees, pause, emergency withdrawals, role changes, close.
//!   Everything that can reach holder funds. This stays with the deployer,
//!   ideally a multisig.
//!
//! A manager can reposition freely and still cannot take anything.

#![no_std]

#[cfg(test)]
extern crate std;

pub mod accounts;
pub mod constants;
pub mod create;
pub mod error;
pub mod instructions;
pub mod oracle;
pub mod spl;
pub mod state;
pub mod token22;

use error::VaultError;
use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

#[cfg(feature = "bpf-entrypoint")]
mod entrypoint {
    pinocchio::program_entrypoint!(super::process_instruction);
    // `no_std`, so the std panic hook is not available to hang this off.
    pinocchio::nostd_panic_handler!();
    // Every layout in `state` is fixed-size and read in place, so the program
    // never allocates. Declaring that leaves the 32 KB heap region untouched
    // and drops the bump allocator from the binary.
    pinocchio::no_allocator!();
}

/// Instruction discriminators.
///
/// One byte, not Anchor's 8-byte sighash. The frontend already hand-writes its
/// discriminators in `web/src/lib/vault/program.ts` rather than generating
/// them from an IDL, so this costs one table there and 7 bytes off every
/// instruction on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Instruction {
    InitializeTracker = 0,
    Deposit = 1,
    RedeemForSol = 2,
    RedeemInKind = 3,
    // --- manager ---
    Rebalance = 4,
    SwapLeg = 5,
    SetTokenMetadata = 6,
    // --- authority ---
    SetPaused = 7,
    SetFees = 8,
    EmergencyWithdrawSol = 9,
    EmergencyWithdrawToken = 10,
    SetAuthority = 11,
    SetManager = 12,
    CloseTracker = 13,
    /// Appended rather than slotted in beside `Rebalance`: inserting a variant
    /// renumbers every one after it, and these values are the wire format.
    SetLegFeed = 14,
}

impl Instruction {
    pub fn from_u8(v: u8) -> Result<Self, VaultError> {
        Ok(match v {
            0 => Self::InitializeTracker,
            1 => Self::Deposit,
            2 => Self::RedeemForSol,
            3 => Self::RedeemInKind,
            4 => Self::Rebalance,
            5 => Self::SwapLeg,
            6 => Self::SetTokenMetadata,
            7 => Self::SetPaused,
            8 => Self::SetFees,
            9 => Self::EmergencyWithdrawSol,
            10 => Self::EmergencyWithdrawToken,
            11 => Self::SetAuthority,
            12 => Self::SetManager,
            13 => Self::CloseTracker,
            14 => Self::SetLegFeed,
            _ => return Err(VaultError::UnknownInstruction),
        })
    }

    /// Which key must sign. Encoded as data next to the discriminator so the
    /// role split is legible in one place rather than spread across handlers
    /// where a missing check would be invisible.
    pub fn required_role(&self) -> Role {
        match self {
            Self::InitializeTracker => Role::Payer,
            Self::Deposit | Self::RedeemForSol | Self::RedeemInKind => Role::Anyone,

            Self::Rebalance | Self::SwapLeg | Self::SetTokenMetadata | Self::SetLegFeed => {
                Role::Manager
            }

            Self::SetPaused
            | Self::SetFees
            | Self::EmergencyWithdrawSol
            | Self::EmergencyWithdrawToken
            | Self::SetAuthority
            | Self::SetManager
            | Self::CloseTracker => Role::Authority,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// No privileged key; the instruction is open to any caller.
    Anyone,
    /// Whoever funds the new accounts.
    Payer,
    /// Can change what the basket holds, and nothing else.
    Manager,
    /// Can reach holder funds.
    Authority,
}

pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let (tag, payload) = instruction_data
        .split_first()
        .ok_or(ProgramError::from(VaultError::MalformedInstructionData))?;

    let ix = Instruction::from_u8(*tag).map_err(ProgramError::from)?;

    // Every discriminator now resolves to a handler. The `NotImplemented` arm
    // is kept as a compile-time reminder rather than deleted: adding a variant
    // to `Instruction` without wiring it must fail closed, never fall through
    // to something permissive.
    match ix {
        Instruction::InitializeTracker => {
            instructions::initialize_tracker::handle(program_id, accounts, payload)
        }
        Instruction::Deposit => instructions::deposit::handle(program_id, accounts, payload),
        Instruction::RedeemForSol => {
            instructions::redeem_for_sol::handle(program_id, accounts, payload)
        }
        Instruction::RedeemInKind => {
            instructions::redeem_in_kind::handle(program_id, accounts, payload)
        }
        Instruction::Rebalance => instructions::rebalance::handle(program_id, accounts, payload),
        Instruction::SetLegFeed => {
            instructions::rebalance::handle_set_leg_feed(program_id, accounts, payload)
        }
        Instruction::SwapLeg => instructions::swap_leg::handle(program_id, accounts, payload),
        Instruction::SetTokenMetadata => {
            instructions::set_token_metadata::handle(program_id, accounts, payload)
        }
        Instruction::SetPaused => {
            instructions::admin::handle_set_paused(program_id, accounts, payload)
        }
        Instruction::SetFees => instructions::admin::handle_set_fees(program_id, accounts, payload),
        Instruction::SetAuthority => {
            instructions::admin::handle_set_authority(program_id, accounts, payload)
        }
        Instruction::SetManager => {
            instructions::admin::handle_set_manager(program_id, accounts, payload)
        }
        Instruction::EmergencyWithdrawSol => {
            instructions::admin::handle_emergency_withdraw_sol(program_id, accounts, payload)
        }
        Instruction::EmergencyWithdrawToken => {
            instructions::admin::handle_emergency_withdraw_token(program_id, accounts, payload)
        }
        Instruction::CloseTracker => {
            instructions::admin::handle_close_tracker(program_id, accounts, payload)
        }
        #[allow(unreachable_patterns)]
        _ => Err(VaultError::NotImplemented.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminators_round_trip() {
        for v in 0u8..=14 {
            assert_eq!(Instruction::from_u8(v).unwrap() as u8, v);
        }
        assert_eq!(
            Instruction::from_u8(15),
            Err(VaultError::UnknownInstruction)
        );
    }

    /// The split is the whole reason creator-launched indexes can be safe, so
    /// assert it rather than trusting the `match` to stay right.
    #[test]
    fn only_the_authority_can_reach_funds() {
        for ix in [
            Instruction::EmergencyWithdrawSol,
            Instruction::EmergencyWithdrawToken,
            Instruction::SetAuthority,
            Instruction::SetManager,
            Instruction::CloseTracker,
            Instruction::SetFees,
            Instruction::SetPaused,
        ] {
            assert_eq!(ix.required_role(), Role::Authority, "{ix:?}");
        }
    }

    /// A manager may reposition the basket and must never be able to do more.
    #[test]
    fn a_manager_can_only_move_the_basket() {
        for ix in [
            Instruction::Rebalance,
            Instruction::SwapLeg,
            Instruction::SetTokenMetadata,
            Instruction::SetLegFeed,
        ] {
            assert_eq!(ix.required_role(), Role::Manager, "{ix:?}");
        }
    }

    /// Redemption must never require a privileged signer: a holder's exit
    /// cannot depend on us being available to co-sign it.
    #[test]
    fn redemption_is_permissionless() {
        assert_eq!(Instruction::RedeemForSol.required_role(), Role::Anyone);
        assert_eq!(Instruction::RedeemInKind.required_role(), Role::Anyone);
        assert_eq!(Instruction::Deposit.required_role(), Role::Anyone);
    }

    #[test]
    fn empty_instruction_data_is_rejected() {
        let id = Address::from([0u8; 32]);
        assert!(process_instruction(&id, &mut [], &[]).is_err());
    }
}
