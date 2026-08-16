//! Account layouts.
//!
//! Everything here is a hand-rolled little-endian byte layout read through
//! bounds-checked accessors. Three deliberate choices, each of which Anchor
//! made for us before and now has to be made on purpose:
//!
//! **Manual LE reads, not a pointer cast.** Zero-copy via `&mut T` would be
//! marginally cheaper but imposes alignment requirements on every field, and
//! account data is only guaranteed 8-byte aligned at offset 0. Reading through
//! `u64::from_le_bytes` costs a handful of compute units and removes an entire
//! class of undefined behaviour. For a program holding deposits that is not a
//! close call.
//!
//! **A 1-byte type tag instead of an 8-byte discriminator.** Anchor's 8 bytes
//! bought collision resistance against *other programs'* account types; the
//! owner check already provides that. What the tag has to prevent is confusion
//! between this program's own types — `Tracker` vs `LegOracle` — and one byte
//! distinguishes 256 of them. Checked on every load; see [`VaultError::InvalidAccountTag`].
//!
//! **`max_legs` fixed at initialization.** The account is sized for exactly
//! `max_legs` legs and never reallocated. Sizing it to the *current* leg count
//! would be a few bytes cheaper but would make `rebalance` a realloc-plus-rent
//! transfer — new failure modes in the one admin path that must never strand a
//! vault mid-update. A tracker that wants room to grow pays ~66 bytes per
//! spare slot, which is 0.00046 SOL.

use crate::constants::*;
use crate::error::VaultError;

pub type Address = [u8; 32];

pub const ZERO_ADDRESS: Address = [0u8; 32];

/// Account type tags. Frozen: changing a value reinterprets deployed accounts.
pub const TAG_TRACKER: u8 = 1;
pub const TAG_LEG_ORACLE: u8 = 2;

/// Layout version. Bump only for a change that deployed accounts cannot be
/// read under; additive changes should consume [`Tracker`]'s reserved bytes.
pub const LAYOUT_VERSION: u8 = 1;

/// What kind of book this tracker keeps.
///
/// Present from version 1 even though only one value is legal, because the
/// alternative is discovering later that every deployed account has to be
/// migrated to add it. A spot basket and, say, a strategy that writes options
/// have different NAV models — assets-only versus assets-minus-liabilities —
/// and the difference has to be legible on chain before a vault can hold both.
pub const STRATEGY_SPOT_BASKET: u8 = 0;

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

pub mod tracker {
    pub const TAG: usize = 0;
    pub const VERSION: usize = 1;
    pub const STRATEGY: usize = 2;
    pub const PAUSED: usize = 3;
    pub const BUMP: usize = 4;
    pub const VAULT_BUMP: usize = 5;
    pub const MINT_BUMP: usize = 6;
    pub const MAX_LEGS: usize = 7;
    pub const LEG_COUNT: usize = 8;
    pub const TICKER_LEN: usize = 9;
    pub const TICKER: usize = 10;
    pub const AUTHORITY: usize = 22;
    pub const MANAGER: usize = 54;
    pub const SHARE_MINT: usize = 86;
    pub const FEE_RECIPIENT: usize = 118;
    pub const RENT_RESERVE: usize = 150;
    pub const DEPOSIT_FEE_PPM: usize = 158;
    pub const REDEEM_FEE_PPM: usize = 160;
    /// Eight bytes held back so an additive field — another fee, a cadence, a
    /// flag word — does not force a version bump and a migration of every
    /// deployed tracker. This is the lesson `LegOracle` already encodes: the
    /// expensive thing is never the bytes, it is changing a layout that live
    /// vaults are already using.
    pub const RESERVED: usize = 162;
    pub const LEGS: usize = 170;

    pub const HEADER_LEN: usize = LEGS;
}

/// One position: the mint it is held as, its target weight, and the Pyth feed
/// that prices the underlying equity.
///
/// The Anchor layout carried a 16-byte `symbol` String here too. Nothing on
/// chain ever read it — only its length was validated — and it is already in
/// `web/src/lib/config.ts` and the Metaplex metadata. At 16 legs that string
/// was 256 bytes per tracker, the single largest piece of dead weight in the
/// account.
///
/// # Why `feed_id` lives here now
///
/// It used to sit in a separate `LegOracle` PDA, alongside a rebasing
/// multiplier that a worker pushed over HTTP. The original reasoning was sound
/// — weights move when a filing lands, the multiplier moves when a corporate
/// action settles, so they do not belong in one account.
///
/// But the multiplier never needed pushing: xStocks carry Token-2022's
/// **ScaledUiAmount** extension, so the authoritative value is readable
/// straight off the mint (verified against the live NVDAx and AAPLx mints; see
/// [`crate::token22`]). Once the multiplier is gone, all that remains is the
/// feed id, which by the old reasoning's own admission "essentially never
/// moves" — so it is plain configuration and belongs beside the weight.
///
/// That deletes an account type, its PDAs, and the program's only trusted
/// input, at a cost of 32 bytes per leg.
pub const LEG_SIZE: usize = 66;
pub const LEG_MINT: usize = 0;
pub const LEG_WEIGHT_BPS: usize = 32;
pub const LEG_FEED_ID: usize = 34;

/// One basket leg, as handlers pass it around.
///
/// A struct rather than a tuple because three positional fields — two of which
/// are 32-byte arrays — is exactly the shape that gets silently transposed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Leg {
    pub mint: Address,
    pub weight_bps: u16,
    /// Pyth feed id for the *underlying equity*, not for the token. Must be
    /// non-zero whenever `mint` is non-zero.
    pub feed_id: [u8; 32],
}

impl Leg {
    /// A leg whose name has no tokenized equivalent yet: its weight rides in
    /// the SOL sleeve and it is never valued through an oracle.
    pub const fn untokenized(weight_bps: u16) -> Self {
        Self {
            mint: ZERO_ADDRESS,
            weight_bps,
            feed_id: [0u8; 32],
        }
    }

    pub fn is_tokenized(&self) -> bool {
        self.mint != ZERO_ADDRESS
    }
}

/// What an instruction payload carries for one leg: **no feed id**.
///
/// # Why the feed id is not in the payload
///
/// It used to be, and it made 16-leg baskets impossible to send. A leg was 66
/// bytes on the wire, so sixteen of them is 1,058 bytes of instruction data —
/// past the 1,232-byte transaction limit once the signature, blockhash and
/// account keys are counted. `cgSOL` and `aiSOL` have sixteen legs each and
/// could be neither created nor rebalanced.
///
/// At 34 bytes the same basket is 546 bytes and fits with room to spare.
///
/// This also matches how the two fields actually behave, which is the argument
/// that should have decided it the first time: **weights move on every filing,
/// feed ids essentially never move.** They belong in different instructions.
/// [`TrackerMut::write_legs`] carries existing feed ids forward by mint, and
/// [`TrackerMut::set_leg_feed`] is how a new one is set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LegSpec {
    pub mint: Address,
    pub weight_bps: u16,
}

impl LegSpec {
    pub const fn untokenized(weight_bps: u16) -> Self {
        Self {
            mint: ZERO_ADDRESS,
            weight_bps,
        }
    }

    pub fn is_tokenized(&self) -> bool {
        self.mint != ZERO_ADDRESS
    }
}

/// Bytes one leg occupies in an instruction payload.
pub const LEG_SPEC_SIZE: usize = 34;

/// Bytes a tracker account holding `max_legs` legs occupies.
pub const fn tracker_size(max_legs: u8) -> usize {
    tracker::HEADER_LEN + (max_legs as usize) * LEG_SIZE
}

/// A read-only view over a tracker account's data.
pub struct Tracker<'a>(&'a [u8]);

impl<'a> Tracker<'a> {
    /// Validates tag, version, and that the data is long enough for the legs
    /// it claims to hold. Every accessor below is infallible because of this.
    pub fn load(data: &'a [u8]) -> Result<Self, VaultError> {
        if data.len() < tracker::HEADER_LEN {
            return Err(VaultError::AccountTooSmall);
        }
        if data[tracker::TAG] != TAG_TRACKER {
            return Err(VaultError::InvalidAccountTag);
        }
        if data[tracker::VERSION] != LAYOUT_VERSION {
            return Err(VaultError::InvalidAccountVersion);
        }
        let max_legs = data[tracker::MAX_LEGS];
        if max_legs == 0 || max_legs > MAX_LEGS {
            return Err(VaultError::InvalidMaxLegs);
        }
        if data.len() < tracker_size(max_legs) {
            return Err(VaultError::AccountTooSmall);
        }
        if data[tracker::LEG_COUNT] > max_legs {
            return Err(VaultError::LegCapacityExceeded);
        }
        if data[tracker::TICKER_LEN] as usize > MAX_TICKER_LEN
            || data[tracker::TICKER_LEN] == 0
        {
            return Err(VaultError::InvalidTicker);
        }
        Ok(Self(data))
    }

    #[inline]
    fn addr(&self, off: usize) -> Address {
        let mut out = [0u8; 32];
        out.copy_from_slice(&self.0[off..off + 32]);
        out
    }

    pub fn strategy(&self) -> u8 {
        self.0[tracker::STRATEGY]
    }
    pub fn paused(&self) -> bool {
        self.0[tracker::PAUSED] != 0
    }
    pub fn bump(&self) -> u8 {
        self.0[tracker::BUMP]
    }
    pub fn vault_bump(&self) -> u8 {
        self.0[tracker::VAULT_BUMP]
    }
    pub fn mint_bump(&self) -> u8 {
        self.0[tracker::MINT_BUMP]
    }
    pub fn max_legs(&self) -> u8 {
        self.0[tracker::MAX_LEGS]
    }
    pub fn leg_count(&self) -> u8 {
        self.0[tracker::LEG_COUNT]
    }

    /// The ticker is a PDA seed, so it is the one string that has to stay.
    pub fn ticker(&self) -> &'a [u8] {
        let len = self.0[tracker::TICKER_LEN] as usize;
        &self.0[tracker::TICKER..tracker::TICKER + len]
    }

    pub fn authority(&self) -> Address {
        self.addr(tracker::AUTHORITY)
    }
    pub fn manager(&self) -> Address {
        self.addr(tracker::MANAGER)
    }
    pub fn share_mint(&self) -> Address {
        self.addr(tracker::SHARE_MINT)
    }
    pub fn fee_recipient(&self) -> Address {
        self.addr(tracker::FEE_RECIPIENT)
    }

    pub fn rent_reserve(&self) -> u64 {
        read_u64(self.0, tracker::RENT_RESERVE)
    }
    pub fn deposit_fee_ppm(&self) -> u16 {
        read_u16(self.0, tracker::DEPOSIT_FEE_PPM)
    }
    pub fn redeem_fee_ppm(&self) -> u16 {
        read_u16(self.0, tracker::REDEEM_FEE_PPM)
    }

    pub fn leg_mint(&self, i: u8) -> Option<Address> {
        if i >= self.leg_count() {
            return None;
        }
        let off = tracker::LEGS + (i as usize) * LEG_SIZE + LEG_MINT;
        let mut out = [0u8; 32];
        out.copy_from_slice(&self.0[off..off + 32]);
        Some(out)
    }

    pub fn leg_weight_bps(&self, i: u8) -> Option<u16> {
        if i >= self.leg_count() {
            return None;
        }
        Some(read_u16(
            self.0,
            tracker::LEGS + (i as usize) * LEG_SIZE + LEG_WEIGHT_BPS,
        ))
    }

    /// Pyth feed id for this leg's underlying equity.
    pub fn leg_feed_id(&self, i: u8) -> Option<[u8; 32]> {
        if i >= self.leg_count() {
            return None;
        }
        let off = tracker::LEGS + (i as usize) * LEG_SIZE + LEG_FEED_ID;
        let mut out = [0u8; 32];
        out.copy_from_slice(&self.0[off..off + 32]);
        Some(out)
    }

    pub fn leg(&self, i: u8) -> Option<Leg> {
        Some(Leg {
            mint: self.leg_mint(i)?,
            weight_bps: self.leg_weight_bps(i)?,
            feed_id: self.leg_feed_id(i)?,
        })
    }

    /// `mint == ZERO_ADDRESS` means the underlying name has no tokenized
    /// equivalent, so its weight sits in the SOL sleeve rather than being
    /// silently dropped from the basket.
    pub fn leg_is_tokenized(&self, i: u8) -> bool {
        matches!(self.leg_mint(i), Some(m) if m != ZERO_ADDRESS)
    }

    pub fn tokenized_leg_count(&self) -> u8 {
        (0..self.leg_count()).filter(|i| self.leg_is_tokenized(*i)).count() as u8
    }

    /// Lamports in the vault that actually belong to share holders.
    ///
    /// Counts the SOL sleeve only. Once a vault holds tokenized equities the
    /// caller must add the oracle valuation on top, which is why deposit and
    /// redemption never call this directly.
    pub fn net_assets(&self, vault_lamports: u64) -> u64 {
        vault_lamports.saturating_sub(self.rent_reserve())
    }
}

/// A writable view. Separate type so a handler has to say, in its signature,
/// that it intends to mutate the account.
pub struct TrackerMut<'a>(&'a mut [u8]);

impl<'a> TrackerMut<'a> {
    /// For an already-initialized account.
    pub fn load(data: &'a mut [u8]) -> Result<Self, VaultError> {
        Tracker::load(data)?;
        Ok(Self(data))
    }

    /// For a freshly allocated, all-zero account. Writes the header fields
    /// that [`Tracker::load`] validates, so the account is loadable the moment
    /// this returns.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        data: &'a mut [u8],
        strategy: u8,
        max_legs: u8,
        ticker: &[u8],
        bump: u8,
        vault_bump: u8,
        mint_bump: u8,
    ) -> Result<Self, VaultError> {
        if max_legs == 0 || max_legs > MAX_LEGS {
            return Err(VaultError::InvalidMaxLegs);
        }
        if data.len() < tracker_size(max_legs) {
            return Err(VaultError::AccountTooSmall);
        }
        if ticker.is_empty() || ticker.len() > MAX_TICKER_LEN {
            return Err(VaultError::InvalidTicker);
        }
        if strategy != STRATEGY_SPOT_BASKET {
            return Err(VaultError::NotImplemented);
        }

        data[tracker::TAG] = TAG_TRACKER;
        data[tracker::VERSION] = LAYOUT_VERSION;
        data[tracker::STRATEGY] = strategy;
        data[tracker::PAUSED] = 0;
        data[tracker::BUMP] = bump;
        data[tracker::VAULT_BUMP] = vault_bump;
        data[tracker::MINT_BUMP] = mint_bump;
        data[tracker::MAX_LEGS] = max_legs;
        data[tracker::LEG_COUNT] = 0;
        data[tracker::TICKER_LEN] = ticker.len() as u8;
        data[tracker::TICKER..tracker::TICKER + ticker.len()].copy_from_slice(ticker);

        Ok(Self(data))
    }

    pub fn as_ref(&self) -> Tracker<'_> {
        Tracker(self.0)
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.0[tracker::PAUSED] = u8::from(paused);
    }
    pub fn set_authority(&mut self, a: &Address) {
        self.0[tracker::AUTHORITY..tracker::AUTHORITY + 32].copy_from_slice(a);
    }
    pub fn set_manager(&mut self, a: &Address) {
        self.0[tracker::MANAGER..tracker::MANAGER + 32].copy_from_slice(a);
    }
    pub fn set_share_mint(&mut self, a: &Address) {
        self.0[tracker::SHARE_MINT..tracker::SHARE_MINT + 32].copy_from_slice(a);
    }
    pub fn set_fee_recipient(&mut self, a: &Address) {
        self.0[tracker::FEE_RECIPIENT..tracker::FEE_RECIPIENT + 32].copy_from_slice(a);
    }
    pub fn set_rent_reserve(&mut self, v: u64) {
        write_u64(self.0, tracker::RENT_RESERVE, v);
    }

    /// Both fees at once, because the ceiling has to hold for the pair and
    /// checking them independently invites a caller that sets one and forgets.
    pub fn set_fees(&mut self, deposit_ppm: u16, redeem_ppm: u16) -> Result<(), VaultError> {
        if deposit_ppm > MAX_FEE_PPM || redeem_ppm > MAX_FEE_PPM {
            return Err(VaultError::FeeTooHigh);
        }
        write_u16(self.0, tracker::DEPOSIT_FEE_PPM, deposit_ppm);
        write_u16(self.0, tracker::REDEEM_FEE_PPM, redeem_ppm);
        Ok(())
    }

    /// Replace the basket wholesale.
    ///
    /// `legs` is `(mint, weight_bps)` in basket order. Validated before a
    /// single byte is written, so a rejected rebalance leaves the previous
    /// basket exactly as it was rather than half-overwritten.
    /// Replace the basket, carrying existing feed ids forward.
    ///
    /// A leg whose mint already appears in the current basket keeps the feed id
    /// configured for it; a mint that is new gets a zero feed id and needs
    /// [`Self::set_leg_feed`] before it can be valued. Without this carry-over,
    /// every routine reweighting would silently unconfigure every oracle.
    ///
    /// Valuation fails closed on a zero feed id — it can never match a real
    /// Pyth account — so an unconfigured leg makes deposits revert rather than
    /// mispricing them.
    pub fn write_legs(&mut self, specs: &[LegSpec]) -> Result<(), VaultError> {
        validate_legs(specs)?;
        if specs.len() > self.0[tracker::MAX_LEGS] as usize {
            return Err(VaultError::LegCapacityExceeded);
        }

        // Snapshot the current (mint, feed_id) pairs before anything is
        // overwritten; the new basket may reorder them.
        let previous_count = self.0[tracker::LEG_COUNT] as usize;
        let mut previous = [(ZERO_ADDRESS, [0u8; 32]); MAX_LEGS as usize];
        for (i, slot) in previous.iter_mut().enumerate().take(previous_count) {
            let off = tracker::LEGS + i * LEG_SIZE;
            let mut mint = [0u8; 32];
            mint.copy_from_slice(&self.0[off + LEG_MINT..off + LEG_MINT + 32]);
            let mut feed = [0u8; 32];
            feed.copy_from_slice(&self.0[off + LEG_FEED_ID..off + LEG_FEED_ID + 32]);
            *slot = (mint, feed);
        }

        for (i, spec) in specs.iter().enumerate() {
            let carried = previous[..previous_count]
                .iter()
                .find(|(mint, _)| *mint == spec.mint && spec.is_tokenized())
                .map(|(_, feed)| *feed)
                .unwrap_or([0u8; 32]);

            let off = tracker::LEGS + i * LEG_SIZE;
            self.0[off + LEG_MINT..off + LEG_MINT + 32].copy_from_slice(&spec.mint);
            write_u16(self.0, off + LEG_WEIGHT_BPS, spec.weight_bps);
            self.0[off + LEG_FEED_ID..off + LEG_FEED_ID + 32].copy_from_slice(&carried);
        }
        // Zero the tail so a shrinking basket leaves no readable remnant of
        // the old one past `leg_count`.
        let used = specs.len() * LEG_SIZE;
        let capacity = self.0[tracker::MAX_LEGS] as usize * LEG_SIZE;
        for b in &mut self.0[tracker::LEGS + used..tracker::LEGS + capacity] {
            *b = 0;
        }

        self.0[tracker::LEG_COUNT] = specs.len() as u8;
        Ok(())
    }

    /// Point one leg at a Pyth feed.
    ///
    /// Separate from `write_legs` because a feed id is configuration that
    /// outlives any particular basket — and because bundling the two is what
    /// made a full basket too large to send.
    pub fn set_leg_feed(&mut self, index: u8, feed_id: &[u8; 32]) -> Result<(), VaultError> {
        if index >= self.0[tracker::LEG_COUNT] {
            return Err(VaultError::LegCapacityExceeded);
        }
        let off = tracker::LEGS + (index as usize) * LEG_SIZE + LEG_FEED_ID;
        self.0[off..off + 32].copy_from_slice(feed_id);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Formerly: LegOracle
// ---------------------------------------------------------------------------
//
// A `LegOracle` PDA used to hold each leg's feed id, decimals, and a rebasing
// multiplier pushed over HTTP by the tracking worker. All three are gone:
//
// - **multiplier** — read from the mint's Token-2022 ScaledUiAmount extension
//   instead. See `crate::token22`. This removed the program's only trusted
//   input.
// - **decimals** — read from the mint, where it always was.
// - **feed_id** — moved into the tracker's leg entry, since it is plain
//   configuration that never changes.
//
// `TAG_LEG_ORACLE` is deliberately left reserved rather than reused: tag values
// are forever, and recycling one is how a future account type gets read as an
// account that no longer exists.

// ---------------------------------------------------------------------------
// Shared arithmetic
// ---------------------------------------------------------------------------

/// Weights must sum to exactly 10000 bps, and a basket must be non-empty.
///
/// `mint` is allowed to be the zero address — that is a leg with no tokenized
/// equivalent, whose weight rides in the SOL sleeve.
/// Weights must sum to exactly 10000 bps, and a basket must be non-empty.
///
/// Feed ids are deliberately **not** checked here: they no longer travel with
/// the basket, so a leg can legitimately be written before its feed is set.
/// The safety net is downstream — `value_tokenized_legs` compares the stored
/// feed id against the price account it was handed, and a zero feed id matches
/// no real Pyth account, so an unconfigured leg reverts a deposit instead of
/// mispricing one.
pub fn validate_legs(specs: &[LegSpec]) -> Result<(), VaultError> {
    if specs.is_empty() {
        return Err(VaultError::EmptyBasket);
    }
    if specs.len() > MAX_LEGS as usize {
        return Err(VaultError::TooManyLegs);
    }

    let mut total: u32 = 0;
    for spec in specs {
        total = total
            .checked_add(u32::from(spec.weight_bps))
            .ok_or(VaultError::MathOverflow)?;
    }
    if total != WEIGHT_DENOMINATOR {
        return Err(VaultError::WeightsNotOneHundredPercent);
    }
    Ok(())
}

/// `value * numerator / denominator` in u128, so a large vault cannot overflow
/// the intermediate product.
pub fn mul_div(value: u64, numerator: u64, denominator: u64) -> Result<u64, VaultError> {
    if denominator == 0 {
        return Err(VaultError::MathOverflow);
    }
    let result = (value as u128)
        .checked_mul(numerator as u128)
        .ok_or(VaultError::MathOverflow)?
        / (denominator as u128);
    u64::try_from(result).map_err(|_| VaultError::MathOverflow)
}

pub fn fee_on(amount: u64, ppm: u16) -> Result<u64, VaultError> {
    mul_div(amount, u64::from(ppm), FEE_DENOMINATOR)
}

// ---------------------------------------------------------------------------
// Little-endian primitives
// ---------------------------------------------------------------------------

#[inline]
fn read_u16(d: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([d[off], d[off + 1]])
}

#[inline]
fn read_u64(d: &[u8], off: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[off..off + 8]);
    u64::from_le_bytes(b)
}

#[inline]
fn write_u16(d: &mut [u8], off: usize, v: u16) {
    d[off..off + 2].copy_from_slice(&v.to_le_bytes());
}

#[inline]
fn write_u64(d: &mut [u8], off: usize, v: u64) {
    d[off..off + 8].copy_from_slice(&v.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(seed: u8) -> Address {
        let mut a = [0u8; 32];
        a[0] = seed;
        a
    }

    fn new_tracker(max_legs: u8) -> std::vec::Vec<u8> {
        let mut data = std::vec::Vec::new();
        data.resize(tracker_size(max_legs), 0u8);
        TrackerMut::initialize(&mut data, STRATEGY_SPOT_BASKET, max_legs, b"bwSOL", 254, 253, 252)
            .unwrap();
        data
    }

    /// The header is a published constant; a silent change to it would
    /// reinterpret every deployed account.
    #[test]
    fn header_layout_is_frozen() {
        assert_eq!(tracker::HEADER_LEN, 170);
        assert_eq!(LEG_SIZE, 66);
        assert_eq!(LEG_MINT, 0);
        assert_eq!(LEG_WEIGHT_BPS, 32);
        assert_eq!(LEG_FEED_ID, 34);
        assert_eq!(LEG_SPEC_SIZE, 34);
        // No field may overlap the one after it.
        assert!(tracker::TICKER + MAX_TICKER_LEN <= tracker::AUTHORITY);
        assert!(tracker::AUTHORITY + 32 <= tracker::MANAGER);
        assert!(tracker::MANAGER + 32 <= tracker::SHARE_MINT);
        assert!(tracker::SHARE_MINT + 32 <= tracker::FEE_RECIPIENT);
        assert!(tracker::FEE_RECIPIENT + 32 <= tracker::RENT_RESERVE);
        assert!(tracker::RENT_RESERVE + 8 <= tracker::DEPOSIT_FEE_PPM);
        assert!(tracker::DEPOSIT_FEE_PPM + 2 <= tracker::REDEEM_FEE_PPM);
        assert!(tracker::REDEEM_FEE_PPM + 2 <= tracker::RESERVED);
        assert!(tracker::RESERVED + 8 <= tracker::LEGS);
    }

    /// Cheaper than the Anchor layout — but the comparison has to be made on
    /// *total* footprint, not on the tracker account alone.
    ///
    /// Folding `feed_id` in made this account bigger than Anchor's at 16 legs
    /// (1226 vs 1022 bytes). That reads like a regression and is the opposite
    /// of one: Anchor also needed a separate 124-byte `LegOracle` PDA per
    /// tokenized leg, each carrying its own 128 bytes of account overhead. One
    /// larger account beats one account plus N small ones, because the overhead
    /// is per account and dwarfs the payload at this size.
    #[test]
    fn is_cheaper_than_the_anchor_layout_in_total() {
        /// `8 + Tracker::INIT_SPACE` in the Anchor program.
        const ANCHOR_TRACKER: usize = 1022;
        /// `8 + LegOracle::INIT_SPACE`, one per tokenized leg.
        const ANCHOR_LEG_ORACLE: usize = 124;

        assert_eq!(tracker_size(8), 698);
        assert_eq!(tracker_size(MAX_LEGS), 1226);

        // A realistic tracker: mg7SOL, seven tokenized legs.
        let legs = 7u64;
        let pin = rent_exempt_minimum(tracker_size(7) as u64);
        let anchor = rent_exempt_minimum(ANCHOR_TRACKER as u64)
            + legs * rent_exempt_minimum(ANCHOR_LEG_ORACLE as u64);

        assert!(
            pin * 3 < anchor,
            "expected a >3x saving, got pin={pin} anchor={anchor}"
        );
    }

    #[test]
    fn initializes_and_reads_back() {
        let data = new_tracker(8);
        let t = Tracker::load(&data).unwrap();
        assert_eq!(t.ticker(), b"bwSOL");
        assert_eq!(t.max_legs(), 8);
        assert_eq!(t.leg_count(), 0);
        assert_eq!(t.bump(), 254);
        assert_eq!(t.vault_bump(), 253);
        assert_eq!(t.mint_bump(), 252);
        assert_eq!(t.strategy(), STRATEGY_SPOT_BASKET);
        assert!(!t.paused());
    }

    /// A `LegOracle` passed where a `Tracker` belongs must be refused, not
    /// reinterpreted. This is the check Anchor's discriminator gave for free.
    #[test]
    fn rejects_a_wrong_account_type() {
        let mut data = new_tracker(4);
        data[tracker::TAG] = TAG_LEG_ORACLE;
        assert_eq!(Tracker::load(&data).err(), Some(VaultError::InvalidAccountTag));
    }

    #[test]
    fn rejects_an_unknown_version() {
        let mut data = new_tracker(4);
        data[tracker::VERSION] = 2;
        assert_eq!(Tracker::load(&data).err(), Some(VaultError::InvalidAccountVersion));
    }

    #[test]
    fn rejects_truncated_data() {
        let data = new_tracker(4);
        assert_eq!(Tracker::load(&data[..tracker::HEADER_LEN - 1]).err(), Some(VaultError::AccountTooSmall));
        // Header intact but the legs region is short of what max_legs claims.
        assert_eq!(Tracker::load(&data[..tracker::HEADER_LEN + LEG_SIZE]).err(), Some(VaultError::AccountTooSmall));
    }

    /// A corrupted `leg_count` must not let an accessor read past the legs
    /// region into whatever follows.
    #[test]
    fn rejects_leg_count_beyond_capacity() {
        let mut data = new_tracker(4);
        data[tracker::LEG_COUNT] = 5;
        assert_eq!(Tracker::load(&data).err(), Some(VaultError::LegCapacityExceeded));
    }

    /// A tokenized leg as an instruction payload carries it — mint and weight,
    /// no feed id. Feeds are set separately by `set_leg_feed`.
    fn leg(seed: u8, weight_bps: u16) -> LegSpec {
        LegSpec {
            mint: addr(seed),
            weight_bps,
        }
    }

    fn feed(seed: u8) -> [u8; 32] {
        [seed.wrapping_add(100); 32]
    }

    #[test]
    fn writes_and_reads_a_basket() {
        let mut data = new_tracker(8);
        {
            let mut t = TrackerMut::load(&mut data).unwrap();
            t.write_legs(&[leg(1, 6000), leg(2, 4000)]).unwrap();
        }
        let t = Tracker::load(&data).unwrap();
        assert_eq!(t.leg_count(), 2);
        assert_eq!(t.leg_mint(0), Some(addr(1)));
        assert_eq!(t.leg_weight_bps(1), Some(4000));
        assert_eq!(t.leg_mint(2), None, "reads past leg_count must return None");
    }

    /// The property that makes a 34-byte payload safe: a rebalance must not
    /// silently unconfigure every oracle it touches.
    #[test]
    fn a_rebalance_carries_feed_ids_forward_by_mint() {
        let mut data = new_tracker(8);
        {
            let mut t = TrackerMut::load(&mut data).unwrap();
            t.write_legs(&[leg(1, 6000), leg(2, 4000)]).unwrap();
            t.set_leg_feed(0, &feed(1)).unwrap();
            t.set_leg_feed(1, &feed(2)).unwrap();
        }
        {
            // Reweight, reorder, and add a new mint.
            let mut t = TrackerMut::load(&mut data).unwrap();
            t.write_legs(&[leg(2, 5000), leg(3, 3000), leg(1, 2000)])
                .unwrap();
        }
        let t = Tracker::load(&data).unwrap();
        assert_eq!(t.leg_feed_id(0), Some(feed(2)), "feed follows its mint");
        assert_eq!(t.leg_feed_id(1), Some([0u8; 32]), "a new mint starts unset");
        assert_eq!(t.leg_feed_id(2), Some(feed(1)), "even when reordered");
    }

    /// An untokenized leg never carries a feed, even if a zero mint appeared
    /// before — otherwise every sleeve leg would inherit whichever feed the
    /// previous zero-mint leg happened to hold.
    #[test]
    fn untokenized_legs_never_inherit_a_feed() {
        let mut data = new_tracker(4);
        let mut t = TrackerMut::load(&mut data).unwrap();
        t.write_legs(&[LegSpec::untokenized(10_000)]).unwrap();
        assert!(t.set_leg_feed(0, &feed(7)).is_ok());
        t.write_legs(&[LegSpec::untokenized(10_000)]).unwrap();
        assert_eq!(t.as_ref().leg_feed_id(0), Some([0u8; 32]));
    }

    #[test]
    fn set_leg_feed_refuses_an_index_past_the_basket() {
        let mut data = new_tracker(4);
        let mut t = TrackerMut::load(&mut data).unwrap();
        t.write_legs(&[leg(1, 10_000)]).unwrap();
        assert!(t.set_leg_feed(0, &feed(1)).is_ok());
        assert_eq!(
            t.set_leg_feed(1, &feed(1)),
            Err(VaultError::LegCapacityExceeded)
        );
    }

    #[test]
    fn weights_must_sum_to_one_hundred_percent() {
        let mut data = new_tracker(8);
        let mut t = TrackerMut::load(&mut data).unwrap();
        assert_eq!(
            t.write_legs(&[leg(1, 6000), leg(2, 3999)]),
            Err(VaultError::WeightsNotOneHundredPercent)
        );
        assert_eq!(t.write_legs(&[]), Err(VaultError::EmptyBasket));
    }

    /// A rejected rebalance must leave the previous basket untouched, not
    /// half-written.
    #[test]
    fn a_rejected_rebalance_does_not_corrupt_the_basket() {
        let mut data = new_tracker(8);
        {
            let mut t = TrackerMut::load(&mut data).unwrap();
            t.write_legs(&[leg(1, 10_000)]).unwrap();
            assert!(t.write_legs(&[leg(9, 5000), leg(8, 4000)]).is_err());
        }
        let t = Tracker::load(&data).unwrap();
        assert_eq!(t.leg_count(), 1);
        assert_eq!(t.leg_mint(0), Some(addr(1)));
        assert_eq!(t.leg_weight_bps(0), Some(10_000));
    }

    /// Shrinking a basket must not leave the dropped leg readable.
    #[test]
    fn shrinking_a_basket_clears_the_tail() {
        let mut data = new_tracker(8);
        {
            let mut t = TrackerMut::load(&mut data).unwrap();
            t.write_legs(&[leg(1, 5000), leg(2, 3000), leg(3, 2000)])
                .unwrap();
            t.write_legs(&[leg(4, 10_000)]).unwrap();
        }
        let stale = &data[tracker::LEGS + LEG_SIZE..tracker::LEGS + LEG_SIZE * 3];
        assert!(stale.iter().all(|b| *b == 0));
    }

    #[test]
    fn refuses_more_legs_than_the_account_was_sized_for() {
        let mut data = new_tracker(2);
        let mut t = TrackerMut::load(&mut data).unwrap();
        assert_eq!(
            t.write_legs(&[leg(1, 4000), leg(2, 3000), leg(3, 3000)]),
            Err(VaultError::LegCapacityExceeded)
        );
    }

    /// The zero mint is a leg with no tokenized equivalent — its weight rides
    /// in the SOL sleeve rather than being dropped from the basket.
    #[test]
    fn zero_mint_legs_are_untokenized_but_still_counted() {
        let mut data = new_tracker(4);
        {
            let mut t = TrackerMut::load(&mut data).unwrap();
            t.write_legs(&[leg(1, 6000), LegSpec::untokenized(4000)]).unwrap();
        }
        let t = Tracker::load(&data).unwrap();
        assert_eq!(t.leg_count(), 2);
        assert_eq!(t.tokenized_leg_count(), 1);
        assert!(t.leg_is_tokenized(0));
        assert!(!t.leg_is_tokenized(1));
    }

    #[test]
    fn fees_are_capped_in_the_layout_not_just_the_handler() {
        let mut data = new_tracker(4);
        let mut t = TrackerMut::load(&mut data).unwrap();
        assert_eq!(t.set_fees(MAX_FEE_PPM + 1, 0), Err(VaultError::FeeTooHigh));
        assert_eq!(t.set_fees(0, MAX_FEE_PPM + 1), Err(VaultError::FeeTooHigh));
        t.set_fees(10, 10).unwrap();
        assert_eq!(t.as_ref().deposit_fee_ppm(), 10);
    }

    /// The two roles are what make a creator-launched index safe: a manager
    /// can reposition the basket but cannot reach the vault.
    #[test]
    fn authority_and_manager_are_independent() {
        let mut data = new_tracker(4);
        {
            let mut t = TrackerMut::load(&mut data).unwrap();
            t.set_authority(&addr(0xAA));
            t.set_manager(&addr(0xBB));
        }
        let t = Tracker::load(&data).unwrap();
        assert_eq!(t.authority(), addr(0xAA));
        assert_eq!(t.manager(), addr(0xBB));
        assert_ne!(t.authority(), t.manager());
    }

    #[test]
    fn rent_reserve_is_excluded_from_net_assets() {
        let mut data = new_tracker(4);
        {
            let mut t = TrackerMut::load(&mut data).unwrap();
            t.set_rent_reserve(890_880);
        }
        let t = Tracker::load(&data).unwrap();
        assert_eq!(t.net_assets(1_000_000_000), 1_000_000_000 - 890_880);
        // Never underflows into a huge number.
        assert_eq!(t.net_assets(1000), 0);
    }

    #[test]
    fn mul_div_survives_a_large_vault() {
        assert_eq!(mul_div(u64::MAX, 1, 1).unwrap(), u64::MAX);
        assert_eq!(mul_div(1_000_000, 3, 4).unwrap(), 750_000);
        assert_eq!(mul_div(1, 1, 0), Err(VaultError::MathOverflow));
        // u128 intermediate: this would wrap in u64.
        assert_eq!(mul_div(u64::MAX, 2, 4).unwrap(), u64::MAX / 2);
    }

    #[test]
    fn fee_matches_the_ppm_denominator() {
        // 10 ppm is 0.001%, the fee every live tracker uses.
        assert_eq!(fee_on(1_000_000_000, 10).unwrap(), 10_000);
        assert_eq!(fee_on(1_000_000_000, MAX_FEE_PPM).unwrap(), 30_000_000);
    }

    #[test]
    fn rent_math_matches_the_runtime_formula() {
        // A data-less vault PDA: 128 bytes of overhead only.
        assert_eq!(rent_exempt_minimum(0), 890_880);
        assert_eq!(rent_exempt_minimum(tracker_size(8) as u64), 5_748_960);
    }
}
