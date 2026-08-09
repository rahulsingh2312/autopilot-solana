use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::error::VaultError;
use crate::state::{LegOracle, Tracker};

/// SOL trades continuously, so a stale SOL price means the feed is broken
/// rather than the market being shut. One minute is generous for a pull oracle.
pub const MAX_SOL_PRICE_AGE_SECS: u64 = 60;

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
/// Compiled in rather than stored on the `Tracker`. Adding a field would
/// change the account layout and force a migration of every tracker already
/// deployed — and the unit of account is a property of the program, not
/// something an individual tracker should get to choose.
pub const SOL_USD_FEED_ID: [u8; 32] =
    hex_literal_feed("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d");

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
pub fn leg_value_lamports(
    balance: u64,
    decimals: u8,
    multiplier_micros: u64,
    equity_price: i64,
    equity_exponent: i32,
    sol_price: i64,
    sol_exponent: i32,
) -> Result<u64> {
    require!(equity_price > 0 && sol_price > 0, VaultError::InvalidOraclePrice);

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
        numerator.checked_div(denominator).ok_or(VaultError::MathOverflow)?,
        equity_exponent
            .checked_sub(sol_exponent)
            .ok_or(VaultError::MathOverflow)?,
    )
    .ok_or(VaultError::MathOverflow)?;

    u64::try_from(scaled).map_err(|_| VaultError::MathOverflow.into())
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
        let without = leg_value_lamports(100_000_000, 8, 1_000_000, 18_000_000_000, E, 20_000_000_000, E)
            .unwrap();
        let with = leg_value_lamports(100_000_000, 8, 4_000_000, 18_000_000_000, E, 20_000_000_000, E)
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
        let a = leg_value_lamports(100_000_000, 8, 1_000_000, 18_000_000_000, -8, 20_000_000_000, -8)
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
}

/// Total value of a tracker's tokenized legs, in lamports.
///
/// `remaining_accounts` is, in basket order for each tokenized leg:
///
///   [0] the `LegOracle` PDA — carries the feed id, decimals, and multiplier
///   [1] the vault's token account for that leg
///   [2] the Pyth `PriceUpdateV2` for the underlying equity
///
/// preceded by a single SOL/USD `PriceUpdateV2` at index 0.
///
/// A tracker with no tokenized legs passes nothing and this returns zero,
/// which is exactly the behaviour the program had before valuation existed —
/// so devnet, where no leg is tokenized, is unaffected.
pub fn value_tokenized_legs<'info>(
    tracker: &Tracker,
    tracker_key: &Pubkey,
    vault: &Pubkey,
    remaining_accounts: &'info [AccountInfo<'info>],
) -> Result<u64> {
    let tokenized: Vec<&crate::state::BasketLeg> =
        tracker.legs.iter().filter(|leg| leg.is_tokenized()).collect();

    if tokenized.is_empty() {
        return Ok(0);
    }

    require!(
        remaining_accounts.len() == 1 + tokenized.len() * 3,
        VaultError::RemainingAccountsMismatch
    );

    let clock = Clock::get()?;

    let sol_update = Account::<PriceUpdateV2>::try_from(&remaining_accounts[0])?;
    // Checked against the compiled-in feed id, so passing some other Pyth
    // price account — a cheap token whose USD price flatters the vault — fails
    // rather than silently repricing every leg.
    let sol_price =
        sol_update.get_price_no_older_than(&clock, MAX_SOL_PRICE_AGE_SECS, &SOL_USD_FEED_ID)?;

    let mut total: u64 = 0;

    for (index, leg) in tokenized.iter().enumerate() {
        let base = 1 + index * 3;
        let oracle_info = &remaining_accounts[base];
        let token_info = &remaining_accounts[base + 1];
        let price_info = &remaining_accounts[base + 2];

        let leg_oracle = Account::<LegOracle>::try_from(oracle_info)?;
        require!(
            leg_oracle.mint == leg.mint && leg_oracle.tracker == *tracker_key,
            VaultError::OracleMintMismatch
        );

        // Interface account: xStocks are Token-2022, and the classic deserializer
        // rejects a mint carrying extensions.
        let token_account =
            InterfaceAccount::<anchor_spl::token_interface::TokenAccount>::try_from(token_info)?;
        require!(
            token_account.mint == leg.mint,
            VaultError::TokenAccountMintMismatch
        );
        require!(
            token_account.owner == *vault,
            VaultError::TokenAccountOwnerMismatch
        );

        let price_update = Account::<PriceUpdateV2>::try_from(price_info)?;
        let equity_price = price_update.get_price_no_older_than(
            &clock,
            MAX_EQUITY_PRICE_AGE_SECS,
            &leg_oracle.feed_id,
        )?;

        total = total
            .checked_add(leg_value_lamports(
                token_account.amount,
                leg_oracle.decimals,
                leg_oracle.multiplier_micros,
                equity_price.price,
                equity_price.exponent,
                sol_price.price,
                sol_price.exponent,
            )?)
            .ok_or(VaultError::MathOverflow)?;
    }

    Ok(total)
}
