use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::VaultError;

/// One position in a tracker's basket.
///
/// `mint` is the tokenized-equity mint this leg is held as. It is
/// `Pubkey::default()` when the underlying name has no tokenized equivalent
/// yet: that weight sits in the SOL sleeve instead of being silently dropped,
/// and the UI reads the zero mint as "not tokenized, held as SOL".
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace, Debug)]
pub struct BasketLeg {
    pub mint: Pubkey,
    #[max_len(MAX_SYMBOL_LEN)]
    pub symbol: String,
    pub weight_bps: u16,
}

impl BasketLeg {
    pub fn is_tokenized(&self) -> bool {
        self.mint != Pubkey::default()
    }
}

#[account]
#[derive(InitSpace, Debug)]
pub struct Tracker {
    /// Allowed to rebalance, pause, and update fees.
    pub authority: Pubkey,
    /// SPL mint for this tracker's share token. Supply is the share count, so
    /// there is no second copy of it here to drift out of sync.
    pub share_mint: Pubkey,
    /// Where deposit and redemption fees land.
    pub fee_recipient: Pubkey,
    #[max_len(MAX_TICKER_LEN)]
    pub ticker: String,
    #[max_len(MAX_NAME_LEN)]
    pub name: String,
    #[max_len(MAX_LEGS)]
    pub legs: Vec<BasketLeg>,
    pub deposit_fee_bps: u16,
    pub redeem_fee_bps: u16,
    /// Target seconds between rebalances. Advisory: the program records
    /// cadence so the UI can state it, it does not enforce a schedule.
    pub rebalance_interval: i64,
    pub last_rebalance_ts: i64,
    pub rebalance_count: u32,
    /// How stale the source filing can be, in days. 13F data runs up to 45.
    pub filing_delay_days: u16,
    /// Lamports parked at init to keep the vault rent-exempt. Excluded from
    /// net assets so it never shows up as depositor value.
    pub rent_reserve: u64,
    pub paused: bool,
    pub created_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
    pub mint_bump: u8,
}

impl Tracker {
    /// Lamports in the vault that actually belong to share holders.
    pub fn net_assets(&self, vault_lamports: u64) -> u64 {
        vault_lamports.saturating_sub(self.rent_reserve)
    }

    pub fn signer_seeds(&self) -> [&[u8]; 3] {
        [
            TRACKER_SEED,
            self.ticker.as_bytes(),
            std::slice::from_ref(&self.bump),
        ]
    }
}

pub fn validate_legs(legs: &[BasketLeg]) -> Result<()> {
    require!(!legs.is_empty(), VaultError::EmptyBasket);
    require!(legs.len() <= MAX_LEGS, VaultError::TooManyLegs);

    let mut total: u32 = 0;
    for leg in legs {
        require!(
            !leg.symbol.is_empty() && leg.symbol.len() <= MAX_SYMBOL_LEN,
            VaultError::InvalidSymbol
        );
        total = total
            .checked_add(u32::from(leg.weight_bps))
            .ok_or(VaultError::MathOverflow)?;
    }
    require!(
        total == BPS_DENOMINATOR as u32,
        VaultError::WeightsNotOneHundredPercent
    );
    Ok(())
}

/// `value * numerator / denominator` in u128, so a large vault cannot overflow
/// the intermediate product.
pub fn mul_div(value: u64, numerator: u64, denominator: u64) -> Result<u64> {
    require!(denominator != 0, VaultError::MathOverflow);
    let result = (value as u128)
        .checked_mul(numerator as u128)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(denominator as u128)
        .ok_or(VaultError::MathOverflow)?;
    u64::try_from(result).map_err(|_| VaultError::MathOverflow.into())
}

pub fn fee_on(amount: u64, bps: u16) -> Result<u64> {
    mul_div(amount, u64::from(bps), BPS_DENOMINATOR)
}
