//! The port's parsers, run against real mainnet account bytes.
//!
//! Every other test in this crate builds its own accounts, which proves the
//! parsers are self-consistent and nothing more. These run them against bytes
//! captured verbatim from mainnet-beta — the live NVDAx mint, and the live Pyth
//! SOL/USD and NVDA/USD price accounts — so a wrong offset or a mis-decoded
//! extension fails here rather than on the first real deposit.
//!
//! Captured with `getAccountInfo` and checked in under `tests/fixtures/`, with
//! `manifest.json` recording each address, owner and length. They are snapshots,
//! so prices in them are frozen; nothing below asserts on a *value* that moves,
//! only on structure, and on the multiplier, which changes on a published
//! schedule rather than continuously.

use autopilot_vault_pin::oracle::{
    leg_value_lamports, parse_price_update, PRICE_UPDATE_V2_DISCRIMINATOR, SOL_USD_FEED_ID,
};
use autopilot_vault_pin::token22::{
    has_permanent_delegate, has_transfer_fee, scaled_ui_multiplier_micros, EXT_PAUSABLE,
    EXT_SCALED_UI_AMOUNT, EXT_TRANSFER_HOOK, find_mint_extension,
};

const PYTH_SOL_USD: &[u8] = include_bytes!("fixtures/pyth_sol_usd.bin");
const PYTH_NVDA_USD: &[u8] = include_bytes!("fixtures/pyth_nvda_usd.bin");
const MINT_NVDAX: &[u8] = include_bytes!("fixtures/mint_nvdax.bin");

/// `b1073854…` — Pyth's `Equity.US.NVDA/USD`.
const NVDA_FEED_ID: [u8; 32] = [
    0xb1, 0x07, 0x38, 0x54, 0xed, 0x24, 0xcb, 0xc7, 0x55, 0xdc, 0x52, 0x74, 0x18, 0xf5, 0x2b, 0x7d,
    0x27, 0x1f, 0x6c, 0xc9, 0x67, 0xbb, 0xf8, 0xd8, 0x12, 0x91, 0x12, 0xb1, 0x88, 0x60, 0xa5, 0x93,
];

/// The moment a fixture was published, read out of the fixture itself.
///
/// Using this as "now" means staleness never fires for the structural tests,
/// without passing an absurd `max_age` — which is how the first version of this
/// file managed to hide a real bug: `u64::MAX as i64` is `-1`, so the staleness
/// check inverted and every price read as stale. The cast is `try_from` now,
/// and these tests no longer lean on a value that could mask it.
fn published_at(fixture: &[u8]) -> i64 {
    // price_message at 41 (Full), publish_time 52 bytes into it.
    i64::from_le_bytes(fixture[41 + 52..41 + 60].try_into().unwrap())
}

/// A generous but *representable* window: ten years.
const WIDE: u64 = 10 * 365 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Pyth
// ---------------------------------------------------------------------------

/// The discriminator this program compiles in must be the one mainnet uses.
/// It was computed as `sha256("account:PriceUpdateV2")[..8]`; this is the check
/// that the computation was right.
#[test]
fn the_real_accounts_carry_the_discriminator_we_pinned() {
    assert_eq!(&PYTH_SOL_USD[..8], &PRICE_UPDATE_V2_DISCRIMINATOR);
    assert_eq!(&PYTH_NVDA_USD[..8], &PRICE_UPDATE_V2_DISCRIMINATOR);
}

/// The layout assumption the whole parser rests on: mainnet's accounts are
/// `Full`, so `price_message` begins at the fixed offset 41.
///
/// If Pyth ever posts `Partial` updates for these feeds, this fails — which is
/// the correct outcome, because the parser refuses `Partial` rather than
/// reading it one byte out of alignment.
#[test]
fn the_real_accounts_are_fully_verified() {
    assert_eq!(PYTH_SOL_USD[40], 1, "SOL/USD verification_level");
    assert_eq!(PYTH_NVDA_USD[40], 1, "NVDA/USD verification_level");
}

/// The accounts are allocated at `PriceUpdateV2::LEN` (134) even though a
/// `Full` update serializes to 133. A parser that demanded an exact length
/// would reject every real account; this one requires only `>=`.
#[test]
fn the_real_accounts_are_allocated_at_max_length() {
    assert_eq!(PYTH_SOL_USD.len(), 134);
    assert_eq!(PYTH_NVDA_USD.len(), 134);
}

#[test]
fn reads_the_real_sol_usd_price() {
    let p = parse_price_update(PYTH_SOL_USD, &SOL_USD_FEED_ID, WIDE, published_at(PYTH_SOL_USD)).unwrap();
    assert_eq!(p.exponent, -8, "Pyth quotes SOL/USD at -8");
    assert!(p.price > 0, "price must be positive");
    // Sanity band rather than an exact value: the snapshot freezes a price, but
    // a parser reading the wrong offset produces something wildly outside this.
    let usd = p.price as f64 * 10f64.powi(p.exponent);
    assert!((1.0..10_000.0).contains(&usd), "SOL/USD decoded as ${usd}");
}

#[test]
fn reads_the_real_nvda_price() {
    let p =
        parse_price_update(PYTH_NVDA_USD, &NVDA_FEED_ID, WIDE, published_at(PYTH_NVDA_USD)).unwrap();
    let usd = p.price as f64 * 10f64.powi(p.exponent);
    assert!((1.0..100_000.0).contains(&usd), "NVDA decoded as ${usd}");
}

/// **The exponents differ between feeds, in production, right now.**
///
/// Pyth quotes SOL/USD at `-8` and `Equity.US.NVDA/USD` at `-5` — a factor of
/// one thousand. `leg_value_lamports` cancels `equity_exponent - sol_exponent`
/// precisely so this cannot matter; without that step every equity leg would be
/// mispriced by 1000x and the vault would mint accordingly.
///
/// The unit tests cover normalization with made-up exponents. This asserts the
/// mismatch is real, so nobody later "simplifies" the code on the assumption
/// that both sides are -8.
#[test]
fn the_real_feeds_do_not_share_an_exponent() {
    let sol =
        parse_price_update(PYTH_SOL_USD, &SOL_USD_FEED_ID, WIDE, published_at(PYTH_SOL_USD)).unwrap();
    let nvda =
        parse_price_update(PYTH_NVDA_USD, &NVDA_FEED_ID, WIDE, published_at(PYTH_NVDA_USD)).unwrap();
    assert_eq!(sol.exponent, -8, "SOL/USD");
    assert_eq!(nvda.exponent, -5, "Equity.US.NVDA/USD");
    assert_ne!(
        sol.exponent, nvda.exponent,
        "if these ever match, the normalization is still required — do not remove it"
    );
}

/// Passing the NVDA account where SOL/USD is expected must fail. This is the
/// check that stops a caller valuing the whole vault against a cheap feed.
#[test]
fn a_real_account_for_the_wrong_feed_is_refused() {
    assert!(parse_price_update(PYTH_NVDA_USD, &SOL_USD_FEED_ID, WIDE, published_at(PYTH_NVDA_USD)).is_err());
    assert!(parse_price_update(PYTH_SOL_USD, &NVDA_FEED_ID, WIDE, published_at(PYTH_SOL_USD)).is_err());
}

/// Staleness is enforced against real timestamps, not just synthetic ones.
#[test]
fn a_real_account_goes_stale() {
    let fresh =
        parse_price_update(PYTH_SOL_USD, &SOL_USD_FEED_ID, WIDE, published_at(PYTH_SOL_USD))
            .unwrap();
    let now = fresh.publish_time + 61;
    assert!(
        parse_price_update(PYTH_SOL_USD, &SOL_USD_FEED_ID, 60, now).is_err(),
        "60s window must reject a 61s-old price"
    );
    assert!(parse_price_update(PYTH_SOL_USD, &SOL_USD_FEED_ID, 60, fresh.publish_time + 60).is_ok());
}

/// Regression: an enormous `max_age` must not invert the staleness check.
///
/// `u64::MAX as i64` is `-1`, so the old cast made `publish_time + max_age`
/// go *backwards* and every price — including a fresh one — read as stale.
/// With `try_from` it saturates to `i64::MAX` and a huge window simply accepts
/// everything, which is what a huge window should mean.
#[test]
fn an_enormous_max_age_does_not_invert_the_staleness_check() {
    let at = published_at(PYTH_SOL_USD);
    assert!(
        parse_price_update(PYTH_SOL_USD, &SOL_USD_FEED_ID, u64::MAX, at).is_ok(),
        "u64::MAX must widen the window, not close it"
    );
    assert!(parse_price_update(PYTH_SOL_USD, &SOL_USD_FEED_ID, u64::MAX, at + 1_000_000).is_ok());
}

// ---------------------------------------------------------------------------
// The NVDAx mint
// ---------------------------------------------------------------------------

/// The finding that removed this program's only trusted input: the rebasing
/// multiplier is on the mint, so nothing has to push it over HTTP.
///
/// Asserted as a band rather than an exact number because it moves on a
/// published schedule. The band is tight enough that reading the wrong eight
/// bytes — or the `multiplier` field instead of the scheduled `new_multiplier`
/// — lands outside it.
#[test]
fn reads_the_rebasing_multiplier_off_the_real_mint() {
    let micros = scaled_ui_multiplier_micros(MINT_NVDAX, i64::MAX)
        .expect("NVDAx must carry ScaledUiAmount")
        .expect("multiplier must be valid");
    assert!(
        (1_000_000..1_100_000).contains(&micros),
        "expected a multiplier just above 1.0, got {micros} micros"
    );
}

/// Before its effective timestamp the *old* multiplier applies. Both values are
/// present in the fixture, so this proves the scheduled switch is honoured
/// rather than the first field being read unconditionally.
#[test]
fn honours_the_schedule_on_the_real_mint() {
    let cfg = find_mint_extension(MINT_NVDAX, EXT_SCALED_UI_AMOUNT).unwrap();
    let effective_at = i64::from_le_bytes(cfg[40..48].try_into().unwrap());

    let before = scaled_ui_multiplier_micros(MINT_NVDAX, effective_at - 1)
        .unwrap()
        .unwrap();
    let after = scaled_ui_multiplier_micros(MINT_NVDAX, effective_at)
        .unwrap()
        .unwrap();
    assert_ne!(before, after, "the scheduled change must actually change it");
}

/// Disclosure, asserted rather than assumed: the issuer can move or burn the
/// vault's entire holding of this mint without our signature. The vault's NAV
/// is contingent on Backed choosing not to.
#[test]
fn the_real_mint_has_a_permanent_delegate() {
    assert!(has_permanent_delegate(MINT_NVDAX));
}

/// No transfer fee today, which is what makes `redeem_in_kind`'s
/// compute-then-transfer sound. If this ever fails, that instruction needs
/// delta-aware accounting before it ships.
#[test]
fn the_real_mint_charges_no_transfer_fee() {
    assert!(!has_transfer_fee(MINT_NVDAX));
}

/// The transfer-hook slot exists but its program is the zero address, so no
/// hook runs. The authority is live though, so Backed can enable one — and the
/// day they do, every transfer path in this program needs extra accounts.
/// This test is the tripwire.
#[test]
fn the_real_mint_has_no_active_transfer_hook() {
    let hook = find_mint_extension(MINT_NVDAX, EXT_TRANSFER_HOOK)
        .expect("NVDAx carries the TransferHook extension");
    let program_id = &hook[32..64];
    assert_eq!(
        program_id,
        [0u8; 32],
        "a transfer hook has been enabled — swap_leg and redeem_in_kind must \
         now forward the hook's extra accounts or every transfer will fail"
    );
}

#[test]
fn the_real_mint_is_pausable() {
    let pausable = find_mint_extension(MINT_NVDAX, EXT_PAUSABLE).unwrap();
    // authority(32) || paused(1)
    assert_eq!(pausable[32], 0, "NVDAx is not currently paused");
}

// ---------------------------------------------------------------------------
// End to end, on real inputs
// ---------------------------------------------------------------------------

/// Value a real holding using real prices and the real multiplier.
///
/// One NVDAx has 8 decimals, so `100_000_000` base units is one token. The
/// assertion is that its value in SOL is within a wide but finite band — the
/// point is that every offset, exponent and scale line up well enough to
/// produce a sane number, which a single wrong field would not.
#[test]
fn values_one_real_nvdax_against_real_prices() {
    let sol = parse_price_update(PYTH_SOL_USD, &SOL_USD_FEED_ID, WIDE, published_at(PYTH_SOL_USD)).unwrap();
    let nvda = parse_price_update(PYTH_NVDA_USD, &NVDA_FEED_ID, WIDE, published_at(PYTH_NVDA_USD)).unwrap();
    let multiplier = scaled_ui_multiplier_micros(MINT_NVDAX, i64::MAX)
        .unwrap()
        .unwrap();

    let lamports = leg_value_lamports(
        100_000_000, // one NVDAx
        8,
        multiplier,
        nvda.price,
        nvda.exponent,
        sol.price,
        sol.exponent,
    )
    .unwrap();

    // Independently: NVDA_usd / SOL_usd, in SOL.
    let expected_sol =
        (nvda.price as f64 * 10f64.powi(nvda.exponent)) / (sol.price as f64 * 10f64.powi(sol.exponent));
    let got_sol = lamports as f64 / 1e9;
    let drift = (got_sol - expected_sol).abs() / expected_sol;

    // The multiplier is just above 1.0, so the two should agree closely. A 1%
    // tolerance absorbs it and the deliberate downward truncation without
    // admitting an off-by-a-factor error.
    assert!(
        drift < 0.01,
        "valuation {got_sol} SOL disagrees with {expected_sol} SOL by {:.4}",
        drift
    );
    assert!(lamports > 0);
}

/// A holding of nothing is worth nothing, even with real prices attached.
#[test]
fn an_empty_real_position_is_worth_nothing() {
    let sol = parse_price_update(PYTH_SOL_USD, &SOL_USD_FEED_ID, WIDE, published_at(PYTH_SOL_USD)).unwrap();
    let nvda = parse_price_update(PYTH_NVDA_USD, &NVDA_FEED_ID, WIDE, published_at(PYTH_NVDA_USD)).unwrap();
    let value = leg_value_lamports(0, 8, 1_000_000, nvda.price, nvda.exponent, sol.price, sol.exponent)
        .unwrap();
    assert_eq!(value, 0);
}
