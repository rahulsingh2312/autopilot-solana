use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::token_2022::{burn, transfer_checked, Burn, TransferChecked};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::VaultError;
use crate::events::RedeemedInKind;
use crate::state::{mul_div, Tracker};

#[derive(Accounts)]
pub struct RedeemInKind<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,

    #[account(
        mut,
        seeds = [TRACKER_SEED, tracker.ticker.as_bytes()],
        bump = tracker.bump,
        has_one = share_mint,
    )]
    pub tracker: Account<'info, Tracker>,

    #[account(
        mut,
        seeds = [SHARE_SEED, tracker.key().as_ref()],
        bump = tracker.mint_bump,
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, tracker.key().as_ref()],
        bump = tracker.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    #[account(
        mut,
        constraint = holder_shares.mint == tracker.share_mint @ VaultError::TokenAccountMintMismatch,
        constraint = holder_shares.owner == holder.key() @ VaultError::TokenAccountOwnerMismatch,
    )]
    pub holder_shares: InterfaceAccount<'info, TokenAccount>,

    /// Either token program. xStocks are Token-2022, so pinning this to the
    /// classic program made the vault's own legs undeliverable — the redemption
    /// path this product relies on as its escape hatch would have failed on
    /// exactly the assets it exists to return.
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    //
    // `remaining_accounts` carries, for each tokenized leg in basket order,
    // a triple of (leg mint, vault token account, holder token account).
    // Legs whose mint is the zero pubkey have no tokenized equivalent yet and
    // are skipped: their weight lives in the SOL sleeve, which is paid out
    // pro-rata below.
}

struct Delivery {
    mint_index: usize,
    amount: u64,
    decimals: u8,
}

/// Take delivery of the basket instead of selling it. The redemption fee is
/// applied as a haircut and stays in the vault, accruing to the remaining
/// holders, rather than being swept to the fee wallet in sixteen dust-sized
/// token transfers.
pub fn handle_redeem_in_kind<'info>(
    ctx: Context<'info, RedeemInKind<'info>>,
    shares_in: u64,
) -> Result<()> {
    require!(shares_in > 0, VaultError::ZeroAmount);

    let supply_before = ctx.accounts.share_mint.supply;
    require!(supply_before > 0, VaultError::NoSharesOutstanding);

    let keep_ppm = FEE_DENOMINATOR
        .checked_sub(u64::from(ctx.accounts.tracker.redeem_fee_ppm))
        .ok_or(VaultError::MathOverflow)?;

    let tokenized: Vec<usize> = ctx
        .accounts
        .tracker
        .legs
        .iter()
        .enumerate()
        .filter(|(_, leg)| leg.is_tokenized())
        .map(|(i, _)| i)
        .collect();

    let remaining = ctx.remaining_accounts;
    require!(
        remaining.len() == tokenized.len() * 3,
        VaultError::RemainingAccountsMismatch
    );

    // Size every payout against pre-burn state, then burn, then pay out.
    let mut deliveries: Vec<Delivery> = Vec::with_capacity(tokenized.len());
    for (slot, &leg_index) in tokenized.iter().enumerate() {
        let leg_mint = ctx.accounts.tracker.legs[leg_index].mint;
        let mint_info = &remaining[slot * 3];
        let vault_ta_info = &remaining[slot * 3 + 1];

        require_keys_eq!(
            mint_info.key(),
            leg_mint,
            VaultError::TokenAccountMintMismatch
        );

        let mint_data = mint_info.try_borrow_data()?;
        let mint_state = Mint::try_deserialize(&mut &mint_data[..])?;

        let vault_ta_data = vault_ta_info.try_borrow_data()?;
        let vault_ta = TokenAccount::try_deserialize(&mut &vault_ta_data[..])?;
        require_keys_eq!(vault_ta.mint, leg_mint, VaultError::TokenAccountMintMismatch);
        require_keys_eq!(
            vault_ta.owner,
            ctx.accounts.tracker.key(),
            VaultError::TokenAccountOwnerMismatch
        );

        let holder_ta_data = remaining[slot * 3 + 2].try_borrow_data()?;
        let holder_ta = TokenAccount::try_deserialize(&mut &holder_ta_data[..])?;
        require_keys_eq!(
            holder_ta.mint,
            leg_mint,
            VaultError::TokenAccountMintMismatch
        );
        require_keys_eq!(
            holder_ta.owner,
            ctx.accounts.holder.key(),
            VaultError::TokenAccountOwnerMismatch
        );

        let pro_rata = mul_div(vault_ta.amount, shares_in, supply_before)?;
        deliveries.push(Delivery {
            mint_index: slot * 3,
            amount: mul_div(pro_rata, keep_ppm, FEE_DENOMINATOR)?,
            decimals: mint_state.decimals,
        });
    }

    let vault_lamports = ctx.accounts.vault.lamports();
    let assets_before = ctx.accounts.tracker.net_assets(vault_lamports);
    let sol_gross = mul_div(assets_before, shares_in, supply_before)?;
    let sol_out = mul_div(sol_gross, keep_ppm, FEE_DENOMINATOR)?;

    require!(
        deliveries.iter().any(|d| d.amount > 0) || sol_out > 0,
        VaultError::RedemptionTooSmall
    );
    require!(
        vault_lamports
            .checked_sub(sol_out)
            .ok_or(VaultError::MathOverflow)?
            >= ctx.accounts.tracker.rent_reserve,
        VaultError::InsufficientVaultBalance
    );

    burn(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Burn {
                mint: ctx.accounts.share_mint.to_account_info(),
                from: ctx.accounts.holder_shares.to_account_info(),
                authority: ctx.accounts.holder.to_account_info(),
            },
        ),
        shares_in,
    )?;

    let tracker_key = ctx.accounts.tracker.key();
    let ticker = ctx.accounts.tracker.ticker.clone();
    let bump = ctx.accounts.tracker.bump;
    let tracker_seeds: &[&[u8]] = &[TRACKER_SEED, ticker.as_bytes(), std::slice::from_ref(&bump)];

    let mut delivered: u8 = 0;
    for delivery in &deliveries {
        if delivery.amount == 0 {
            continue;
        }
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: remaining[delivery.mint_index + 1].to_account_info(),
                    mint: remaining[delivery.mint_index].to_account_info(),
                    to: remaining[delivery.mint_index + 2].to_account_info(),
                    authority: ctx.accounts.tracker.to_account_info(),
                },
                &[tracker_seeds],
            ),
            delivery.amount,
            delivery.decimals,
        )?;
        delivered = delivered.saturating_add(1);
    }

    if sol_out > 0 {
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
            sol_out,
        )?;
    }

    emit!(RedeemedInKind {
        tracker: tracker_key,
        holder: ctx.accounts.holder.key(),
        shares_in,
        lamports_out: sol_out,
        legs_delivered: delivered,
        supply_after: supply_before
            .checked_sub(shares_in)
            .ok_or(VaultError::MathOverflow)?,
    });

    Ok(())
}
