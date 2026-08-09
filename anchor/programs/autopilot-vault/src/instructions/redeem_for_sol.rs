use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::token::{burn, Burn, Mint, Token, TokenAccount};

use crate::constants::*;
use crate::error::VaultError;
use crate::events::RedeemedForSol;
use crate::state::{fee_on, mul_div, Tracker};

#[derive(Accounts)]
pub struct RedeemForSol<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,

    #[account(
        mut,
        seeds = [TRACKER_SEED, tracker.ticker.as_bytes()],
        bump = tracker.bump,
        has_one = share_mint,
        has_one = fee_recipient,
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
        mut,
        constraint = holder_shares.mint == tracker.share_mint @ VaultError::TokenAccountMintMismatch,
        constraint = holder_shares.owner == holder.key() @ VaultError::TokenAccountOwnerMismatch,
    )]
    pub holder_shares: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Redemption stays open while paused. Pausing stops new money coming in, it
/// does not trap money that is already in.
pub fn handle_redeem_for_sol(
    ctx: Context<RedeemForSol>,
    shares_in: u64,
    min_lamports_out: u64,
) -> Result<()> {
    require!(shares_in > 0, VaultError::ZeroAmount);

    let supply_before = ctx.accounts.share_mint.supply;
    require!(supply_before > 0, VaultError::NoSharesOutstanding);

    let vault_lamports = ctx.accounts.vault.lamports();
    let assets_before = ctx.accounts.tracker.net_assets(vault_lamports);
    require!(assets_before > 0, VaultError::EmptyVault);

    let gross = mul_div(assets_before, shares_in, supply_before)?;
    require!(gross > 0, VaultError::RedemptionTooSmall);

    let fee = fee_on(gross, ctx.accounts.tracker.redeem_fee_ppm)?;
    let net = gross.checked_sub(fee).ok_or(VaultError::MathOverflow)?;
    require!(net > 0, VaultError::RedemptionTooSmall);
    require!(net >= min_lamports_out, VaultError::SlippageExceeded);

    // The rent reserve is not depositor money and must survive the transfer.
    require!(
        vault_lamports
            .checked_sub(gross)
            .ok_or(VaultError::MathOverflow)?
            >= ctx.accounts.tracker.rent_reserve,
        VaultError::InsufficientVaultBalance
    );

    burn(
        CpiContext::new(
            Token::id(),
            Burn {
                mint: ctx.accounts.share_mint.to_account_info(),
                from: ctx.accounts.holder_shares.to_account_info(),
                authority: ctx.accounts.holder.to_account_info(),
            },
        ),
        shares_in,
    )?;

    let tracker_key = ctx.accounts.tracker.key();
    let vault_bump = ctx.accounts.tracker.vault_bump;
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        tracker_key.as_ref(),
        std::slice::from_ref(&vault_bump),
    ];

    transfer(
        CpiContext::new_with_signer(
            System::id(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.holder.to_account_info(),
            },
            &[vault_seeds],
        ),
        net,
    )?;

    if fee > 0 {
        transfer(
            CpiContext::new_with_signer(
                System::id(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.fee_recipient.to_account_info(),
                },
                &[vault_seeds],
            ),
            fee,
        )?;
    }

    emit!(RedeemedForSol {
        tracker: tracker_key,
        holder: ctx.accounts.holder.key(),
        shares_in,
        fee_lamports: fee,
        lamports_out: net,
        supply_after: supply_before
            .checked_sub(shares_in)
            .ok_or(VaultError::MathOverflow)?,
        net_assets_after: assets_before
            .checked_sub(gross)
            .ok_or(VaultError::MathOverflow)?,
    });

    Ok(())
}
