use anchor_lang::prelude::*;

#[event]
pub struct TrackerInitialized {
    pub tracker: Pubkey,
    pub ticker: String,
    pub share_mint: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct Deposited {
    pub tracker: Pubkey,
    pub depositor: Pubkey,
    pub lamports_in: u64,
    pub fee_lamports: u64,
    pub shares_out: u64,
    pub supply_after: u64,
    pub net_assets_after: u64,
}

#[event]
pub struct RedeemedForSol {
    pub tracker: Pubkey,
    pub holder: Pubkey,
    pub shares_in: u64,
    pub fee_lamports: u64,
    pub lamports_out: u64,
    pub supply_after: u64,
    pub net_assets_after: u64,
}

#[event]
pub struct RedeemedInKind {
    pub tracker: Pubkey,
    pub holder: Pubkey,
    pub shares_in: u64,
    pub lamports_out: u64,
    pub legs_delivered: u8,
    pub supply_after: u64,
}

#[event]
pub struct Rebalanced {
    pub tracker: Pubkey,
    pub rebalance_count: u32,
    pub timestamp: i64,
}

#[event]
pub struct PausedSet {
    pub tracker: Pubkey,
    pub paused: bool,
}

/// One leg moved toward its published weight.
///
/// `amount_in` is what the swap actually spent, not what it was offered, so a
/// route that used less than its allowance is visible as such. Together these
/// events are the audit trail behind the claim that holdings follow the
/// published basket.
#[event]
pub struct LegSwapped {
    pub tracker: Pubkey,
    pub source_mint: Pubkey,
    pub destination_mint: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub timestamp: i64,
}

#[event]
pub struct TrackerClosed {
    pub tracker: Pubkey,
    pub ticker: String,
    pub lamports_returned: u64,
    pub timestamp: i64,
}

/// A leg's rebasing multiplier changed.
///
/// Emitted on every push, including a no-op re-push, so the multiplier's whole
/// history is reconstructable from logs. It is the one trusted input in the
/// valuation path, which makes its audit trail load-bearing.
#[event]
pub struct MultiplierPushed {
    pub tracker: Pubkey,
    pub mint: Pubkey,
    pub previous_multiplier_micros: u64,
    pub multiplier_micros: u64,
    pub timestamp: i64,
}
