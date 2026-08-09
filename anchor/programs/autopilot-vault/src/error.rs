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
    #[msg("Swap must be routed through the pinned Jupiter program")]
    UnexpectedSwapProgram,
    #[msg("Route data is empty")]
    EmptyRoute,
    #[msg("Source and destination mint are the same")]
    SwapToSameMint,
    #[msg("Destination mint is not a leg of the published basket")]
    MintNotInBasket,
    #[msg("Swap spent more than the caller offered")]
    SwapSpentTooMuch,
    #[msg("Swap increased the source balance")]
    SwapIncreasedSourceBalance,
    #[msg("Shares are still outstanding; holders must redeem before closing")]
    SharesStillOutstanding,
    #[msg("Tokenized legs must be sold to SOL before closing")]
    TokenizedLegsRemain,
    #[msg("Oracle reported a non-positive price")]
    InvalidOraclePrice,
    #[msg("Leg oracle does not match the leg it was passed for")]
    OracleMintMismatch,
    #[msg("Rebasing multiplier is outside the plausible range")]
    MultiplierOutOfRange,
    #[msg("Price feed id is empty")]
    InvalidFeedId,
    #[msg("New authority cannot be the default pubkey")]
    InvalidAuthority,
}
