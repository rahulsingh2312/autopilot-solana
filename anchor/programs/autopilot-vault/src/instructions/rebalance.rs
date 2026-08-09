use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::VaultError;
use crate::events::{PausedSet, Rebalanced};
use crate::state::{validate_legs, BasketLeg, Tracker};

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [TRACKER_SEED, tracker.ticker.as_bytes()],
        bump = tracker.bump,
        has_one = authority,
    )]
    pub tracker: Account<'info, Tracker>,
}

/// Publish a new target basket. The account is allocated for the maximum leg
/// count at init, so this never needs to grow the account.
///
/// This records intent. Actually moving the vault's assets to match the new
/// weights is a separate, off-chain-routed step, and the site says so rather
/// than implying the swap happened the moment the weights changed.
pub fn handle_rebalance(ctx: Context<AdminOnly>, legs: Vec<BasketLeg>) -> Result<()> {
    validate_legs(&legs)?;

    let now = Clock::get()?.unix_timestamp;
    let tracker = &mut ctx.accounts.tracker;

    tracker.legs = legs;
    tracker.last_rebalance_ts = now;
    tracker.rebalance_count = tracker
        .rebalance_count
        .checked_add(1)
        .ok_or(VaultError::MathOverflow)?;

    emit!(Rebalanced {
        tracker: tracker.key(),
        rebalance_count: tracker.rebalance_count,
        timestamp: now,
    });

    Ok(())
}

/// Halt deposits. Redemption deliberately stays open: a pause should never be
/// able to lock holders out of their own money.
pub fn handle_set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
    let tracker = &mut ctx.accounts.tracker;
    tracker.paused = paused;

    emit!(PausedSet {
        tracker: tracker.key(),
        paused,
    });

    Ok(())
}

/// Fees can be changed, but never above the constant ceiling compiled into
/// the program.
pub fn handle_set_fees(
    ctx: Context<AdminOnly>,
    deposit_fee_bps: u16,
    redeem_fee_bps: u16,
) -> Result<()> {
    require!(
        deposit_fee_bps <= MAX_FEE_BPS && redeem_fee_bps <= MAX_FEE_BPS,
        VaultError::FeeTooHigh
    );

    let tracker = &mut ctx.accounts.tracker;
    tracker.deposit_fee_bps = deposit_fee_bps;
    tracker.redeem_fee_bps = redeem_fee_bps;

    Ok(())
}
