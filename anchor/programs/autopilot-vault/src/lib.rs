//! Autopilot vault: one generic basket vault, parameterized by config.
//!
//! Every tracker (mbtSOL, icSOL, and later anything a creator deploys) is the
//! same code path with a different `Tracker` account. Deposit SOL, receive a
//! share token priced off vault NAV, burn it for SOL or for pro-rata delivery
//! of the underlying tokenized equities.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod oracle;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use error::*;
pub use oracle::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("8cKanyTRdgbdf8eWiLpqzy3kwzsXWXNxQdd6NRauCSNK");

#[program]
pub mod autopilot_vault {
    use super::*;

    pub fn initialize_tracker(
        ctx: Context<InitializeTracker>,
        args: InitializeTrackerArgs,
    ) -> Result<()> {
        instructions::initialize_tracker::handle_initialize_tracker(ctx, args)
    }

    pub fn deposit<'info>(
        ctx: Context<'info, Deposit<'info>>,
        lamports_in: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit::handle_deposit(ctx, lamports_in, min_shares_out)
    }

    pub fn redeem_for_sol<'info>(
        ctx: Context<'info, RedeemForSol<'info>>,
        shares_in: u64,
        min_lamports_out: u64,
    ) -> Result<()> {
        instructions::redeem_for_sol::handle_redeem_for_sol(ctx, shares_in, min_lamports_out)
    }

    pub fn redeem_in_kind<'info>(
        ctx: Context<'info, RedeemInKind<'info>>,
        shares_in: u64,
    ) -> Result<()> {
        instructions::redeem_in_kind::handle_redeem_in_kind(ctx, shares_in)
    }

    pub fn rebalance(ctx: Context<AdminOnly>, legs: Vec<BasketLeg>) -> Result<()> {
        instructions::rebalance::handle_rebalance(ctx, legs)
    }

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        instructions::rebalance::handle_set_paused(ctx, paused)
    }

    pub fn set_token_metadata(
        ctx: Context<SetTokenMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        instructions::set_token_metadata::handle_set_token_metadata(ctx, name, symbol, uri)
    }

    pub fn set_fees(
        ctx: Context<AdminOnly>,
        deposit_fee_ppm: u16,
        redeem_fee_ppm: u16,
    ) -> Result<()> {
        instructions::rebalance::handle_set_fees(ctx, deposit_fee_ppm, redeem_fee_ppm)
    }

    /// Route one leg through Jupiter, signed by the vault PDA.
    ///
    /// This is what turns `rebalance` from a published intention into a change
    /// in what the vault actually holds. Custody is never broken: the assets
    /// move from one vault-owned token account to another inside a single
    /// transaction, and the program checks what was spent and received rather
    /// than trusting the route.
    pub fn swap_leg<'info>(
        ctx: Context<'info, SwapLeg<'info>>,
        amount_in: u64,
        min_amount_out: u64,
        route_data: Vec<u8>,
    ) -> Result<()> {
        instructions::swap_leg::handle_swap_leg(ctx, amount_in, min_amount_out, route_data)
    }

    /// Publish the price feed and rebasing multiplier for one tokenized leg.
    ///
    /// Required before a vault holding that leg can price a deposit: Pyth
    /// carries the equity's price, but nothing on chain carries the multiplier
    /// that turns a token balance into a share count.
    pub fn push_multiplier(
        ctx: Context<PushMultiplier>,
        feed_id: [u8; 32],
        multiplier_micros: u64,
    ) -> Result<()> {
        instructions::push_multiplier::handle_push_multiplier(ctx, feed_id, multiplier_micros)
    }

    /// Sweep lamports out of a vault, keeping it rent-exempt.
    pub fn emergency_withdraw_sol(
        ctx: Context<EmergencyWithdraw>,
        lamports: u64,
    ) -> Result<()> {
        instructions::admin_control::handle_emergency_withdraw_sol(ctx, lamports)
    }

    /// Move a tokenized leg out of a vault.
    pub fn emergency_withdraw_token(
        ctx: Context<EmergencyWithdrawToken>,
        amount: u64,
    ) -> Result<()> {
        instructions::admin_control::handle_emergency_withdraw_token(ctx, amount)
    }

    /// Hand control of a tracker to a new key.
    pub fn set_authority(ctx: Context<SetAuthority>, new_authority: Pubkey) -> Result<()> {
        instructions::admin_control::handle_set_authority(ctx, new_authority)
    }

    /// Retire a tracker. Refuses while any share is outstanding.
    pub fn close_tracker(ctx: Context<CloseTracker>) -> Result<()> {
        instructions::close_tracker::handle_close_tracker(ctx)
    }
}
