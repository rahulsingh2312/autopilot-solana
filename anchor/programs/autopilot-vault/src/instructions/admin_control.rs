use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::token_2022::TransferChecked;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::VaultError;
use crate::events::{AuthorityChanged, EmergencyWithdrawn};
use crate::state::Tracker;

/// Moves assets out of a vault under the authority's signature.
///
/// This is a deliberate, operator-controlled escape hatch. The rest of the
/// program is built so that only depositors can move their own value —
/// `redeem_for_sol` and `redeem_in_kind` are the normal exits and neither
/// needs an operator — but there are failure modes those cannot reach: a leg
/// whose route disappears, a token the issuer pauses, a basket left
/// half-swapped by a reverted transaction, or a bug that needs funds moved
/// somewhere safe while it is fixed.
///
/// The trade is explicit and it is not hidden: **the authority can remove
/// depositor assets from the vault.** The product's disclosure has to say so,
/// because holders can no longer verify custody from the program alone — they
/// are trusting whoever holds the authority key. Every use emits an event, so
/// the exercise of that trust is at least a matter of public record.
#[derive(Accounts)]
pub struct EmergencyWithdraw<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [TRACKER_SEED, tracker.ticker.as_bytes()],
        bump = tracker.bump,
        has_one = authority,
    )]
    pub tracker: Account<'info, Tracker>,

    #[account(
        mut,
        seeds = [VAULT_SEED, tracker.key().as_ref()],
        bump = tracker.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    /// Where the assets land. Named by the authority.
    /// CHECK: the authority chooses its own recovery destination.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Sweeps lamports out of the vault.
///
/// The rent reserve is protected: taking it would close the vault account and
/// make the tracker unusable rather than merely empty, which turns a recovery
/// into a demolition.
pub fn handle_emergency_withdraw_sol(
    ctx: Context<EmergencyWithdraw>,
    lamports: u64,
) -> Result<()> {
    require!(lamports > 0, VaultError::ZeroAmount);

    let available = ctx
        .accounts
        .vault
        .lamports()
        .saturating_sub(ctx.accounts.tracker.rent_reserve);
    require!(lamports <= available, VaultError::InsufficientVaultBalance);

    let tracker_key = ctx.accounts.tracker.key();
    let vault_bump = ctx.accounts.tracker.vault_bump;

    transfer(
        CpiContext::new_with_signer(
            System::id(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
            },
            &[&[
                VAULT_SEED,
                tracker_key.as_ref(),
                std::slice::from_ref(&vault_bump),
            ]],
        ),
        lamports,
    )?;

    emit!(EmergencyWithdrawn {
        tracker: tracker_key,
        mint: Pubkey::default(),
        amount: lamports,
        destination: ctx.accounts.destination.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct EmergencyWithdrawToken<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [TRACKER_SEED, tracker.ticker.as_bytes()],
        bump = tracker.bump,
        has_one = authority,
    )]
    pub tracker: Account<'info, Tracker>,

    #[account(
        seeds = [VAULT_SEED, tracker.key().as_ref()],
        bump = tracker.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key()
            @ VaultError::TokenAccountOwnerMismatch,
        constraint = vault_token_account.mint == mint.key()
            @ VaultError::TokenAccountMintMismatch,
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    /// Either token program: xStocks are Token-2022.
    pub token_program: Interface<'info, TokenInterface>,
}

/// Moves a tokenized leg out of the vault under the authority's signature.
pub fn handle_emergency_withdraw_token(
    ctx: Context<EmergencyWithdrawToken>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    require!(
        amount <= ctx.accounts.vault_token_account.amount,
        VaultError::InsufficientVaultBalance
    );

    let tracker_key = ctx.accounts.tracker.key();
    let vault_bump = ctx.accounts.tracker.vault_bump;
    let decimals = ctx.accounts.mint.decimals;

    anchor_spl::token_2022::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.destination_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[&[
                VAULT_SEED,
                tracker_key.as_ref(),
                std::slice::from_ref(&vault_bump),
            ]],
        ),
        amount,
        decimals,
    )?;

    emit!(EmergencyWithdrawn {
        tracker: tracker_key,
        mint: ctx.accounts.mint.key(),
        amount,
        destination: ctx.accounts.destination_token_account.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [TRACKER_SEED, tracker.ticker.as_bytes()],
        bump = tracker.bump,
        has_one = authority,
    )]
    pub tracker: Account<'info, Tracker>,
}

/// Hands control of a tracker to a new key.
///
/// One-step rather than the usual propose-then-accept. A two-step handover
/// protects against typing the wrong address; this program's authority is an
/// operational key that also needs to be rotatable in a hurry, and the
/// tracker's own `authority` field is readable on chain, so a mistake is
/// visible immediately even if it is not reversible.
pub fn handle_set_authority(ctx: Context<SetAuthority>, new_authority: Pubkey) -> Result<()> {
    require!(new_authority != Pubkey::default(), VaultError::InvalidAuthority);

    let previous = ctx.accounts.tracker.authority;
    ctx.accounts.tracker.authority = new_authority;

    emit!(AuthorityChanged {
        tracker: ctx.accounts.tracker.key(),
        previous,
        current: new_authority,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
