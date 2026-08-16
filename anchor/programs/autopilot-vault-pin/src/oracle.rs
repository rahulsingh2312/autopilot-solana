//! Valuing tokenized equity legs, without the Pyth SDK.
//!
//! # The thing to be nervous about
//!
//! `MAINNET-PLAN.md` says, correctly, not to hand-roll the Pyth price-account
//! parse: it replaces an audited path with our own byte reading, in an
//! unaudited program.
//!
//! **That objection is not yet answered.** The parse below is unit-tested
//! against synthetic accounts — including the offset trap described further
//! down — but nothing has yet fed a *byte-identical* price account to both this
//! parser and `pyth-solana-receiver-sdk` and asserted the two value the same
//! vault at the same lamport. Until `tests/differential.rs` does exactly that
//! with a tokenized basket, this module is the least-verified code in the
//! program and the plan's warning stands in full.
//!
//! Treat that test as a mainnet gate, not a nice-to-have.
//!
//! # What Anchor's `Account<PriceUpdateV2>` was doing for us
//!
//! Six checks, every one of which is now explicit below. The first is the one
//! that matters: without the **owner** check, anyone can pass a system account
//! whose bytes they chose and name any price they like for any leg, which
//! mints them an unbounded number of shares.
//!
//! | Anchor | Here |
//! | --- | --- |
//! | `Account<T>` owner check | owner is the Pyth receiver program |
//! | `Account<T>` discriminator | first 8 bytes are `PriceUpdateV2`'s |
//! | borsh bounds checking | explicit length check before every read |
//! | `get_price_no_older_than` | verification level is `Full` |
//! | `get_price_unchecked` | `feed_id` equals the one we asked for |
//! | `get_price_no_older_than` | `publish_time + max_age >= now` |
//!
//! # The variable-offset trap
//!
//! `PriceUpdateV2.verification_level` is a borsh enum: `Partial { u8 }`
//! serializes to two bytes and `Full` to one. So `price_message` begins at a
//! *different offset* depending on the variant, and a fixed-offset parse reads
//! a price one byte out of alignment for one of the two cases — producing a
//! garbage number rather than an error.
//!
//! This code sidesteps it entirely by checking `Full` **first**. Anything else
//! is rejected before an offset is computed, so by the time the price is read
//! the layout is known to be the one-byte form and [`PRICE_MESSAGE`] is exact.
//! Do not "generalize" this to accept `Partial` without moving the offset.

use pinocchio::{AccountView, Address};

use crate::error::VaultError;
use crate::spl::{read_mint, read_token_account};
use crate::state::{Address as RawAddress, Tracker};
use crate::token22::scaled_ui_multiplier_micros;

/// SOL trades continuously, so a stale SOL price means the feed is broken
/// rather than the market being shut.
///
/// # Why 180 and not 60
///
/// 60 was chosen as "generous for a pull oracle" and is in fact **below the
/// oracle's own update interval**. Measured against mainnet, Pyth's SOL/USD
/// *push* account is rewritten roughly every 54 seconds, so its age sawtooths
/// between ~0 and ~72s. A 60-second window therefore rejects a perfectly
/// healthy price whenever a transaction lands in the tail of that interval —
/// deposits and SOL redemptions would fail intermittently on mainnet for no
/// reason connected to safety.
///
/// 180 clears the observed cadence with better than 2x margin while still
/// catching a feed that has genuinely stopped. The cost of the wider window is
/// that NAV can be priced against a SOL move of up to three minutes; the
/// deposit and redemption fees are the buffer against that, which is another
/// reason not to leave them at 10 ppm.
///
/// Measured, not guessed — see the note in `scripts/pin-fork-test.mjs`.
pub const MAX_SOL_PRICE_AGE_SECS: u64 = 180;

/// US equities trade roughly 6.5 hours a day, five days a week. Outside those
/// hours the last close *is* the correct valuation — that is how every mutual
/// fund prices overnight — so demanding a fresh tick would simply disable
/// deposits for two thirds of the week and all weekend.
///
/// Four days covers a Friday close through a Monday holiday. Beyond that the
/// price is genuinely suspect and pricing must fail rather than guess.
pub const MAX_EQUITY_PRICE_AGE_SECS: u64 = 4 * 24 * 60 * 60;

/// Fixed-point scale of `LegOracle::multiplier_micros`.
const MULTIPLIER_SCALE: u128 = 1_000_000;
const LAMPORTS_PER_SOL: u128 = 1_000_000_000;

/// Pyth's SOL/USD feed.
///
/// Compiled in rather than stored on the `Tracker`: the unit of account is a
/// property of the program, not something an individual tracker gets to pick.
pub const SOL_USD_FEED_ID: [u8; 32] =
    hex_literal_feed("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d");

/// `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` — the Pyth Solana receiver.
///
/// The non-`pro-compatible` id, which is the one deployed on mainnet-beta.
pub const PYTH_RECEIVER_ID: Address = Address::new_from_array([
    12, 183, 250, 187, 82, 247, 166, 72, 187, 91, 49, 125, 154, 1, 139, 144, 87, 203, 2, 71, 116,
    250, 254, 1, 230, 196, 223, 152, 204, 56, 88, 129,
]);

/// Anchor's account discriminator for `PriceUpdateV2`: `sha256("account:PriceUpdateV2")[..8]`.
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

/// `VerificationLevel::Full`'s borsh discriminant. `Partial` is 0.
const VERIFICATION_FULL: u8 = 1;

/// Offset of `verification_level`: 8 (discriminator) + 32 (write_authority).
const VERIFICATION_LEVEL: usize = 40;

/// Offset of `price_message`, valid **only** once the level is known to be
/// `Full` — see the module docs.
const PRICE_MESSAGE: usize = 41;

// Field offsets within `PriceFeedMessage`, relative to [`PRICE_MESSAGE`].
const PM_FEED_ID: usize = 0;
const PM_PRICE: usize = 32;
const PM_EXPONENT: usize = 48;
const PM_PUBLISH_TIME: usize = 52;
/// `feed_id(32) + price(8) + conf(8) + exponent(4) + publish_time(8)`. The
/// trailing `prev_publish_time`, `ema_price` and `ema_conf` are never read, so
/// the account only has to be long enough to reach here.
const PM_MIN_LEN: usize = 60;

/// `const fn` hex decode, so the feed id above stays readable as the hex
/// string Pyth publishes instead of a 32-element byte array nobody can check.
const fn hex_literal_feed(input: &str) -> [u8; 32] {
    let bytes = input.as_bytes();
    assert!(bytes.len() == 64, "feed id must be 64 hex characters");

    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (hex_nibble(bytes[i * 2]) << 4) | hex_nibble(bytes[i * 2 + 1]);
        i += 1;
    }
    out
}

const fn hex_nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("feed id contains a non-hex character"),
    }
}

// ---------------------------------------------------------------------------
// Reading a Pyth price account
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Price {
    pub price: i64,
    pub exponent: i32,
    pub publish_time: i64,
}

/// Parse the price out of `PriceUpdateV2` bytes, enforcing feed id, `Full`
/// verification, and staleness.
///
/// Split from [`read_price`] so the tests can drive it with synthetic bytes
/// without standing up an account.
pub fn parse_price_update(
    data: &[u8],
    expected_feed_id: &[u8; 32],
    max_age_secs: u64,
    now: i64,
) -> Result<Price, VaultError> {
    if data.len() < PRICE_MESSAGE + PM_MIN_LEN {
        return Err(VaultError::AccountTooSmall);
    }
    if data[..8] != PRICE_UPDATE_V2_DISCRIMINATOR {
        return Err(VaultError::InvalidAccountTag);
    }
    // Checked before any offset is computed. See the module docs: this is what
    // makes `PRICE_MESSAGE` a constant rather than a variable.
    if data[VERIFICATION_LEVEL] != VERIFICATION_FULL {
        return Err(VaultError::InvalidOraclePrice);
    }

    let base = PRICE_MESSAGE;
    if data[base + PM_FEED_ID..base + PM_FEED_ID + 32] != expected_feed_id[..] {
        return Err(VaultError::InvalidFeedId);
    }

    let price = i64::from_le_bytes(
        data[base + PM_PRICE..base + PM_PRICE + 8]
            .try_into()
            .map_err(|_| VaultError::AccountTooSmall)?,
    );
    let exponent = i32::from_le_bytes(
        data[base + PM_EXPONENT..base + PM_EXPONENT + 4]
            .try_into()
            .map_err(|_| VaultError::AccountTooSmall)?,
    );
    let publish_time = i64::from_le_bytes(
        data[base + PM_PUBLISH_TIME..base + PM_PUBLISH_TIME + 8]
            .try_into()
            .map_err(|_| VaultError::AccountTooSmall)?,
    );

    // Matches the SDK exactly, saturating included: `publish_time + max_age >= now`.
    // A price from the future is therefore accepted, as it is by the SDK — the
    // check is one-sided on purpose, because clock skew between the publisher
    // and the validator is normal and rejecting it would break pricing for
    // everyone rather than catching an attack.
    //
    // `try_from` rather than `as`: a `u64` above `i64::MAX` casts to a
    // *negative* number, which turns this comparison inside out and makes every
    // price look stale. The two constants this is called with are 60 and
    // 345_600 so it is not reachable today, but a silently inverted staleness
    // check is not something to leave depending on a caller's arithmetic.
    let max_age = i64::try_from(max_age_secs).unwrap_or(i64::MAX);
    if publish_time.saturating_add(max_age) < now {
        return Err(VaultError::InvalidOraclePrice);
    }

    Ok(Price {
        price,
        exponent,
        publish_time,
    })
}

/// Read a Pyth price account, checking it really is one.
///
/// The owner check is the load-bearing line. Without it every other check in
/// this file is checking attacker-supplied bytes against attacker-supplied
/// bytes.
pub fn read_price(
    account: &AccountView,
    expected_feed_id: &[u8; 32],
    max_age_secs: u64,
    now: i64,
) -> Result<Price, VaultError> {
    if !account.owned_by(&PYTH_RECEIVER_ID) {
        return Err(VaultError::InvalidAccountOwner);
    }
    let data = account
        .try_borrow()
        .map_err(|_| VaultError::InvalidAccountOwner)?;
    parse_price_update(&data, expected_feed_id, max_age_secs, now)
}

// ---------------------------------------------------------------------------
// Valuation
// ---------------------------------------------------------------------------

/// `value * 10^exp`, where a negative exponent divides. Returns None on
/// overflow rather than saturating: a silently clamped price would misprice a
/// deposit, which is worse than refusing to price it.
fn apply_exponent(value: u128, exp: i32) -> Option<u128> {
    if exp >= 0 {
        value.checked_mul(10u128.checked_pow(u32::try_from(exp).ok()?)?)
    } else {
        value.checked_div(10u128.checked_pow(u32::try_from(-exp).ok()?)?)
    }
}

/// Lamports one leg's holding is worth.
///
/// ```text
///            balance        multiplier      equity_usd
/// shares =  ---------  ×  ------------ ;  ------------  × 1e9  =  lamports
///           10^decimals        1e6          sol_usd
/// ```
///
/// The multiplier is the part everyone forgets. An xStock's claim is
/// `balance × multiplier` shares, because corporate actions rebase the token
/// rather than changing its supply — so a valuation that skips it drifts
/// quietly as splits and dividends accrue, always in the same direction.
#[allow(clippy::too_many_arguments)]
pub fn leg_value_lamports(
    balance: u64,
    decimals: u8,
    multiplier_micros: u64,
    equity_price: i64,
    equity_exponent: i32,
    sol_price: i64,
    sol_exponent: i32,
) -> Result<u64, VaultError> {
    if equity_price <= 0 || sol_price <= 0 {
        return Err(VaultError::InvalidOraclePrice);
    }

    if balance == 0 {
        return Ok(0);
    }

    // Operation order matters more than it looks. Multiplying everything up
    // front — balance × multiplier × price × 1e9 — reaches 1.8e40 for a vault
    // holding ten million shares, and u128 stops at 3.4e38. Dividing by the
    // token's own decimals first keeps every intermediate inside range for any
    // position this program could plausibly hold, and the checked arithmetic
    // means anything beyond that fails closed rather than wrapping.
    //
    // The early division truncates sub-base-unit dust, always downward. That
    // rounds in favour of existing holders rather than the incoming depositor,
    // which is the correct direction for a fund to err in.
    let effective_balance = (balance as u128)
        .checked_mul(multiplier_micros as u128)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(
            10u128
                .checked_pow(u32::from(decimals))
                .ok_or(VaultError::MathOverflow)?,
        )
        .ok_or(VaultError::MathOverflow)?;

    let numerator = effective_balance
        .checked_mul(equity_price as u128)
        .ok_or(VaultError::MathOverflow)?
        .checked_mul(LAMPORTS_PER_SOL)
        .ok_or(VaultError::MathOverflow)?;

    let denominator = MULTIPLIER_SCALE
        .checked_mul(sol_price as u128)
        .ok_or(VaultError::MathOverflow)?;

    // Both feeds are USD-quoted, so only the difference in their exponents
    // survives the division.
    let scaled = apply_exponent(
        numerator
            .checked_div(denominator)
            .ok_or(VaultError::MathOverflow)?,
        equity_exponent
            .checked_sub(sol_exponent)
            .ok_or(VaultError::MathOverflow)?,
    )
    .ok_or(VaultError::MathOverflow)?;

    u64::try_from(scaled).map_err(|_| VaultError::MathOverflow)
}

/// Total value of a tracker's tokenized legs, in lamports.
///
/// `remaining` is a single SOL/USD price account at index 0, then in basket
/// order for each tokenized leg:
///
/// ```text
///   [0] the leg's mint             — decimals, and the rebasing multiplier
///   [1] the vault's token account  — the actual holding
///   [2] the Pyth price account     — the underlying equity
/// ```
///
/// The feed id comes from the tracker's own leg entry, and the multiplier from
/// the mint's ScaledUiAmount extension, so there is no `LegOracle` and nothing
/// here depends on a value anyone pushed.
///
/// A tracker with no tokenized legs passes nothing and this returns zero,
/// which is what the program did before valuation existed — so devnet, where
/// no leg is tokenized, is unaffected.
///
/// # Ownership of the leg token accounts
///
/// Checked against the **vault** PDA. The Anchor program is inconsistent about
/// this: `swap_leg` and its own `oracle.rs` require the vault, while
/// `redeem_in_kind` requires the tracker and signs with tracker seeds. Those
/// cannot both hold — with real Token-2022 legs one of the two paths always
/// fails. Resolved to the vault here because that is what acquires the assets
/// and what values them; `redeem_in_kind` is the outlier and is ported to
/// match.
pub fn value_tokenized_legs(
    tracker: &Tracker,
    vault_key: &RawAddress,
    remaining: &[AccountView],
    now: i64,
) -> Result<u64, VaultError> {
    let tokenized = tracker.tokenized_leg_count();
    if tokenized == 0 {
        return Ok(0);
    }

    if remaining.len() != 1 + (tokenized as usize) * 3 {
        return Err(VaultError::RemainingAccountsMismatch);
    }

    // Checked against the compiled-in feed id, so passing some other Pyth price
    // account — a cheap token whose USD price flatters the vault — fails rather
    // than silently repricing every leg.
    let sol = read_price(
        &remaining[0],
        &SOL_USD_FEED_ID,
        MAX_SOL_PRICE_AGE_SECS,
        now,
    )?;

    let mut total: u64 = 0;
    // Walks the basket in order and counts tokenized legs as it goes, so the
    // Nth tokenized leg lines up with the Nth account triple regardless of
    // where the untokenized legs sit.
    let mut slot: usize = 0;

    for i in 0..tracker.leg_count() {
        let Some(leg) = tracker.leg(i) else { continue };
        if !leg.is_tokenized() {
            continue;
        }

        let base = 1 + slot * 3;
        slot += 1;

        let mint_ai = &remaining[base];
        let token_ai = &remaining[base + 1];
        let price_ai = &remaining[base + 2];

        // The mint account must be the exact mint this leg names, or a caller
        // could supply some other mint whose multiplier flatters the vault.
        if mint_ai.address().to_bytes() != leg.mint {
            return Err(VaultError::OracleMintMismatch);
        }

        // `read_mint` enforces that it is owned by a token program; without
        // that, the extension bytes below are attacker-chosen.
        let (_, decimals) = read_mint(mint_ai)?;
        let mint_data = mint_ai
            .try_borrow()
            .map_err(|_| VaultError::InvalidAccountOwner)?;

        // A mint with no ScaledUiAmount extension does not rebase, so its
        // multiplier is exactly 1.0 — not an error, just an ordinary SPL mint.
        let multiplier_micros = match scaled_ui_multiplier_micros(&mint_data, now) {
            Some(result) => result?,
            None => 1_000_000,
        };
        drop(mint_data);

        let (ta_mint, ta_owner, amount) = read_token_account(token_ai)?;
        if ta_mint != leg.mint {
            return Err(VaultError::TokenAccountMintMismatch);
        }
        if ta_owner != *vault_key {
            return Err(VaultError::TokenAccountOwnerMismatch);
        }

        let equity = read_price(price_ai, &leg.feed_id, MAX_EQUITY_PRICE_AGE_SECS, now)?;

        total = total
            .checked_add(leg_value_lamports(
                amount,
                decimals,
                multiplier_micros,
                equity.price,
                equity.exponent,
                sol.price,
                sol.exponent,
            )?)
            .ok_or(VaultError::MathOverflow)?;
    }

    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pyth quotes both feeds with a -8 exponent in practice.
    const E: i32 = -8;

    /// One NVDAx at $180, SOL at $200, multiplier 1.0 → 0.9 SOL.
    #[test]
    fn prices_a_single_share() {
        let value = leg_value_lamports(
            100_000_000, // 1.0 token, 8 decimals
            8,
            1_000_000, // 1.000000×
            18_000_000_000,
            E, // $180.00
            20_000_000_000,
            E, // $200.00
        )
        .unwrap();
        assert_eq!(value, 900_000_000); // 0.9 SOL
    }

    /// The multiplier is not decoration: a 4:1 split rebases the token to a
    /// 4× claim, and a valuation that ignores it reports a quarter of the
    /// truth. This is the single most expensive thing to get wrong here.
    #[test]
    fn multiplier_scales_the_claim() {
        let without =
            leg_value_lamports(100_000_000, 8, 1_000_000, 18_000_000_000, E, 20_000_000_000, E)
                .unwrap();
        let with =
            leg_value_lamports(100_000_000, 8, 4_000_000, 18_000_000_000, E, 20_000_000_000, E)
                .unwrap();
        assert_eq!(with, without * 4);
    }

    #[test]
    fn empty_position_is_worth_nothing() {
        let value =
            leg_value_lamports(0, 8, 1_000_000, 18_000_000_000, E, 20_000_000_000, E).unwrap();
        assert_eq!(value, 0);
    }

    /// Feeds with different exponents must still agree, or a routine Pyth
    /// precision change would silently reprice every vault by a factor of ten.
    #[test]
    fn exponents_are_normalized() {
        let a =
            leg_value_lamports(100_000_000, 8, 1_000_000, 18_000_000_000, -8, 20_000_000_000, -8)
                .unwrap();
        let b = leg_value_lamports(100_000_000, 8, 1_000_000, 180_000, -3, 200_000, -3).unwrap();
        assert_eq!(a, b);
    }

    /// A non-positive price is a broken feed, and pricing a deposit against it
    /// would be worse than refusing to price at all.
    #[test]
    fn rejects_non_positive_prices() {
        assert!(leg_value_lamports(1, 8, 1_000_000, 0, E, 20_000_000_000, E).is_err());
        assert!(leg_value_lamports(1, 8, 1_000_000, 18_000_000_000, E, -1, E).is_err());
    }

    /// A vault far larger than anything plausible must not overflow into a
    /// wrong number; u128 intermediates are what make that true.
    #[test]
    fn survives_an_implausibly_large_position() {
        let value = leg_value_lamports(
            1_000_000_000_000_000, // 10 million tokens
            8,
            1_000_000,
            18_000_000_000,
            E,
            20_000_000_000,
            E,
        )
        .unwrap();
        assert_eq!(value, 9_000_000_000_000_000);
    }

    #[test]
    fn sol_feed_id_decodes() {
        assert_eq!(SOL_USD_FEED_ID[0], 0xef);
        assert_eq!(SOL_USD_FEED_ID[31], 0x6d);
    }

    // ---- the hand-rolled parse ------------------------------------------

    /// Build a `PriceUpdateV2` account body the way the receiver program does.
    fn price_account(
        feed_id: &[u8; 32],
        price: i64,
        exponent: i32,
        publish_time: i64,
        full: bool,
    ) -> std::vec::Vec<u8> {
        let mut v = std::vec::Vec::new();
        v.extend_from_slice(&PRICE_UPDATE_V2_DISCRIMINATOR);
        v.extend_from_slice(&[7u8; 32]); // write_authority
        if full {
            v.push(VERIFICATION_FULL);
        } else {
            v.push(0); // Partial
            v.push(5); // num_signatures — the byte that shifts everything
        }
        v.extend_from_slice(feed_id);
        v.extend_from_slice(&price.to_le_bytes());
        v.extend_from_slice(&0u64.to_le_bytes()); // conf
        v.extend_from_slice(&exponent.to_le_bytes());
        v.extend_from_slice(&publish_time.to_le_bytes());
        v.extend_from_slice(&0i64.to_le_bytes()); // prev_publish_time
        v.extend_from_slice(&0i64.to_le_bytes()); // ema_price
        v.extend_from_slice(&0u64.to_le_bytes()); // ema_conf
        v.extend_from_slice(&0u64.to_le_bytes()); // posted_slot
        v
    }

    #[test]
    fn reads_a_well_formed_full_price() {
        let feed = SOL_USD_FEED_ID;
        let data = price_account(&feed, 20_000_000_000, -8, 1_000, true);
        let p = parse_price_update(&data, &feed, 60, 1_050).unwrap();
        assert_eq!(p.price, 20_000_000_000);
        assert_eq!(p.exponent, -8);
        assert_eq!(p.publish_time, 1_000);
    }

    /// The whole reason `Full` is checked before any offset is computed.
    /// A `Partial` update shifts `price_message` by one byte, so accepting it
    /// with these offsets would read a misaligned, meaningless price.
    #[test]
    fn rejects_a_partially_verified_update() {
        let feed = SOL_USD_FEED_ID;
        let data = price_account(&feed, 20_000_000_000, -8, 1_000, false);
        assert_eq!(
            parse_price_update(&data, &feed, 60, 1_050).err(),
            Some(VaultError::InvalidOraclePrice)
        );
    }

    /// Passing a price account for some other feed must fail, or a cheap
    /// token's USD price could be used to value NVDAx.
    #[test]
    fn rejects_a_mismatched_feed_id() {
        let data = price_account(&[9u8; 32], 20_000_000_000, -8, 1_000, true);
        assert_eq!(
            parse_price_update(&data, &SOL_USD_FEED_ID, 60, 1_050).err(),
            Some(VaultError::InvalidFeedId)
        );
    }

    #[test]
    fn rejects_a_stale_price() {
        let feed = SOL_USD_FEED_ID;
        let data = price_account(&feed, 20_000_000_000, -8, 1_000, true);
        // 1_000 + 60 = 1_060, so 1_061 is one second too late.
        assert!(parse_price_update(&data, &feed, 60, 1_060).is_ok());
        assert_eq!(
            parse_price_update(&data, &feed, 60, 1_061).err(),
            Some(VaultError::InvalidOraclePrice)
        );
    }

    /// A different Anchor account type — `TwapUpdate`, say — must not be read
    /// as a price just because it is owned by the same program.
    #[test]
    fn rejects_a_wrong_discriminator() {
        let feed = SOL_USD_FEED_ID;
        let mut data = price_account(&feed, 20_000_000_000, -8, 1_000, true);
        data[0] ^= 0xff;
        assert_eq!(
            parse_price_update(&data, &feed, 60, 1_050).err(),
            Some(VaultError::InvalidAccountTag)
        );
    }

    #[test]
    fn rejects_a_truncated_account() {
        let feed = SOL_USD_FEED_ID;
        let data = price_account(&feed, 20_000_000_000, -8, 1_000, true);
        for len in [0usize, 8, 40, PRICE_MESSAGE + PM_MIN_LEN - 1] {
            assert_eq!(
                parse_price_update(&data[..len], &feed, 60, 1_050).err(),
                Some(VaultError::AccountTooSmall),
                "len {len}"
            );
        }
    }

    /// The offsets are derived from `PriceUpdateV2::LEN` in the SDK:
    /// `8 + 32 + 2 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8 = 134`, where the `2`
    /// is the worst-case (`Partial`) verification level. A `Full` account is
    /// therefore one byte shorter.
    #[test]
    fn account_length_matches_the_sdk() {
        let full = price_account(&SOL_USD_FEED_ID, 1, 0, 0, true);
        let partial = price_account(&SOL_USD_FEED_ID, 1, 0, 0, false);
        assert_eq!(partial.len(), 134, "SDK PriceUpdateV2::LEN");
        assert_eq!(full.len(), 133);
        assert_eq!(full.len() + 1, partial.len(), "the one-byte shift");
    }
}
