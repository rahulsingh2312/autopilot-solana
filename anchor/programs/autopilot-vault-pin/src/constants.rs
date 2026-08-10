//! Seeds, bounds, and denominators.
//!
//! Deliberately identical in *meaning* to the Anchor program's `constants.rs`.
//! The differential test suite asserts both programs agree, so any divergence
//! here has to be an intentional one, written down.

/// Seed for the tracker config account. Namespaced by ticker, so one program
/// serves every tracker: the curated ones now, creator-launched ones later.
pub const TRACKER_SEED: &[u8] = b"tracker";

/// Seed for the SOL vault owned by a tracker.
pub const VAULT_SEED: &[u8] = b"vault";

/// Seed for the tracker's share mint (mbtSOL, icSOL, ...).
pub const SHARE_SEED: &[u8] = b"share";

/// Seed for a leg's valuation record: feed id, decimals, rebasing multiplier.
pub const LEG_ORACLE_SEED: &[u8] = b"leg_oracle";

/// Share tokens use the same precision as SOL, so NAV per token reads as a
/// plain ratio near 1.0 instead of a scaled integer.
pub const SHARE_DECIMALS: u8 = 9;

/// Hard ceiling on basket legs, independent of a tracker's own `max_legs`.
/// Sized for a 13F subset, not a whole index.
pub const MAX_LEGS: u8 = 16;

pub const MAX_TICKER_LEN: usize = 12;

/// Basket weights are basis points: 10_000 == 100%.
///
/// Separate from the fee denominator on purpose. These were one shared
/// constant until fees moved to ppm, and collapsing them again would silently
/// redefine a valid basket as one summing to 1,000,000. Keep them apart.
pub const WEIGHT_DENOMINATOR: u32 = 10_000;

/// Fees are parts per million: 1_000_000 == 100%, so one unit is 0.0001%.
/// Finer than basis points because a 0.001% fee is 10 ppm and cannot be
/// expressed in bps at all.
pub const FEE_DENOMINATOR: u64 = 1_000_000;

/// Fees are capped in the program, not just in the UI. A tracker cannot be
/// reconfigured into a 90% exit tax after people have deposited.
pub const MAX_FEE_PPM: u16 = 30_000;

/// Rent: lamports per byte for a two-year exemption, including the 128-byte
/// per-account storage overhead the runtime charges on top of the data length.
pub const LAMPORTS_PER_BYTE_EXEMPT: u64 = 6_960;
pub const ACCOUNT_STORAGE_OVERHEAD: u64 = 128;

/// Rent-exempt minimum for an account holding `data_len` bytes.
pub const fn rent_exempt_minimum(data_len: u64) -> u64 {
    (ACCOUNT_STORAGE_OVERHEAD + data_len) * LAMPORTS_PER_BYTE_EXEMPT
}
