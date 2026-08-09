use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::token::{Mint, Token};

use crate::constants::*;
use crate::error::VaultError;
use crate::events::TrackerClosed;
use crate::state::Tracker;

#[derive(Accounts)]
pub struct CloseTracker<'info> {
    pub authority: Signer<'info>,

    /// Rent from both the tracker account and the vault lands here.
    /// CHECK: the authority names where its own rent goes.
    #[account(mut)]
    pub rent_destination: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [TRACKER_SEED, tracker.ticker.as_bytes()],
        bump = tracker.bump,
        has_one = authority,
        has_one = share_mint,
        close = rent_destination,
    )]
    pub tracker: Account<'info, Tracker>,

    #[account(
        seeds = [SHARE_SEED, tracker.key().as_ref()],
        bump = tracker.mint_bump,
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, tracker.key().as_ref()],
        bump = tracker.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Retires a tracker permanently.
///
/// Exists because the admin panel needs "remove this tracker" to mean
/// something. Without it, removal could only ever be cosmetic — pause deposits
/// and hide the card — while the account, the mint, and the vault stayed on
/// chain forever, which is a different claim than the button makes.
///
/// The one rule that makes this safe: **it refuses while any share is
/// outstanding.** A tracker with holders is not the authority's to delete, and
/// the check is on the mint's own supply rather than on a number this program
/// stores, so there is no bookkeeping to get wrong. Retiring a live tracker
/// therefore has a required order — pause it, let holders redeem, then close —
/// and the program enforces it rather than documenting it.
///
/// Tokenized legs must be emptied first too. Lamports can be swept here, but
/// token accounts cannot be closed without their mints present, and silently
/// stranding a vault's xStocks behind a deleted config would be exactly the
/// kind of quiet loss this codebase is meant to avoid.
pub fn handle_close_tracker(ctx: Context<CloseTracker>) -> Result<()> {
    require!(
        ctx.accounts.share_mint.supply == 0,
        VaultError::SharesStillOutstanding
    );

    require!(
        ctx.accounts
            .tracker
            .legs
            .iter()
            .all(|leg| !leg.is_tokenized()),
        VaultError::TokenizedLegsRemain
    );

    let tracker_key = ctx.accounts.tracker.key();
    let ticker = ctx.accounts.tracker.ticker.clone();
    let vault_bump = ctx.accounts.tracker.vault_bump;

    // Sweep the vault, rent reserve included: with no shares outstanding there
    // is nobody left for it to belong to.
    let lamports = ctx.accounts.vault.lamports();
    if lamports > 0 {
        transfer(
            CpiContext::new_with_signer(
                System::id(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.rent_destination.to_account_info(),
                },
                &[&[
                    VAULT_SEED,
                    tracker_key.as_ref(),
                    std::slice::from_ref(&vault_bump),
                ]],
            ),
            lamports,
        )?;
    }

    // The share mint is deliberately left in place. Its authority is the
    // tracker PDA, which is being closed, so the mint becomes permanently
    // immutable at zero supply — a dead token nobody can ever mint again.
    // That is a better end state than a mint whose authority outlives the
    // config that justified it.
    emit!(TrackerClosed {
        tracker: tracker_key,
        ticker,
        lamports_returned: lamports,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
