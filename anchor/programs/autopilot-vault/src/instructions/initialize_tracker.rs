use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::token::{Mint, Token};

use crate::constants::*;
use crate::error::VaultError;
use crate::events::TrackerInitialized;
use crate::state::{validate_legs, BasketLeg, Tracker};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeTrackerArgs {
    pub ticker: String,
    pub name: String,
    pub legs: Vec<BasketLeg>,
    pub deposit_fee_ppm: u16,
    pub redeem_fee_ppm: u16,
    pub rebalance_interval: i64,
    pub filing_delay_days: u16,
}

#[derive(Accounts)]
#[instruction(args: InitializeTrackerArgs)]
pub struct InitializeTracker<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: stored as the fee destination only; never read or written here.
    pub fee_recipient: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Tracker::INIT_SPACE,
        seeds = [TRACKER_SEED, args.ticker.as_bytes()],
        bump,
    )]
    pub tracker: Account<'info, Tracker>,

    /// The tracker PDA is the mint authority, so only this program can change
    /// the share supply. Freeze authority is left unset on purpose: nobody,
    /// including us, can freeze a holder's tokens.
    #[account(
        init,
        payer = payer,
        seeds = [SHARE_SEED, tracker.key().as_ref()],
        bump,
        mint::decimals = SHARE_DECIMALS,
        mint::authority = tracker,
    )]
    pub share_mint: Account<'info, Mint>,

    /// Holds the vault's SOL. Data-less and system-owned, so the program can
    /// move lamports out with a signed system transfer.
    #[account(
        mut,
        seeds = [VAULT_SEED, tracker.key().as_ref()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_initialize_tracker(
    ctx: Context<InitializeTracker>,
    args: InitializeTrackerArgs,
) -> Result<()> {
    require!(
        !args.ticker.is_empty() && args.ticker.len() <= MAX_TICKER_LEN,
        VaultError::InvalidTicker
    );
    require!(
        !args.name.is_empty() && args.name.len() <= MAX_NAME_LEN,
        VaultError::InvalidName
    );
    require!(
        args.deposit_fee_ppm <= MAX_FEE_PPM && args.redeem_fee_ppm <= MAX_FEE_PPM,
        VaultError::FeeTooHigh
    );
    validate_legs(&args.legs)?;

    // Fund the vault to rent exemption up front and remember the amount, so
    // depositor NAV is never inflated by the reserve sitting underneath it.
    let rent_reserve = ctx.accounts.rent.minimum_balance(0);
    transfer(
        CpiContext::new(
            System::id(),
            Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        rent_reserve,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let tracker = &mut ctx.accounts.tracker;

    tracker.authority = ctx.accounts.payer.key();
    tracker.share_mint = ctx.accounts.share_mint.key();
    tracker.fee_recipient = ctx.accounts.fee_recipient.key();
    tracker.ticker = args.ticker.clone();
    tracker.name = args.name;
    tracker.legs = args.legs;
    tracker.deposit_fee_ppm = args.deposit_fee_ppm;
    tracker.redeem_fee_ppm = args.redeem_fee_ppm;
    tracker.rebalance_interval = args.rebalance_interval;
    tracker.last_rebalance_ts = now;
    tracker.rebalance_count = 0;
    tracker.filing_delay_days = args.filing_delay_days;
    tracker.rent_reserve = rent_reserve;
    tracker.paused = false;
    tracker.created_at = now;
    tracker.bump = ctx.bumps.tracker;
    tracker.vault_bump = ctx.bumps.vault;
    tracker.mint_bump = ctx.bumps.share_mint;

    emit!(TrackerInitialized {
        tracker: tracker.key(),
        ticker: args.ticker,
        share_mint: tracker.share_mint,
        authority: tracker.authority,
    });

    Ok(())
}
