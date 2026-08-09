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
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use error::*;
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

    pub fn deposit(ctx: Context<Deposit>, lamports_in: u64, min_shares_out: u64) -> Result<()> {
        instructions::deposit::handle_deposit(ctx, lamports_in, min_shares_out)
    }

    pub fn redeem_for_sol(
        ctx: Context<RedeemForSol>,
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
}
