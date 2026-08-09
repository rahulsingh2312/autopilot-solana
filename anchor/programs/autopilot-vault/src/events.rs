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
