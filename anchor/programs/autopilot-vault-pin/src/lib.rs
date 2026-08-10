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
//! - `manager` — rebalance, swap, push multipliers, set token metadata.
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
pub mod error;
pub mod instructions;
pub mod state;

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
    PushMultiplier = 6,
    SetTokenMetadata = 7,
    // --- authority ---
    SetPaused = 8,
    SetFees = 9,
    EmergencyWithdrawSol = 10,
    EmergencyWithdrawToken = 11,
    SetAuthority = 12,
    SetManager = 13,
    CloseTracker = 14,
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
            6 => Self::PushMultiplier,
            7 => Self::SetTokenMetadata,
            8 => Self::SetPaused,
            9 => Self::SetFees,
            10 => Self::EmergencyWithdrawSol,
            11 => Self::EmergencyWithdrawToken,
            12 => Self::SetAuthority,
            13 => Self::SetManager,
            14 => Self::CloseTracker,
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

            Self::Rebalance | Self::SwapLeg | Self::PushMultiplier | Self::SetTokenMetadata => {
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

    // Remaining handlers land one at a time, each with its account checks
    // written out and a differential test against the Anchor program before
    // the next one starts. Failing closed until then is the point: an
    // unimplemented handler must never be a permissive one.
    match ix {
        Instruction::InitializeTracker => {
            instructions::initialize_tracker::handle(program_id, accounts, payload)
        }
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
            Instruction::PushMultiplier,
            Instruction::SetTokenMetadata,
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
