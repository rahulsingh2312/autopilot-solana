use anchor_lang::prelude::*;
use anchor_spl::metadata::mpl_token_metadata::types::DataV2;
use anchor_spl::metadata::{
    create_metadata_accounts_v3, CreateMetadataAccountsV3, Metadata,
};
use anchor_spl::token::Mint;

use crate::constants::*;
use crate::state::Tracker;

/// The share mint's authority is the tracker PDA, so Metaplex metadata can
/// only be created by this program signing as that PDA. Without this, the
/// token shows up in wallets as an unnamed mint address.
#[derive(Accounts)]
pub struct SetTokenMetadata<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [TRACKER_SEED, tracker.ticker.as_bytes()],
        bump = tracker.bump,
        has_one = authority,
        has_one = share_mint,
    )]
    pub tracker: Account<'info, Tracker>,

    #[account(
        seeds = [SHARE_SEED, tracker.key().as_ref()],
        bump = tracker.mint_bump,
    )]
    pub share_mint: Account<'info, Mint>,

    /// CHECK: validated and created by the token metadata program at its
    /// canonical PDA for this mint.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    pub token_metadata_program: Program<'info, Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_set_token_metadata(
    ctx: Context<SetTokenMetadata>,
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    let ticker = ctx.accounts.tracker.ticker.clone();
    let bump = ctx.accounts.tracker.bump;
    let seeds: &[&[u8]] = &[TRACKER_SEED, ticker.as_bytes(), std::slice::from_ref(&bump)];

    create_metadata_accounts_v3(
        CpiContext::new_with_signer(
            Metadata::id(),
            CreateMetadataAccountsV3 {
                metadata: ctx.accounts.metadata.to_account_info(),
                mint: ctx.accounts.share_mint.to_account_info(),
                mint_authority: ctx.accounts.tracker.to_account_info(),
                update_authority: ctx.accounts.tracker.to_account_info(),
                payer: ctx.accounts.authority.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
            &[seeds],
        ),
        DataV2 {
            name,
            symbol,
            uri,
            seller_fee_basis_points: 0,
            creators: None,
            collection: None,
            uses: None,
        },
        // Mutable, so the URI can move to a permanent host later.
        true,
        // The update authority (the tracker PDA) is a CPI signer here.
        true,
        None,
    )
}
