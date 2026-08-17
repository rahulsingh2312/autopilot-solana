//! Error codes, pinned to the Anchor program's numbering.
//!
//! Anchor's `#[error_code]` starts custom errors at 6000 and numbers them in
//! declaration order. Those exact numbers are already mapped to human
//! sentences by `web/src/lib/vault/instructions.ts::explainTransactionError`,
//! so preserving them means the frontend's error copy keeps working against
//! this program with no changes at all.
//!
//! Codes 6000..=6030 are therefore frozen. New errors append from 6031.

use pinocchio::error::ProgramError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum VaultError {
    // ---- Frozen: must match the Anchor program's ordering exactly ----
    ZeroAmount = 6000,
    WeightsNotOneHundredPercent = 6001,
    TooManyLegs = 6002,
    EmptyBasket = 6003,
    InvalidTicker = 6004,
    InvalidName = 6005,
    InvalidSymbol = 6006,
    FeeTooHigh = 6007,
    TrackerPaused = 6008,
    EmptyVault = 6009,
    NoSharesOutstanding = 6010,
    DepositTooSmall = 6011,
    RedemptionTooSmall = 6012,
    MathOverflow = 6013,
    InsufficientVaultBalance = 6014,
    RemainingAccountsMismatch = 6015,
    TokenAccountMintMismatch = 6016,
    TokenAccountOwnerMismatch = 6017,
    SlippageExceeded = 6018,
    UnexpectedSwapProgram = 6019,
    EmptyRoute = 6020,
    SwapToSameMint = 6021,
    MintNotInBasket = 6022,
    SwapSpentTooMuch = 6023,
    SwapIncreasedSourceBalance = 6024,
    SharesStillOutstanding = 6025,
    TokenizedLegsRemain = 6026,
    InvalidOraclePrice = 6027,
    OracleMintMismatch = 6028,
    MultiplierOutOfRange = 6029,
    InvalidFeedId = 6030,
    InvalidAuthority = 6031,

    // ---- New in the Pinocchio port ----
    /// The account's type tag is not the one this instruction expects. Anchor
    /// got this free from its 8-byte discriminator; here it is explicit, and
    /// it is the check that prevents type confusion between a `Tracker` and a
    /// `LegOracle` passed at the same position.
    InvalidAccountTag = 6032,
    /// Account layout version this program does not know how to read.
    InvalidAccountVersion = 6033,
    /// Account data is shorter than the layout requires.
    AccountTooSmall = 6034,
    /// More legs than this tracker was sized for at initialization.
    LegCapacityExceeded = 6035,
    /// `max_legs` is zero or above the protocol ceiling.
    InvalidMaxLegs = 6036,
    /// Signer is not the tracker's `manager`.
    NotManager = 6037,
    /// Signer is not the tracker's `authority`.
    NotAuthority = 6038,
    /// A required signature was missing.
    MissingSigner = 6039,
    /// A passed account is not owned by the program that must own it.
    InvalidAccountOwner = 6040,
    /// A derived address did not match the account that was passed.
    SeedsMismatch = 6041,
    /// Instruction data was empty or shorter than the handler requires.
    MalformedInstructionData = 6042,
    /// Unknown instruction discriminator.
    UnknownInstruction = 6043,
    /// Handler exists in the layout but is not implemented yet.
    NotImplemented = 6044,
    /// An account the handler must write to was passed read-only.
    ///
    /// Split out from [`Self::InvalidAccountOwner`], which `require_writable`
    /// used to return. A writability problem reported as an ownership problem
    /// sends whoever is debugging it to look at the wrong thing entirely.
    NotWritable = 6045,
}

impl From<VaultError> for ProgramError {
    fn from(e: VaultError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
