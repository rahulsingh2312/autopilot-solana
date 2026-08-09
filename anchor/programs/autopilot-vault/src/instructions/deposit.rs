use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{mint_to, Mint, MintTo, Token, TokenAccount};

use crate::constants::*;
use crate::error::VaultError;
use crate::events::Deposited;
use crate::state::{fee_on, mul_div, Tracker};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [TRACKER_SEED, tracker.ticker.as_bytes()],
        bump = tracker.bump,
        has_one = share_mint,
        has_one = fee_recipient,
        constraint = !tracker.paused @ VaultError::TrackerPaused,
    )]
    pub tracker: Account<'info, Tracker>,

    #[account(
        mut,
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

    /// CHECK: address is pinned by the tracker's `has_one = fee_recipient`.
    #[account(mut)]
    pub fee_recipient: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = depositor,
        associated_token::mint = share_mint,
        associated_token::authority = depositor,
    )]
    pub depositor_shares: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// `min_shares_out` is the caller's slippage floor. NAV can move between the
/// quote the user saw and the slot this lands in, so the number they approved
/// is enforced on chain rather than trusted from the UI.
pub fn handle_deposit(ctx: Context<Deposit>, lamports_in: u64, min_shares_out: u64) -> Result<()> {
    require!(lamports_in > 0, VaultError::ZeroAmount);

    let fee = fee_on(lamports_in, ctx.accounts.tracker.deposit_fee_ppm)?;
    let net = lamports_in
        .checked_sub(fee)
        .ok_or(VaultError::MathOverflow)?;
    require!(net > 0, VaultError::ZeroAmount);

    // Price against the vault as it stands *before* this deposit lands.
    let supply_before = ctx.accounts.share_mint.supply;
    let assets_before = ctx
        .accounts
        .tracker
        .net_assets(ctx.accounts.vault.lamports());

    let shares_out = if supply_before == 0 {
        // Genesis: one share per lamport, so NAV per token starts at exactly
        // 1.0 given the share mint shares SOL's 9 decimals.
        net
    } else {
        require!(assets_before > 0, VaultError::EmptyVault);
        mul_div(net, supply_before, assets_before)?
    };
    require!(shares_out > 0, VaultError::DepositTooSmall);
    require!(shares_out >= min_shares_out, VaultError::SlippageExceeded);

    transfer(
        CpiContext::new(
            System::id(),
            Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        net,
    )?;

    if fee > 0 {
        transfer(
            CpiContext::new(
                System::id(),
                Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.fee_recipient.to_account_info(),
                },
            ),
            fee,
        )?;
    }

    let tracker_key = ctx.accounts.tracker.key();
    let ticker = ctx.accounts.tracker.ticker.clone();
    let bump = ctx.accounts.tracker.bump;
    let seeds: &[&[u8]] = &[TRACKER_SEED, ticker.as_bytes(), std::slice::from_ref(&bump)];

    mint_to(
        CpiContext::new_with_signer(
            Token::id(),
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.depositor_shares.to_account_info(),
                authority: ctx.accounts.tracker.to_account_info(),
            },
            &[seeds],
        ),
        shares_out,
    )?;

    emit!(Deposited {
        tracker: tracker_key,
        depositor: ctx.accounts.depositor.key(),
        lamports_in,
        fee_lamports: fee,
        shares_out,
        supply_after: supply_before
            .checked_add(shares_out)
            .ok_or(VaultError::MathOverflow)?,
        net_assets_after: assets_before
            .checked_add(net)
            .ok_or(VaultError::MathOverflow)?,
    });

    Ok(())
}
