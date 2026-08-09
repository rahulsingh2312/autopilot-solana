use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Basket weights must sum to exactly 10000 bps")]
    WeightsNotOneHundredPercent,
    #[msg("Basket has too many legs")]
    TooManyLegs,
    #[msg("Basket must have at least one leg")]
    EmptyBasket,
    #[msg("Ticker is empty or longer than the maximum length")]
    InvalidTicker,
    #[msg("Name is empty or longer than the maximum length")]
    InvalidName,
    #[msg("Leg symbol is empty or longer than the maximum length")]
    InvalidSymbol,
    #[msg("Fee exceeds the protocol maximum")]
    FeeTooHigh,
    #[msg("This tracker is paused")]
    TrackerPaused,
    #[msg("Vault holds no assets to price against")]
    EmptyVault,
    #[msg("Share supply is zero, nothing to redeem")]
    NoSharesOutstanding,
    #[msg("Deposit is too small to mint a whole share unit")]
    DepositTooSmall,
    #[msg("Redemption rounds down to zero lamports")]
    RedemptionTooSmall,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Vault would drop below its rent-exempt reserve")]
    InsufficientVaultBalance,
    #[msg("Expected a vault and holder token account for each tokenized leg")]
    RemainingAccountsMismatch,
    #[msg("Token account does not match the expected mint")]
    TokenAccountMintMismatch,
    #[msg("Token account is not owned by the expected authority")]
    TokenAccountOwnerMismatch,
    #[msg("Quote is worse than the caller's stated minimum")]
    SlippageExceeded,
}
