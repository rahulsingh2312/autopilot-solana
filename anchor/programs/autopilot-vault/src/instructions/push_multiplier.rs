use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::constants::*;
use crate::error::VaultError;
use crate::events::MultiplierPushed;
use crate::state::{LegOracle, Tracker};

#[derive(Accounts)]
pub struct PushMultiplier<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [TRACKER_SEED, tracker.ticker.as_bytes()],
        bump = tracker.bump,
        has_one = authority,
    )]
    pub tracker: Account<'info, Tracker>,

    /// The xStocks mint being priced. Present so `decimals` is read from the
    /// chain rather than taken from the caller.
    pub mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + LegOracle::INIT_SPACE,
        seeds = [LEG_ORACLE_SEED, tracker.key().as_ref(), mint.key().as_ref()],
        bump,
    )]
    pub leg_oracle: Account<'info, LegOracle>,

    pub system_program: Program<'info, System>,
}

/// Publishes the rebasing multiplier and price feed for one tokenized leg.
///
/// This is the one number in the valuation path that no oracle carries. Pyth
/// publishes the price of NVDA; nobody publishes the multiplier that converts
/// a balance of NVDAx into a number of NVDA shares. Backed does, over an HTTP
/// API, so the worker reads it there and pushes it here.
///
/// That makes the multiplier the trusted input in an otherwise trustless
/// valuation, and it is worth being precise about what that trust buys an
/// attacker. It is bounded on both sides below, so a compromised or buggy
/// pusher can nudge NAV, not invent it. It also only moves on corporate
/// actions — a split, a dividend — so in normal operation this instruction is
/// called approximately never, and a sudden change is visible in the event log.
pub fn handle_push_multiplier(
    ctx: Context<PushMultiplier>,
    feed_id: [u8; 32],
    multiplier_micros: u64,
) -> Result<()> {
    // A multiplier outside this range is not a corporate action, it is a
    // mistake or an attack. 0.01× to 100× spans every real split or reverse
    // split an equity has ever had while making a fat-fingered zero fail.
    require!(
        (10_000..=100_000_000).contains(&multiplier_micros),
        VaultError::MultiplierOutOfRange
    );
    require!(feed_id != [0u8; 32], VaultError::InvalidFeedId);

    // The mint must be a leg of the published basket. Without this, an
    // authority could seed oracle records for tokens the tracker does not
    // hold and then swap into them.
    require!(
        ctx.accounts
            .tracker
            .legs
            .iter()
            .any(|leg| leg.mint == ctx.accounts.mint.key()),
        VaultError::MintNotInBasket
    );

    let leg_oracle = &mut ctx.accounts.leg_oracle;
    let previous = leg_oracle.multiplier_micros;

    leg_oracle.tracker = ctx.accounts.tracker.key();
    leg_oracle.mint = ctx.accounts.mint.key();
    leg_oracle.feed_id = feed_id;
    leg_oracle.multiplier_micros = multiplier_micros;
    leg_oracle.decimals = ctx.accounts.mint.decimals;
    leg_oracle.updated_at = Clock::get()?.unix_timestamp;
    leg_oracle.bump = ctx.bumps.leg_oracle;

    emit!(MultiplierPushed {
        tracker: leg_oracle.tracker,
        mint: leg_oracle.mint,
        previous_multiplier_micros: previous,
        multiplier_micros,
        timestamp: leg_oracle.updated_at,
    });

    Ok(())
}
