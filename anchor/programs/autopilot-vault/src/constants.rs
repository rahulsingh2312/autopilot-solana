use anchor_lang::prelude::*;

/// Seed for the tracker config account. Namespaced by ticker, so one program
/// serves every tracker: the curated ones now, creator-launched ones later.
#[constant]
pub const TRACKER_SEED: &[u8] = b"tracker";

/// Seed for the SOL vault owned by a tracker.
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// Seed for the tracker's share mint (mbtSOL, icSOL, ...).
#[constant]
pub const SHARE_SEED: &[u8] = b"share";

/// Share tokens use the same precision as SOL, so NAV per token reads as a
/// plain ratio near 1.0 instead of a scaled integer.
pub const SHARE_DECIMALS: u8 = 9;

/// Upper bound on basket legs. Sized for a 13F subset, not a whole index.
pub const MAX_LEGS: usize = 16;

pub const MAX_TICKER_LEN: usize = 12;
pub const MAX_NAME_LEN: usize = 48;
pub const MAX_SYMBOL_LEN: usize = 12;

/// Basket weights are basis points: 10_000 == 100%. Separate from the fee
/// denominator on purpose, because the two were sharing a constant and a fee
/// precision change silently redefined what a valid basket was.
pub const WEIGHT_DENOMINATOR: u32 = 10_000;

/// Fees are parts per million: 1_000_000 == 100%, so one unit is 0.0001%.
/// Finer than basis points because a 0.001% fee is 10 ppm and cannot be
/// expressed in bps at all.
pub const FEE_DENOMINATOR: u64 = 1_000_000;

/// Fees are capped in the program, not just in the UI. A tracker cannot be
/// reconfigured into a 90% exit tax after people have deposited. 30_000 ppm
/// is 3%, and fits u16 so the account layout is unchanged.
pub const MAX_FEE_PPM: u16 = 30_000;
