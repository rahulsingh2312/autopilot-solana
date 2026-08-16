//! Create a tracker: its config account, its share mint, and its vault.
//!
//! Ported from `autopilot-vault/src/instructions/initialize_tracker.rs`. Three
//! deliberate differences from the Anchor original, all of them narrowing:
//!
//! - **`name`, `rebalance_interval` and `filing_delay_days` are gone.** All
//!   three were written once and read by nothing. The name already lives in
//!   the Metaplex metadata account.
//! - **`max_legs` is a new argument.** The account is sized for it once and
//!   never reallocated.
//! - **The payer becomes both `authority` and `manager`.** Splitting them is a
//!   separate `set_manager` call, so a creator flow can hand the manager role
//!   to a stranger without ever handing over the authority.

use pinocchio::{AccountView, Address, ProgramResult};

use crate::constants::*;
use crate::error::VaultError;
use crate::state::{LegSpec, LEG_MINT, LEG_SPEC_SIZE, LEG_WEIGHT_BPS};

/// Imports the on-chain handler needs and the host stub does not.
///
/// Scoped rather than module-level because the handler below is compiled out
/// on a host build without `host-pda`, and unused-import warnings there would
/// bury the ones that mean something.
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
use {
    crate::accounts::*,
    crate::create::create_pda_account,
    crate::state::{tracker_size, validate_legs, TrackerMut},
    pinocchio::cpi::{Seed, Signer},
    pinocchio_system::instructions::Transfer,
    pinocchio_token::instructions::InitializeMint2,
};

/// Instruction payload, laid out after the one-byte discriminator.
///
/// Fixed-width and read in place. The Anchor version used borsh with a
/// `String` and a `Vec<BasketLeg>`, which needs an allocator; this program
/// declares `no_allocator!`.
///
/// ```text
/// off  size        field
/// 0    1           strategy
/// 1    1           max_legs
/// 2    2           deposit_fee_ppm   (LE)
/// 4    2           redeem_fee_ppm    (LE)
/// 6    1           ticker_len
/// 7    12          ticker            (zero-padded)
/// 19   1           leg_count
/// 20   n*34        legs              (mint || weight_bps LE)
/// ```
pub const ARGS_HEADER_LEN: usize = 20;

pub struct Args<'a> {
    pub strategy: u8,
    pub max_legs: u8,
    pub deposit_fee_ppm: u16,
    pub redeem_fee_ppm: u16,
    pub ticker: &'a [u8],
    pub leg_count: u8,
    legs: &'a [u8],
}

impl<'a> Args<'a> {
    pub fn parse(data: &'a [u8]) -> Result<Self, VaultError> {
        if data.len() < ARGS_HEADER_LEN {
            return Err(VaultError::MalformedInstructionData);
        }
        let ticker_len = data[6] as usize;
        if ticker_len == 0 || ticker_len > MAX_TICKER_LEN {
            return Err(VaultError::InvalidTicker);
        }
        let leg_count = data[19];
        let legs_len = (leg_count as usize)
            .checked_mul(LEG_SPEC_SIZE)
            .ok_or(VaultError::MathOverflow)?;
        // The declared leg count must match the bytes actually supplied, or a
        // short buffer would be read as a basket of zero-mint legs.
        if data.len() != ARGS_HEADER_LEN + legs_len {
            return Err(VaultError::MalformedInstructionData);
        }

        Ok(Self {
            strategy: data[0],
            max_legs: data[1],
            deposit_fee_ppm: u16::from_le_bytes([data[2], data[3]]),
            redeem_fee_ppm: u16::from_le_bytes([data[4], data[5]]),
            ticker: &data[7..7 + ticker_len],
            leg_count,
            legs: &data[ARGS_HEADER_LEN..],
        })
    }

    pub fn leg(&self, i: u8) -> Option<LegSpec> {
        if i >= self.leg_count {
            return None;
        }
        let off = (i as usize) * LEG_SPEC_SIZE;
        let mut mint = [0u8; 32];
        mint.copy_from_slice(&self.legs[off + LEG_MINT..off + LEG_MINT + 32]);
        let weight_bps = u16::from_le_bytes([
            self.legs[off + LEG_WEIGHT_BPS],
            self.legs[off + LEG_WEIGHT_BPS + 1],
        ]);
        Some(LegSpec { mint, weight_bps })
    }
}

/// ```text
/// 0 payer           signer, writable — funds every account, becomes authority + manager
/// 1 fee_recipient   readonly        — stored only; never read or written here
/// 2 tracker         writable        — PDA ["tracker", ticker], created
/// 3 share_mint      writable        — PDA ["share", tracker], created
/// 4 vault           writable        — PDA ["vault", tracker], funded to rent exemption
/// 5 system_program
/// 6 token_program
/// ```
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
pub fn handle(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    let args = Args::parse(data)?;

    // ---- argument validation, before anything is created ----
    if args.deposit_fee_ppm > MAX_FEE_PPM || args.redeem_fee_ppm > MAX_FEE_PPM {
        return Err(VaultError::FeeTooHigh.into());
    }
    if args.max_legs == 0 || args.max_legs > MAX_LEGS {
        return Err(VaultError::InvalidMaxLegs.into());
    }
    if args.leg_count > args.max_legs {
        return Err(VaultError::LegCapacityExceeded.into());
    }

    // Materialize the basket into a fixed array — no allocator here — so the
    // weights can be checked as a whole before a single account is created.
    let mut legs = [LegSpec::untokenized(0); MAX_LEGS as usize];
    for i in 0..args.leg_count {
        legs[i as usize] = args.leg(i).ok_or(VaultError::MalformedInstructionData)?;
    }
    validate_legs(&legs[..args.leg_count as usize])?;

    let [payer, fee_recipient, tracker_ai, share_mint_ai, vault_ai, system_program, token_program, ..] =
        accounts
    else {
        return Err(VaultError::RemainingAccountsMismatch.into());
    };

    // ---- account validation ----
    require_signer(payer)?;
    require_writable(payer)?;
    require_writable(tracker_ai)?;
    require_writable(share_mint_ai)?;
    require_writable(vault_ai)?;
    require_program(system_program, &SYSTEM_PROGRAM_ID)?;
    require_program(token_program, &TOKEN_PROGRAM_ID)?;

    // All three are about to be created or funded, so none may already exist.
    require_uninitialized(tracker_ai)?;
    require_uninitialized(share_mint_ai)?;

    // Canonical bumps, found rather than accepted from the caller: a
    // non-canonical bump derives a *different* valid address, which would let
    // a second tracker be stood up for the same ticker.
    let (tracker_key, tracker_bump) =
        canonical_pda(&[TRACKER_SEED, args.ticker], program_id);
    require_address(tracker_ai, &tracker_key)?;

    let (mint_key, mint_bump) =
        canonical_pda(&[SHARE_SEED, tracker_key.as_ref()], program_id);
    require_address(share_mint_ai, &mint_key)?;

    let (vault_key, vault_bump) =
        canonical_pda(&[VAULT_SEED, tracker_key.as_ref()], program_id);
    require_address(vault_ai, &vault_key)?;

    let fee_recipient_key = fee_recipient.address().to_bytes();
    let payer_key = payer.address().to_bytes();

    // ---- create the tracker account ----
    let space = tracker_size(args.max_legs);
    let tracker_bump_seed = [tracker_bump];
    let tracker_seeds = [
        Seed::from(TRACKER_SEED),
        Seed::from(args.ticker),
        Seed::from(&tracker_bump_seed[..]),
    ];

    // Tolerates a prefunded address rather than failing on one: anyone can send
    // a lamport to a known PDA before it is initialized, and rejecting that
    // would let a stranger block a ticker forever for one lamport. See
    // `create::create_pda_account` for why this is three CPIs and not one.
    create_pda_account(
        payer,
        tracker_ai,
        space as u64,
        program_id,
        &[Signer::from(&tracker_seeds)],
    )?;

    // ---- create and initialize the share mint ----
    let mint_space = pinocchio_token::state::Mint::LEN;
    let mint_bump_seed = [mint_bump];
    let tracker_key_bytes = tracker_key.to_bytes();
    let mint_seeds = [
        Seed::from(SHARE_SEED),
        Seed::from(&tracker_key_bytes[..]),
        Seed::from(&mint_bump_seed[..]),
    ];

    create_pda_account(
        payer,
        share_mint_ai,
        mint_space as u64,
        &TOKEN_PROGRAM_ID,
        &[Signer::from(&mint_seeds)],
    )?;

    // Mint authority is the tracker PDA, so only this program can change the
    // share supply. Freeze authority is left unset on purpose: nobody,
    // including us, can ever freeze a holder's tokens.
    InitializeMint2::new(
        share_mint_ai,
        SHARE_DECIMALS,
        &tracker_key,
        // Left unset on purpose: nobody, including us, can freeze a holder.
        None,
    )
    .invoke()?;

    // ---- fund the vault to rent exemption ----
    //
    // Recorded as `rent_reserve` and excluded from net assets, so depositor
    // NAV is never inflated by the reserve sitting underneath it.
    let rent_reserve = rent_exempt_minimum(0);
    Transfer {
        from: payer,
        to: vault_ai,
        lamports: rent_reserve,
    }
    .invoke()?;

    // ---- write the tracker ----
    let mut data = tracker_ai.try_borrow_mut()?;
    let mut tracker = TrackerMut::initialize(
        &mut data,
        args.strategy,
        args.max_legs,
        args.ticker,
        tracker_bump,
        vault_bump,
        mint_bump,
    )?;

    // The payer holds both roles at creation. `set_manager` is what hands the
    // basket to someone else while the vault stays with us.
    tracker.set_authority(&payer_key);
    tracker.set_manager(&payer_key);
    tracker.set_share_mint(&mint_key.to_bytes());
    tracker.set_fee_recipient(&fee_recipient_key);
    tracker.set_rent_reserve(rent_reserve);
    tracker.set_fees(args.deposit_fee_ppm, args.redeem_fee_ppm)?;
    tracker.write_legs(&legs[..args.leg_count as usize])?;

    Ok(())
}

/// Host builds without `host-pda` cannot derive addresses, so the handler is
/// absent rather than half-checked. The SBF build always has the syscalls.
#[cfg(not(any(target_os = "solana", target_arch = "bpf", feature = "host-pda")))]
pub fn handle(_: &Address, _: &mut [AccountView], _: &[u8]) -> ProgramResult {
    Err(VaultError::NotImplemented.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(ticker: &[u8], max_legs: u8, legs: &[LegSpec]) -> std::vec::Vec<u8> {
        let mut v = std::vec::Vec::new();
        v.resize(ARGS_HEADER_LEN, 0u8);
        v[0] = 0; // strategy
        v[1] = max_legs;
        v[2..4].copy_from_slice(&10u16.to_le_bytes());
        v[4..6].copy_from_slice(&10u16.to_le_bytes());
        v[6] = ticker.len() as u8;
        v[7..7 + ticker.len()].copy_from_slice(ticker);
        v[19] = legs.len() as u8;
        for l in legs {
            v.extend_from_slice(&l.mint);
            v.extend_from_slice(&l.weight_bps.to_le_bytes());
        }
        v
    }

    #[test]
    fn parses_a_well_formed_payload() {
        let data = encode(b"bwSOL", 8, &[LegSpec { mint: [1u8; 32], weight_bps: 6000 }, LegSpec { mint: [2u8; 32], weight_bps: 4000 }]);
        let a = Args::parse(&data).unwrap();
        assert_eq!(a.ticker, b"bwSOL");
        assert_eq!(a.max_legs, 8);
        assert_eq!(a.leg_count, 2);
        assert_eq!(a.deposit_fee_ppm, 10);
        assert_eq!(a.leg(0), Some(LegSpec { mint: [1u8; 32], weight_bps: 6000 }));
        assert_eq!(a.leg(1), Some(LegSpec { mint: [2u8; 32], weight_bps: 4000 }));
        assert_eq!(a.leg(2), None);
    }

    /// A declared leg count larger than the bytes supplied must be rejected,
    /// not read as a basket padded with zero-mint legs.
    #[test]
    fn rejects_a_leg_count_that_overruns_the_buffer() {
        let mut data = encode(b"bwSOL", 8, &[LegSpec { mint: [1u8; 32], weight_bps: 10_000 }]);
        data[19] = 4;
        assert_eq!(
            Args::parse(&data).err(),
            Some(VaultError::MalformedInstructionData)
        );
    }

    /// Trailing bytes are rejected too: an exact-length check means a caller
    /// cannot smuggle a leg the weight validation never saw.
    #[test]
    fn rejects_trailing_bytes() {
        let mut data = encode(b"bwSOL", 8, &[LegSpec { mint: [1u8; 32], weight_bps: 10_000 }]);
        data.push(0);
        assert_eq!(
            Args::parse(&data).err(),
            Some(VaultError::MalformedInstructionData)
        );
    }

    #[test]
    fn rejects_a_bad_ticker() {
        let mut data = encode(b"bwSOL", 8, &[LegSpec { mint: [1u8; 32], weight_bps: 10_000 }]);
        data[6] = 0;
        assert_eq!(Args::parse(&data).err(), Some(VaultError::InvalidTicker));
        data[6] = (MAX_TICKER_LEN + 1) as u8;
        assert_eq!(Args::parse(&data).err(), Some(VaultError::InvalidTicker));
    }

    #[test]
    fn rejects_a_truncated_header() {
        let data = [0u8; ARGS_HEADER_LEN - 1];
        assert_eq!(
            Args::parse(&data).err(),
            Some(VaultError::MalformedInstructionData)
        );
    }
}
