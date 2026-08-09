use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::token_2022::{close_account, sync_native, CloseAccount, SyncNative};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::VaultError;
use crate::events::LegSwapped;
use crate::state::Tracker;

/// Jupiter aggregator v6. Pinned rather than passed, so a caller cannot route
/// the vault's assets through a program of their choosing.
pub const JUPITER_PROGRAM_ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/// Wrapped SOL. The vault holds native lamports, Jupiter trades tokens, so
/// every route into or out of the SOL sleeve passes through this mint.
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

#[derive(Accounts)]
pub struct SwapLeg<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [TRACKER_SEED, tracker.ticker.as_bytes()],
        bump = tracker.bump,
        has_one = authority,
    )]
    pub tracker: Account<'info, Tracker>,

    /// Holds the vault's native SOL and is the authority on every leg's token
    /// account. Data-less and system-owned, so it signs by seeds alone.
    #[account(
        mut,
        seeds = [VAULT_SEED, tracker.key().as_ref()],
        bump = tracker.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    /// What is being sold. Must be owned by the vault.
    #[account(
        mut,
        constraint = source_token_account.owner == vault.key()
            @ VaultError::TokenAccountOwnerMismatch,
        constraint = source_token_account.mint == source_mint.key()
            @ VaultError::TokenAccountMintMismatch,
    )]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    /// What is being bought. Must also be owned by the vault, so a swap can
    /// never deliver to an address the authority nominates.
    #[account(
        mut,
        constraint = destination_token_account.owner == vault.key()
            @ VaultError::TokenAccountOwnerMismatch,
        constraint = destination_token_account.mint == destination_mint.key()
            @ VaultError::TokenAccountMintMismatch,
    )]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    pub source_mint: InterfaceAccount<'info, Mint>,
    pub destination_mint: InterfaceAccount<'info, Mint>,

    /// Either SPL Token or Token-2022. xStocks are Token-2022 — with a permanent
    /// delegate, a pausable config and a scaled-UI-amount multiplier — so pinning
    /// this to the classic program made every real basket leg unreachable: the
    /// derived token accounts would not even be the right addresses.
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    /// CHECK: pinned to `JUPITER_PROGRAM_ID` below; never taken on trust.
    #[account(address = JUPITER_PROGRAM_ID @ VaultError::UnexpectedSwapProgram)]
    pub jupiter_program: UncheckedAccount<'info>,
    // `remaining_accounts` carries the route's own accounts, forwarded to the
    // CPI verbatim. They are Jupiter's to validate, not ours — what we validate
    // is the only thing that matters to a holder: what left, and what arrived.
}

/// Moves one leg toward its published weight by routing through Jupiter.
///
/// The security model is deliberately narrow. This instruction does **not**
/// try to understand the route: `route_data` is opaque bytes and the accounts
/// behind it are unchecked. What it does instead is bracket the CPI with
/// measurements the vault cares about and refuse to proceed unless they hold:
///
/// 1. **Both token accounts belong to the vault**, checked above. Whatever the
///    route does, the proceeds cannot land anywhere else.
/// 2. **The destination is a leg of the published basket** (or wSOL, the
///    sleeve). The authority cannot use this to convert the vault into a
///    token nobody voted for by publishing one basket and trading another.
/// 3. **Balances are read before and after.** Spending more than `amount_in`
///    or receiving less than `min_amount_out` reverts the whole transaction,
///    which makes a hostile or merely broken route a failed transaction rather
///    than a loss.
///
/// This is why the swap lives in the program at all. An off-chain executor
/// holding a withdrawal key would be far simpler, and would mean a window in
/// which depositor funds sit in an operator's wallet. Here they never leave.
pub fn handle_swap_leg<'info>(
    ctx: Context<'info, SwapLeg<'info>>,
    amount_in: u64,
    min_amount_out: u64,
    route_data: Vec<u8>,
) -> Result<()> {
    require!(amount_in > 0, VaultError::ZeroAmount);
    require!(!route_data.is_empty(), VaultError::EmptyRoute);
    require!(
        ctx.accounts.source_mint.key() != ctx.accounts.destination_mint.key(),
        VaultError::SwapToSameMint
    );

    let destination_mint = ctx.accounts.destination_mint.key();
    let source_mint = ctx.accounts.source_mint.key();

    // Buying: the destination must be something the published basket says we
    // hold. Selling into the sleeve is always allowed, because exiting a
    // position must never be blocked by the basket that no longer wants it.
    if destination_mint != WSOL_MINT {
        require!(
            ctx.accounts
                .tracker
                .legs
                .iter()
                .any(|leg| leg.mint == destination_mint),
            VaultError::MintNotInBasket
        );
    }

    let tracker_key = ctx.accounts.tracker.key();
    let vault_bump = ctx.accounts.tracker.vault_bump;
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        tracker_key.as_ref(),
        std::slice::from_ref(&vault_bump),
    ];

    // Wrapping: the vault's SOL is native lamports, but a route consumes
    // tokens. Move exactly `amount_in` into the wSOL account and sync it, so
    // the balance the route sees is the balance we intended to risk.
    if source_mint == WSOL_MINT {
        transfer(
            CpiContext::new_with_signer(
                System::id(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.source_token_account.to_account_info(),
                },
                &[vault_seeds],
            ),
            amount_in,
        )?;
        sync_native(CpiContext::new(
            ctx.accounts.token_program.key(),
            SyncNative {
                account: ctx.accounts.source_token_account.to_account_info(),
            },
        ))?;
    }

    // Measure before. Reloaded from the chain rather than trusted from the
    // deserialized account, which is a snapshot taken at instruction entry.
    ctx.accounts.source_token_account.reload()?;
    ctx.accounts.destination_token_account.reload()?;
    let source_before = ctx.accounts.source_token_account.amount;
    let destination_before = ctx.accounts.destination_token_account.amount;

    // Forward the route untouched. The vault is demoted to a non-signer in the
    // client's account list precisely because it cannot sign a transaction;
    // its signature is supplied here, by seeds.
    let mut metas: Vec<AccountMeta> = Vec::with_capacity(ctx.remaining_accounts.len());
    let mut infos: Vec<AccountInfo<'info>> = Vec::with_capacity(ctx.remaining_accounts.len() + 1);

    for account in ctx.remaining_accounts.iter() {
        metas.push(AccountMeta {
            pubkey: account.key(),
            is_signer: account.key() == ctx.accounts.vault.key(),
            is_writable: account.is_writable,
        });
        infos.push(account.clone());
    }
    infos.push(ctx.accounts.jupiter_program.to_account_info());

    invoke_signed(
        &Instruction {
            program_id: JUPITER_PROGRAM_ID,
            accounts: metas,
            data: route_data,
        },
        &infos,
        &[vault_seeds],
    )?;

    // Measure after. This is the whole guarantee: whatever happened inside the
    // route, the vault spent no more than it offered and received no less than
    // it demanded, or nothing happened at all.
    ctx.accounts.source_token_account.reload()?;
    ctx.accounts.destination_token_account.reload()?;
    let source_after = ctx.accounts.source_token_account.amount;
    let destination_after = ctx.accounts.destination_token_account.amount;

    let spent = source_before
        .checked_sub(source_after)
        .ok_or(VaultError::SwapIncreasedSourceBalance)?;
    require!(spent <= amount_in, VaultError::SwapSpentTooMuch);

    let received = destination_after
        .checked_sub(destination_before)
        .ok_or(VaultError::MathOverflow)?;
    require!(received >= min_amount_out, VaultError::SlippageExceeded);

    // Unwrap whatever wSOL is left — the proceeds of a sale, or the remainder
    // of a purchase that used less than it was given. Closing returns the
    // lamports to the vault, which is where the SOL sleeve lives.
    if destination_mint == WSOL_MINT {
        close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.destination_token_account.to_account_info(),
                destination: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ))?;
    } else if source_mint == WSOL_MINT && source_after > 0 {
        close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.source_token_account.to_account_info(),
                destination: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ))?;
    }

    emit!(LegSwapped {
        tracker: tracker_key,
        source_mint,
        destination_mint,
        amount_in: spent,
        amount_out: received,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
