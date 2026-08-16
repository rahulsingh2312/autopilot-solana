//! Token-2022 mint extensions, read straight off the mint.
//!
//! # Why this exists
//!
//! `ARCHITECTURE.md` calls the rebasing multiplier "the one trusted input":
//! Pyth publishes NVDA's price, but nobody publishes the factor converting an
//! NVDAx balance into NVDA shares, so a worker fetches it from Backed over HTTP
//! and pushes it into a `LegOracle` PDA.
//!
//! That is not true. xStocks are Token-2022 mints carrying the
//! **ScaledUiAmount** extension, and that extension *is* the rebasing
//! multiplier — authoritative, on-chain, and the same number the token program
//! itself uses to render UI amounts. It can be read directly.
//!
//! Reading it removes the worker from the trust path entirely. That is a strict
//! improvement even before considering staleness: the mint's multiplier cannot
//! be out of date, cannot diverge from what wallets display, and does not
//! depend on our keeper being alive. And it adds no new trust in Backed —
//! see [`permanent_delegate`] for why we are already fully exposed to them.
//!
//! # Layout
//!
//! ```text
//! 0    ..82   base Mint
//! 82   ..165  zero padding (so a Mint cannot be confused with an Account)
//! 165         account_type: 1 = Mint, 2 = Account
//! 166  ..      TLV entries: type u16 LE, length u16 LE, value[length]
//! ```
//!
//! Derived from `spl-token-2022-interface`'s `type_and_tlv_indices`:
//! `account_type_index = BASE_ACCOUNT_LENGTH(165) - Mint::SIZE_OF(82) = 83`
//! within the post-base slice, i.e. absolute 165, and TLV starts one byte later.

use crate::error::VaultError;

/// `ExtensionType` discriminants, in `spl-token-2022`'s declaration order.
pub const EXT_TRANSFER_FEE_CONFIG: u16 = 1;
pub const EXT_PERMANENT_DELEGATE: u16 = 12;
pub const EXT_TRANSFER_HOOK: u16 = 14;
pub const EXT_SCALED_UI_AMOUNT: u16 = 25;
pub const EXT_PAUSABLE: u16 = 26;

const ACCOUNT_TYPE_INDEX: usize = 165;
const TLV_START: usize = 166;
const ACCOUNT_TYPE_MINT: u8 = 1;

/// Fixed-point scale of the multiplier this program works in.
const MULTIPLIER_SCALE: f64 = 1_000_000.0;

/// Sanity band, matching the bound the Anchor program applied to the pushed
/// value. A corporate action can rebase a token a long way, but not a
/// hundredfold in either direction — and a multiplier outside this range is far
/// more likely to be a misread than a real split.
const MIN_MULTIPLIER_MICROS: u64 = 10_000; // 0.01x
const MAX_MULTIPLIER_MICROS: u64 = 100_000_000; // 100x

/// Find one TLV extension's value inside a Token-2022 **mint**.
///
/// Returns `None` when the account has no extensions, is not a mint, or simply
/// does not carry this extension — all three are ordinary, not errors.
pub fn find_mint_extension(data: &[u8], ext_type: u16) -> Option<&[u8]> {
    if data.len() <= TLV_START || data[ACCOUNT_TYPE_INDEX] != ACCOUNT_TYPE_MINT {
        return None;
    }

    let mut offset = TLV_START;
    while offset + 4 <= data.len() {
        let ty = u16::from_le_bytes([data[offset], data[offset + 1]]);
        let len = u16::from_le_bytes([data[offset + 2], data[offset + 3]]) as usize;

        // `Uninitialized` marks the end of the written entries; everything
        // after it is allocated-but-unused space.
        if ty == 0 {
            return None;
        }

        let value_start = offset + 4;
        let value_end = value_start.checked_add(len)?;
        if value_end > data.len() {
            // A truncated final entry. Refuse to read past it rather than
            // returning a short slice a caller might index into.
            return None;
        }
        if ty == ext_type {
            return Some(&data[value_start..value_end]);
        }
        offset = value_end;
    }
    None
}

/// True if this mint carries a permanent delegate.
///
/// # What this means, and why it is checked
///
/// A permanent delegate can transfer or burn **any** amount from **any** token
/// account holding the mint, with no signature from the account owner. For a
/// vault, that means the issuer can remove the entire tokenized holding at
/// will. It is not an exploit; it is the extension working as designed.
///
/// xStocks carry one. So the vault's NAV is, and always has been, contingent on
/// Backed choosing not to exercise it — a larger counterparty risk than
/// anything else in this program, including `emergency_withdraw`, which is
/// already disclosed. This function exists so that fact can be surfaced rather
/// than assumed, and so a future `add_leg` path can refuse an unknown delegate.
pub fn has_permanent_delegate(mint_data: &[u8]) -> bool {
    find_mint_extension(mint_data, EXT_PERMANENT_DELEGATE).is_some()
}

/// True if this mint charges a transfer fee.
///
/// Any path that moves a fee-bearing token needs delta-aware accounting — the
/// receiver gets less than was sent, so a pro-rata payout computed before the
/// transfer overstates what actually arrives. `swap_leg` already brackets its
/// CPI with balance reads and is safe; `redeem_in_kind` computes and then
/// transfers, so it must consult this.
pub fn has_transfer_fee(mint_data: &[u8]) -> bool {
    find_mint_extension(mint_data, EXT_TRANSFER_FEE_CONFIG).is_some()
}

/// The rebasing multiplier, scaled by 1e6, read from the mint.
///
/// ```text
/// ScaledUiAmountConfig
/// 0  ..32  authority (OptionalNonZeroPubkey)
/// 32 ..40  multiplier                        (f64 LE)
/// 40 ..48  new_multiplier_effective_timestamp (i64 LE)
/// 48 ..56  new_multiplier                    (f64 LE)
/// ```
///
/// The extension schedules changes: once `now` reaches the effective timestamp
/// the new multiplier applies. Matching that switch exactly is what keeps this
/// program's valuation equal to what every wallet displays across a corporate
/// action — reading only `multiplier` would silently misprice the vault from
/// the moment a split is scheduled until someone noticed.
///
/// Returns `None` when the mint has no such extension, which is the normal case
/// for an ordinary SPL mint.
pub fn scaled_ui_multiplier_micros(mint_data: &[u8], now: i64) -> Option<Result<u64, VaultError>> {
    let cfg = find_mint_extension(mint_data, EXT_SCALED_UI_AMOUNT)?;
    if cfg.len() < 56 {
        return Some(Err(VaultError::AccountTooSmall));
    }

    let effective_at = i64::from_le_bytes(cfg[40..48].try_into().ok()?);
    let raw = if now >= effective_at {
        f64::from_le_bytes(cfg[48..56].try_into().ok()?)
    } else {
        f64::from_le_bytes(cfg[32..40].try_into().ok()?)
    };

    Some(to_micros(raw))
}

/// Convert the extension's `f64` into this program's fixed-point micros.
///
/// Floating point is confined to exactly this function. Everything downstream —
/// every lamport of NAV — is integer math, because a float in the money path is
/// a rounding argument nobody wins. The bounds are checked *after* conversion so
/// that NaN and infinity, which compare false against everything, cannot slip
/// through a range test.
fn to_micros(raw: f64) -> Result<u64, VaultError> {
    if !raw.is_finite() || raw <= 0.0 {
        return Err(VaultError::MultiplierOutOfRange);
    }
    let scaled = raw * MULTIPLIER_SCALE;
    if !scaled.is_finite() {
        return Err(VaultError::MultiplierOutOfRange);
    }
    // Saturating since Rust 1.45, so this cannot wrap; the band check below is
    // what actually rejects an implausible value.
    let micros = scaled as u64;
    if !(MIN_MULTIPLIER_MICROS..=MAX_MULTIPLIER_MICROS).contains(&micros) {
        return Err(VaultError::MultiplierOutOfRange);
    }
    Ok(micros)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec;
    use std::vec::Vec;

    /// Build a Token-2022 mint account carrying the given TLV entries.
    fn mint_with(entries: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut v = vec![0u8; TLV_START];
        v[ACCOUNT_TYPE_INDEX] = ACCOUNT_TYPE_MINT;
        for (ty, value) in entries {
            v.extend_from_slice(&ty.to_le_bytes());
            v.extend_from_slice(&(value.len() as u16).to_le_bytes());
            v.extend_from_slice(value);
        }
        v
    }

    fn scaled_cfg(multiplier: f64, effective_at: i64, new_multiplier: f64) -> Vec<u8> {
        let mut v = vec![0u8; 32]; // authority
        v.extend_from_slice(&multiplier.to_le_bytes());
        v.extend_from_slice(&effective_at.to_le_bytes());
        v.extend_from_slice(&new_multiplier.to_le_bytes());
        v
    }

    #[test]
    fn reads_a_plain_multiplier() {
        let data = mint_with(&[(EXT_SCALED_UI_AMOUNT, scaled_cfg(1.0, i64::MAX, 4.0))]);
        assert_eq!(
            scaled_ui_multiplier_micros(&data, 1_000).unwrap().unwrap(),
            1_000_000
        );
    }

    /// A scheduled 4:1 split: before the effective timestamp the old multiplier
    /// applies, from it onward the new one. Getting this wrong misprices the
    /// vault by 4x across the boundary.
    #[test]
    fn honours_a_scheduled_multiplier_change() {
        let data = mint_with(&[(EXT_SCALED_UI_AMOUNT, scaled_cfg(1.0, 5_000, 4.0))]);
        assert_eq!(
            scaled_ui_multiplier_micros(&data, 4_999).unwrap().unwrap(),
            1_000_000,
            "before the switch"
        );
        assert_eq!(
            scaled_ui_multiplier_micros(&data, 5_000).unwrap().unwrap(),
            4_000_000,
            "at the switch"
        );
    }

    #[test]
    fn finds_an_extension_after_others() {
        let data = mint_with(&[
            (EXT_PERMANENT_DELEGATE, vec![9u8; 32]),
            (EXT_PAUSABLE, vec![0u8; 1]),
            (EXT_SCALED_UI_AMOUNT, scaled_cfg(2.5, i64::MAX, 1.0)),
        ]);
        assert_eq!(
            scaled_ui_multiplier_micros(&data, 0).unwrap().unwrap(),
            2_500_000
        );
        assert!(has_permanent_delegate(&data));
        assert!(!has_transfer_fee(&data));
    }

    /// The property that matters for the risk page: an xStock-shaped mint is
    /// detectably seizable by its issuer, on chain, without asking anyone.
    #[test]
    fn detects_the_permanent_delegate_an_xstock_carries() {
        let xstock = mint_with(&[
            (EXT_PERMANENT_DELEGATE, vec![7u8; 32]),
            (EXT_PAUSABLE, vec![0u8; 1]),
            (EXT_SCALED_UI_AMOUNT, scaled_cfg(1.0, i64::MAX, 1.0)),
        ]);
        assert!(has_permanent_delegate(&xstock));

        let plain = mint_with(&[]);
        assert!(!has_permanent_delegate(&plain));
    }

    #[test]
    fn a_mint_without_the_extension_reads_as_absent() {
        let data = mint_with(&[(EXT_PERMANENT_DELEGATE, vec![9u8; 32])]);
        assert!(scaled_ui_multiplier_micros(&data, 0).is_none());
    }

    /// A classic SPL mint is 82 bytes with no TLV region at all.
    #[test]
    fn a_classic_spl_mint_reads_as_absent() {
        let data = vec![0u8; 82];
        assert!(scaled_ui_multiplier_micros(&data, 0).is_none());
        assert!(!has_permanent_delegate(&data));
    }

    /// A token *account* must never be parsed as a mint: byte 165 says which.
    #[test]
    fn refuses_to_read_extensions_off_a_token_account() {
        let mut data = mint_with(&[(EXT_SCALED_UI_AMOUNT, scaled_cfg(1.0, i64::MAX, 1.0))]);
        data[ACCOUNT_TYPE_INDEX] = 2; // Account
        assert!(scaled_ui_multiplier_micros(&data, 0).is_none());
    }

    /// NaN and infinity compare false against every bound, so they have to be
    /// rejected explicitly rather than by a range test.
    #[test]
    fn rejects_nan_and_infinity() {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, 0.0] {
            let data = mint_with(&[(EXT_SCALED_UI_AMOUNT, scaled_cfg(bad, i64::MAX, bad))]);
            assert_eq!(
                scaled_ui_multiplier_micros(&data, 0).unwrap().err(),
                Some(VaultError::MultiplierOutOfRange),
                "{bad}"
            );
        }
    }

    #[test]
    fn rejects_a_multiplier_outside_the_sanity_band() {
        for bad in [0.001, 1_000.0] {
            let data = mint_with(&[(EXT_SCALED_UI_AMOUNT, scaled_cfg(bad, i64::MAX, bad))]);
            assert_eq!(
                scaled_ui_multiplier_micros(&data, 0).unwrap().err(),
                Some(VaultError::MultiplierOutOfRange),
                "{bad}"
            );
        }
        // and the edges are inclusive
        for ok in [0.01, 100.0] {
            let data = mint_with(&[(EXT_SCALED_UI_AMOUNT, scaled_cfg(ok, i64::MAX, ok))]);
            assert!(scaled_ui_multiplier_micros(&data, 0).unwrap().is_ok(), "{ok}");
        }
    }

    /// A truncated final entry must not yield a short slice a caller indexes
    /// into, and must not loop forever.
    #[test]
    fn rejects_a_truncated_tlv_entry() {
        let mut data = mint_with(&[(EXT_SCALED_UI_AMOUNT, scaled_cfg(1.0, i64::MAX, 1.0))]);
        data.truncate(data.len() - 8);
        assert!(scaled_ui_multiplier_micros(&data, 0).is_none());
    }

    /// A zero-length entry must still advance the cursor, or the walk spins.
    #[test]
    fn a_zero_length_entry_does_not_hang_the_walk() {
        let data = mint_with(&[
            (EXT_PAUSABLE, vec![]),
            (EXT_SCALED_UI_AMOUNT, scaled_cfg(1.0, i64::MAX, 1.0)),
        ]);
        assert_eq!(
            scaled_ui_multiplier_micros(&data, 0).unwrap().unwrap(),
            1_000_000
        );
    }
}
