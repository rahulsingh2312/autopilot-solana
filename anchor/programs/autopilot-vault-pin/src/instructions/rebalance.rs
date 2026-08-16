//! Publish a new target basket.
//!
//! Requires the **manager**, not the authority. This is the whole point of the
//! role split: repositioning a basket is what a creator does, and it must never
//! come with the ability to take anything out of the vault.
//!
//! # This records intent, it does not move anything
//!
//! Publishing new weights and actually trading the vault into them are separate
//! steps, deliberately in that order — `swap_leg` follows. Swapping first would
//! leave the vault holding something its published weights do not describe, and
//! there is a window either way; this is the direction where the published
//! basket is the promise and the holdings catch up to it.
//!
//! The account is sized for `max_legs` at initialization and never reallocated,
//! so a rebalance is a pure overwrite with no rent transfer and no way to
//! strand a vault mid-update.

use pinocchio::{AccountView, Address, ProgramResult};

use crate::error::VaultError;
use crate::state::{LegSpec, LEG_MINT, LEG_SPEC_SIZE, LEG_WEIGHT_BPS};

/// `leg_count: u8 || legs[leg_count]`, each leg being
/// `mint(32) || weight_bps(2, LE)`.
///
/// No feed ids: see [`LegSpec`] for why they travel separately, and
/// `TrackerMut::write_legs` for how existing ones are carried forward.
pub fn parse_legs(data: &[u8], out: &mut [LegSpec]) -> Result<usize, VaultError> {
    let Some((&count, rest)) = data.split_first() else {
        return Err(VaultError::MalformedInstructionData);
    };
    let count = count as usize;
    if count > out.len() {
        return Err(VaultError::TooManyLegs);
    }
    // Exact length, so a caller cannot smuggle a leg the weight validation
    // never saw, nor have a short buffer read as zero-mint legs.
    let expected = count
        .checked_mul(LEG_SPEC_SIZE)
        .ok_or(VaultError::MathOverflow)?;
    if rest.len() != expected {
        return Err(VaultError::MalformedInstructionData);
    }

    for (i, slot) in out.iter_mut().enumerate().take(count) {
        let off = i * LEG_SPEC_SIZE;
        let mut mint = [0u8; 32];
        mint.copy_from_slice(&rest[off + LEG_MINT..off + LEG_MINT + 32]);
        let weight_bps = u16::from_le_bytes([
            rest[off + LEG_WEIGHT_BPS],
            rest[off + LEG_WEIGHT_BPS + 1],
        ]);
        *slot = LegSpec { mint, weight_bps };
    }
    Ok(count)
}

#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
use {
    crate::accounts::*,
    crate::constants::*,
    crate::state::{Tracker, TrackerMut},
};

/// ```text
/// 0 manager  signer
/// 1 tracker  writable
/// ```
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
pub fn handle(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let mut legs = [LegSpec::untokenized(0); MAX_LEGS as usize];
    let count = parse_legs(data, &mut legs)?;

    let [manager, tracker_ai, ..] = accounts else {
        return Err(VaultError::RemainingAccountsMismatch.into());
    };
    require_signer(manager)?;
    require_writable(tracker_ai)?;
    require_owned_by(tracker_ai, program_id)?;

    {
        let d = tracker_ai.try_borrow()?;
        let tracker = Tracker::load(&d)?;
        require_pda(
            tracker_ai,
            &[TRACKER_SEED, tracker.ticker()],
            tracker.bump(),
            program_id,
        )?;
        if tracker.manager() != manager.address().to_bytes() {
            return Err(VaultError::NotManager.into());
        }
    }

    // `write_legs` validates the whole basket before writing a byte, so a
    // rejected rebalance leaves the previous one exactly as it was.
    let mut d = tracker_ai.try_borrow_mut()?;
    TrackerMut::load(&mut d)?.write_legs(&legs[..count])?;
    Ok(())
}

#[cfg(not(any(target_os = "solana", target_arch = "bpf", feature = "host-pda")))]
pub fn handle(_: &Address, _: &mut [AccountView], _: &[u8]) -> ProgramResult {
    Err(VaultError::NotImplemented.into())
}

/// `leg_index: u8 || feed_id: [u8; 32]`
pub fn parse_set_leg_feed(data: &[u8]) -> Result<(u8, [u8; 32]), VaultError> {
    if data.len() != 33 {
        return Err(VaultError::MalformedInstructionData);
    }
    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(&data[1..33]);
    Ok((data[0], feed_id))
}

/// Point one leg at its Pyth feed.
///
/// ```text
/// 0 manager  signer
/// 1 tracker  writable
/// ```
///
/// Separate from `rebalance` because feed ids and weights change on completely
/// different schedules — and because carrying both in one payload made a full
/// sixteen-leg basket too large to fit in a transaction.
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
pub fn handle_set_leg_feed(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    let (index, feed_id) = parse_set_leg_feed(data)?;

    let [manager, tracker_ai, ..] = accounts else {
        return Err(VaultError::RemainingAccountsMismatch.into());
    };
    require_signer(manager)?;
    require_writable(tracker_ai)?;
    require_owned_by(tracker_ai, program_id)?;

    {
        let d = tracker_ai.try_borrow()?;
        let tracker = Tracker::load(&d)?;
        require_pda(
            tracker_ai,
            &[TRACKER_SEED, tracker.ticker()],
            tracker.bump(),
            program_id,
        )?;
        if tracker.manager() != manager.address().to_bytes() {
            return Err(VaultError::NotManager.into());
        }
    }

    let mut d = tracker_ai.try_borrow_mut()?;
    TrackerMut::load(&mut d)?.set_leg_feed(index, &feed_id)?;
    Ok(())
}

#[cfg(not(any(target_os = "solana", target_arch = "bpf", feature = "host-pda")))]
pub fn handle_set_leg_feed(_: &Address, _: &mut [AccountView], _: &[u8]) -> ProgramResult {
    Err(VaultError::NotImplemented.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MAX_LEGS;

    fn encode(legs: &[LegSpec]) -> std::vec::Vec<u8> {
        let mut v = std::vec::Vec::new();
        v.push(legs.len() as u8);
        for l in legs {
            v.extend_from_slice(&l.mint);
            v.extend_from_slice(&l.weight_bps.to_le_bytes());
        }
        v
    }

    fn leg(seed: u8, weight_bps: u16) -> LegSpec {
        LegSpec {
            mint: [seed; 32],
            weight_bps,
        }
    }

    #[test]
    fn parses_a_basket() {
        let mut out = [LegSpec::untokenized(0); MAX_LEGS as usize];
        let data = encode(&[leg(1, 6_000), leg(2, 4_000)]);
        assert_eq!(parse_legs(&data, &mut out).unwrap(), 2);
        assert_eq!(out[0], leg(1, 6_000));
        assert_eq!(out[1], leg(2, 4_000));
    }

    #[test]
    fn rejects_a_count_that_overruns_the_buffer() {
        let mut out = [LegSpec::untokenized(0); MAX_LEGS as usize];
        let mut data = encode(&[leg(1, 10_000)]);
        data[0] = 3;
        assert_eq!(
            parse_legs(&data, &mut out).err(),
            Some(VaultError::MalformedInstructionData)
        );
    }

    #[test]
    fn rejects_trailing_bytes() {
        let mut out = [LegSpec::untokenized(0); MAX_LEGS as usize];
        let mut data = encode(&[leg(1, 10_000)]);
        data.push(0);
        assert_eq!(
            parse_legs(&data, &mut out).err(),
            Some(VaultError::MalformedInstructionData)
        );
    }

    #[test]
    fn rejects_more_legs_than_the_protocol_ceiling() {
        let mut out = [LegSpec::untokenized(0); MAX_LEGS as usize];
        let many: std::vec::Vec<LegSpec> = (0..17).map(|i| leg(i as u8, 1)).collect();
        let data = encode(&many);
        assert_eq!(parse_legs(&data, &mut out).err(), Some(VaultError::TooManyLegs));
    }

    /// The whole point of the 34-byte payload: a maximal basket has to fit in
    /// one transaction. Sixteen legs at 66 bytes was 1,058 bytes of data and
    /// blew the 1,232-byte limit once accounts and a signature were added.
    #[test]
    fn a_maximal_basket_fits_in_one_transaction() {
        let legs: std::vec::Vec<LegSpec> = (0..16)
            .map(|i| leg(i as u8, if i == 0 { 10_000 - 15 * 625 } else { 625 }))
            .collect();
        let data = encode(&legs);
        // 1 discriminator + 1 count + 16*34
        assert_eq!(data.len(), 1 + 16 * LEG_SPEC_SIZE);
        // Signature(64) + header(3) + blockhash(32) + 2 accounts(64) + this
        // payload, well inside 1232.
        assert!(data.len() + 1 + 163 < 1232, "must fit a transaction");
    }

    #[test]
    fn parses_a_set_leg_feed_payload() {
        let mut d = std::vec::Vec::new();
        d.push(3u8);
        d.extend_from_slice(&[9u8; 32]);
        assert_eq!(parse_set_leg_feed(&d).unwrap(), (3, [9u8; 32]));
        assert!(parse_set_leg_feed(&d[..32]).is_err());
        assert!(parse_set_leg_feed(&[]).is_err());
    }

    #[test]
    fn rejects_empty_instruction_data() {
        let mut out = [LegSpec::untokenized(0); MAX_LEGS as usize];
        assert_eq!(
            parse_legs(&[], &mut out).err(),
            Some(VaultError::MalformedInstructionData)
        );
    }
}
