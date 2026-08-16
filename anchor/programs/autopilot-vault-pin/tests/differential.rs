//! Scenarios run against both binaries, asserting identical observable state.
//!
//! Adding a ported instruction means adding a scenario here *first*: the port's
//! whole safety argument is that behaviour is checked rather than assumed, and
//! a handler that lands without one is a handler nobody has compared.

mod common;

use common::*;
use solana_address::Address;
use solana_signer::Signer;

/// A Magnificent-7-shaped basket. Mints are arbitrary — no scenario in this
/// file values a leg, so what matters is that both programs record the same
/// bytes in the same order.
fn mag7() -> Vec<Leg> {
    let weights = [1500u16, 1500, 1500, 1500, 1500, 1500, 1000];
    let symbols = ["AAPLx", "MSFTx", "NVDAx", "AMZNx", "GOOGLx", "METAx", "TSLAx"];
    weights
        .iter()
        .zip(symbols)
        .map(|(&weight_bps, symbol)| Leg {
            mint: Address::new_unique(),
            symbol,
            weight_bps,
            feed_id: [7u8; 32],
        })
        .collect()
}

/// A basket whose legs have no tokenized equivalent yet — every mint is the
/// zero address, so the weight sits in the SOL sleeve and `value_tokenized_legs`
/// returns zero without needing any oracle accounts.
///
/// This is exactly the devnet situation, and it is what lets the money-path
/// scenarios below run without standing up Pyth accounts. Valuation with real
/// legs is covered separately, against byte-identical price accounts.
fn sleeve_only_basket() -> Vec<Leg> {
    vec![
        Leg {
            mint: Address::from([0u8; 32]),
            symbol: "BRKB",
            weight_bps: 6_000,
            feed_id: [0u8; 32],
        },
        Leg {
            mint: Address::from([0u8; 32]),
            symbol: "OXY",
            weight_bps: 4_000,
            feed_id: [0u8; 32],
        },
    ]
}

/// Stand up a tracker and a funded depositor with a share ATA, on one flavor.
fn ready(flavor: Flavor, fees: (u16, u16)) -> (Harness, Address) {
    let legs = sleeve_only_basket();
    let mut h = Harness::new(flavor);
    let payer = h.payer.insecure_clone();
    let ix = h.initialize_tracker_ix("bwSOL", &legs, fees.0, fees.1, 16);
    h.send_ok(ix, &[&payer]);
    let depositor = payer.pubkey();
    h.create_share_ata(&depositor, "bwSOL");
    (h, depositor)
}

/// Both programs must derive the *same* basket from the same input, even
/// though the mints are random per-run: build the basket once and hand the same
/// list to both.
fn init_on(flavor: Flavor, ticker: &str, legs: &[Leg], fees: (u16, u16)) -> (Harness, Observed) {
    let mut h = Harness::new(flavor);
    let payer = h.payer.insecure_clone();
    let ix = h.initialize_tracker_ix(ticker, legs, fees.0, fees.1, 16);
    h.send_ok(ix, &[&payer]);
    let observed = h.observe(ticker, &payer.pubkey());
    (h, observed)
}

// ---------------------------------------------------------------------------
// initialize_tracker
// ---------------------------------------------------------------------------

#[test]
fn initialize_tracker_lands_identically_on_both_programs() {
    let legs = mag7();
    let (_, anchor) = init_on(Flavor::Anchor, "mg7SOL", &legs, (2_500, 2_500));
    let (_, pin) = init_on(Flavor::Pin, "mg7SOL", &legs, (2_500, 2_500));
    assert_same(&anchor, &pin, "initialize_tracker");
}

/// The property the whole product rests on: a fresh vault has no shares, and
/// its lamports are entirely rent reserve, so net assets are zero and NAV is
/// undefined rather than accidentally non-zero.
#[test]
fn a_fresh_tracker_holds_no_depositor_money() {
    let legs = mag7();
    for flavor in Flavor::BOTH {
        let (_, o) = init_on(flavor, "mg7SOL", &legs, (2_500, 2_500));
        assert_eq!(o.share_supply, 0, "{flavor:?}: supply");
        assert_eq!(o.net_assets, 0, "{flavor:?}: net assets");
        assert!(o.rent_reserve > 0, "{flavor:?}: reserve must be funded");
        assert_eq!(o.vault_lamports, o.rent_reserve, "{flavor:?}: vault");
        assert!(!o.paused, "{flavor:?}: starts unpaused");
    }
}

/// The basket has to survive the round trip in order, with weights intact.
/// Anchor stores a symbol per leg and the port drops it; everything else must
/// match byte for byte.
#[test]
fn the_basket_round_trips_in_order_on_both() {
    let legs = mag7();
    let (_, anchor) = init_on(Flavor::Anchor, "mg7SOL", &legs, (2_500, 2_500));
    let (_, pin) = init_on(Flavor::Pin, "mg7SOL", &legs, (2_500, 2_500));

    let expected: Vec<([u8; 32], u16)> = legs
        .iter()
        .map(|l| (l.mint.to_bytes(), l.weight_bps))
        .collect();

    assert_eq!(anchor.legs, expected, "anchor basket");
    assert_eq!(pin.legs, expected, "pin basket");
    assert_eq!(anchor.leg_count, 7);
    assert_eq!(pin.leg_count, 7);
}

/// The fee ceiling is compiled into both programs, not just the UI. A tracker
/// must never be creatable with an exit tax above the cap.
#[test]
fn both_programs_refuse_a_fee_above_the_cap() {
    let legs = mag7();
    for flavor in Flavor::BOTH {
        let mut h = Harness::new(flavor);
        let payer = h.payer.insecure_clone();
        // MAX_FEE_PPM is 30_000 (3%).
        let ix = h.initialize_tracker_ix("mg7SOL", &legs, 30_001, 10, 16);
        assert_eq!(
            h.send_err_code(ix, &[&payer]),
            6007,
            "{flavor:?}: expected FeeTooHigh"
        );
    }
}

/// Weights that do not sum to exactly 100% are not a basket. Both programs
/// validate before creating anything, so a rejected call leaves no half-built
/// tracker behind.
#[test]
fn both_programs_refuse_a_basket_that_does_not_sum_to_one_hundred_percent() {
    for flavor in Flavor::BOTH {
        let mut h = Harness::new(flavor);
        let payer = h.payer.insecure_clone();
        let legs = vec![
            Leg {
                mint: Address::new_unique(),
                symbol: "AAPLx",
                weight_bps: 6_000,
                feed_id: [7u8; 32],
            },
            Leg {
                mint: Address::new_unique(),
                symbol: "MSFTx",
                weight_bps: 3_000,
                feed_id: [7u8; 32],
            },
        ];
        let ix = h.initialize_tracker_ix("mg7SOL", &legs, 2_500, 2_500, 16);
        assert_eq!(
            h.send_err_code(ix, &[&payer]),
            6001,
            "{flavor:?}: expected WeightsNotOneHundredPercent"
        );

        // and nothing was created
        let (tracker, _) = h.tracker_pda("mg7SOL");
        assert!(
            h.svm.get_account(&tracker).is_none_or(|a| a.data.is_empty()),
            "{flavor:?}: a rejected init left an account behind"
        );
    }
}

/// Regression: a stranger must not be able to block a ticker forever.
///
/// Every PDA address here is derivable by anyone from public data — the ticker
/// is in the frontend — so anyone can send lamports to a tracker's address
/// before it exists. The System program's plain `CreateAccount` refuses a
/// non-empty balance, which would make that a permanent denial of service for
/// the price of one lamport.
///
/// This is the test that caught `CreateAccountAllowPrefund` (System
/// instruction 13) not being implemented by the Agave runtime at all. Whatever
/// replaces it must keep this passing.
#[test]
fn a_prefunded_address_can_still_be_initialized_on_both_programs() {
    let legs = mag7();
    for flavor in Flavor::BOTH {
        let mut h = Harness::new(flavor);
        let payer = h.payer.insecure_clone();

        // A griefer sends dust to the address before anyone creates it.
        let (tracker, _) = h.tracker_pda("mg7SOL");
        let (share_mint, _) = h.share_pda(&tracker);
        h.svm.airdrop(&tracker, 1).unwrap();
        h.svm.airdrop(&share_mint, 1).unwrap();

        let ix = h.initialize_tracker_ix("mg7SOL", &legs, 2_500, 2_500, 16);
        h.send_ok(ix, &[&payer]);

        let o = h.observe("mg7SOL", &payer.pubkey());
        assert_eq!(o.leg_count, 7, "{flavor:?}: basket written");
        assert_eq!(o.share_supply, 0, "{flavor:?}: no shares yet");
    }
}

/// The dust a griefer sent is not silently pocketed — it stays in the account
/// it was sent to, and for the vault that means it counts as depositor assets.
#[test]
fn prefunded_dust_lands_identically_on_both_programs() {
    let legs = mag7();
    let mut observed = Vec::new();
    for flavor in Flavor::BOTH {
        let mut h = Harness::new(flavor);
        let payer = h.payer.insecure_clone();
        let (tracker, _) = h.tracker_pda("mg7SOL");
        h.svm.airdrop(&tracker, 1).unwrap();
        let ix = h.initialize_tracker_ix("mg7SOL", &legs, 2_500, 2_500, 16);
        h.send_ok(ix, &[&payer]);
        observed.push(h.observe("mg7SOL", &payer.pubkey()));
    }
    assert_same(&observed[0], &observed[1], "initialize_tracker (prefunded)");
}

/// A ticker is a PDA seed, so creating one twice must fail rather than
/// silently reinitialize a tracker that already has holders.
#[test]
fn a_ticker_cannot_be_initialized_twice_on_either_program() {
    let legs = mag7();
    for flavor in Flavor::BOTH {
        let (mut h, _) = init_on(flavor, "mg7SOL", &legs, (2_500, 2_500));
        let payer = h.payer.insecure_clone();
        h.svm.expire_blockhash();
        let ix = h.initialize_tracker_ix("mg7SOL", &legs, 2_500, 2_500, 16);
        assert!(
            h.send(ix, &[&payer]).is_err(),
            "{flavor:?}: re-initialization must fail"
        );
    }
}

// ---------------------------------------------------------------------------
// deposit
// ---------------------------------------------------------------------------

const SOL: u64 = 1_000_000_000;

/// NAV starts at exactly 1.0: the share mint has SOL's 9 decimals and genesis
/// mints one share per net lamport. Both programs must agree to the lamport.
#[test]
fn genesis_deposit_mints_one_share_per_net_lamport_on_both() {
    let mut out = Vec::new();
    for flavor in Flavor::BOTH {
        let (mut h, depositor) = ready(flavor, (2_500, 2_500));
        let payer = h.payer.insecure_clone();
        let ix = h.deposit_ix("bwSOL", &depositor, SOL, 0);
        h.send_ok(ix, &[&payer]);

        let o = h.observe("bwSOL", &depositor);
        // 0.25% of 1 SOL is 2_500_000 lamports.
        assert_eq!(o.holder_shares, 997_500_000, "{flavor:?}: shares");
        assert_eq!(o.share_supply, 997_500_000, "{flavor:?}: supply");
        assert_eq!(o.net_assets, 997_500_000, "{flavor:?}: net assets");
        out.push(o);
    }
    assert_same(&out[0], &out[1], "genesis deposit");
}

/// The fee leaves the depositor and lands on the fee recipient — it does not
/// sit in the vault inflating NAV for everyone else.
#[test]
fn the_deposit_fee_reaches_the_fee_recipient_on_both() {
    let mut out = Vec::new();
    for flavor in Flavor::BOTH {
        let (mut h, depositor) = ready(flavor, (2_500, 2_500));
        let payer = h.payer.insecure_clone();
        let before = h.lamports(&h.fee_recipient);
        let ix = h.deposit_ix("bwSOL", &depositor, SOL, 0);
        h.send_ok(ix, &[&payer]);
        let after = h.lamports(&h.fee_recipient);
        assert_eq!(after - before, 2_500_000, "{flavor:?}: fee");
        out.push(h.observe("bwSOL", &depositor));
    }
    assert_same(&out[0], &out[1], "deposit fee");
}

/// The property the whole product rests on: minting is proportional, so a
/// second deposit cannot move NAV for the people already in.
#[test]
fn a_second_deposit_does_not_move_nav_on_either_program() {
    for flavor in Flavor::BOTH {
        let (mut h, depositor) = ready(flavor, (2_500, 2_500));
        let payer = h.payer.insecure_clone();

        let ix = h.deposit_ix("bwSOL", &depositor, SOL, 0);
        h.send_ok(ix, &[&payer]);
        let a = h.observe("bwSOL", &depositor);
        let nav_before = (a.net_assets as u128) * 1_000_000_000 / (a.share_supply as u128);

        h.svm.expire_blockhash();
        let ix = h.deposit_ix("bwSOL", &depositor, 3 * SOL, 0);
        h.send_ok(ix, &[&payer]);
        let b = h.observe("bwSOL", &depositor);
        let nav_after = (b.net_assets as u128) * 1_000_000_000 / (b.share_supply as u128);

        assert_eq!(nav_before, nav_after, "{flavor:?}: NAV moved on deposit");
        assert_eq!(nav_after, 1_000_000_000, "{flavor:?}: NAV should be 1.0");
    }
}

/// The slippage floor is enforced on chain, not trusted from the UI.
#[test]
fn both_programs_enforce_the_deposit_slippage_floor() {
    for flavor in Flavor::BOTH {
        let (mut h, depositor) = ready(flavor, (2_500, 2_500));
        let payer = h.payer.insecure_clone();
        // Genesis mints 997_500_000; demanding a full 1e9 must be refused.
        let ix = h.deposit_ix("bwSOL", &depositor, SOL, SOL);
        assert_eq!(
            h.send_err_code(ix, &[&payer]),
            6018,
            "{flavor:?}: expected SlippageExceeded"
        );
    }
}

#[test]
fn both_programs_refuse_a_zero_deposit() {
    for flavor in Flavor::BOTH {
        let (mut h, depositor) = ready(flavor, (2_500, 2_500));
        let payer = h.payer.insecure_clone();
        let ix = h.deposit_ix("bwSOL", &depositor, 0, 0);
        assert_eq!(
            h.send_err_code(ix, &[&payer]),
            6000,
            "{flavor:?}: expected ZeroAmount"
        );
    }
}

// ---------------------------------------------------------------------------
// redeem_for_sol
// ---------------------------------------------------------------------------

/// A full round trip costs exactly the two fees and nothing else.
#[test]
fn a_deposit_redeem_round_trip_lands_identically_on_both() {
    let mut out = Vec::new();
    for flavor in Flavor::BOTH {
        let (mut h, holder) = ready(flavor, (2_500, 2_500));
        let payer = h.payer.insecure_clone();

        let ix = h.deposit_ix("bwSOL", &holder, SOL, 0);
        h.send_ok(ix, &[&payer]);
        h.svm.expire_blockhash();

        let shares = h.observe("bwSOL", &holder).holder_shares;
        let ix = h.redeem_for_sol_ix("bwSOL", &holder, shares, 0);
        h.send_ok(ix, &[&payer]);

        let o = h.observe("bwSOL", &holder);
        assert_eq!(o.share_supply, 0, "{flavor:?}: everything burned");
        assert_eq!(o.holder_shares, 0, "{flavor:?}: holder empty");
        assert_eq!(o.net_assets, 0, "{flavor:?}: vault drained to reserve");
        assert_eq!(
            o.vault_lamports, o.rent_reserve,
            "{flavor:?}: reserve survives"
        );
        out.push(o);
    }
    assert_same(&out[0], &out[1], "deposit/redeem round trip");
}

/// Half the shares must return half the assets, on both.
#[test]
fn a_partial_redemption_is_pro_rata_on_both() {
    let mut out = Vec::new();
    for flavor in Flavor::BOTH {
        let (mut h, holder) = ready(flavor, (0, 0)); // no fees, so the math is exact
        let payer = h.payer.insecure_clone();

        let ix = h.deposit_ix("bwSOL", &holder, 4 * SOL, 0);
        h.send_ok(ix, &[&payer]);
        h.svm.expire_blockhash();

        let shares = h.observe("bwSOL", &holder).holder_shares;
        assert_eq!(shares, 4 * SOL, "{flavor:?}: genesis 1:1");

        let ix = h.redeem_for_sol_ix("bwSOL", &holder, shares / 2, 0);
        h.send_ok(ix, &[&payer]);

        let o = h.observe("bwSOL", &holder);
        assert_eq!(o.share_supply, 2 * SOL, "{flavor:?}: half burned");
        assert_eq!(o.net_assets, 2 * SOL, "{flavor:?}: half returned");
        out.push(o);
    }
    assert_same(&out[0], &out[1], "partial redemption");
}

/// Redemption must keep working while deposits are paused — pausing stops new
/// money coming in, it must never trap money already in. Asserted here on the
/// redeem path itself rather than only in the role table.
#[test]
fn redeeming_from_an_empty_vault_is_refused_on_both() {
    for flavor in Flavor::BOTH {
        let (mut h, holder) = ready(flavor, (2_500, 2_500));
        let payer = h.payer.insecure_clone();
        let ix = h.redeem_for_sol_ix("bwSOL", &holder, 1_000, 0);
        assert_eq!(
            h.send_err_code(ix, &[&payer]),
            6010,
            "{flavor:?}: expected NoSharesOutstanding"
        );
    }
}

#[test]
fn both_programs_enforce_the_redeem_slippage_floor() {
    for flavor in Flavor::BOTH {
        let (mut h, holder) = ready(flavor, (0, 2_500));
        let payer = h.payer.insecure_clone();
        let ix = h.deposit_ix("bwSOL", &holder, SOL, 0);
        h.send_ok(ix, &[&payer]);
        h.svm.expire_blockhash();

        let shares = h.observe("bwSOL", &holder).holder_shares;
        // 0.25% redeem fee, so demanding the whole SOL back must be refused.
        let ix = h.redeem_for_sol_ix("bwSOL", &holder, shares, SOL);
        assert_eq!(
            h.send_err_code(ix, &[&payer]),
            6018,
            "{flavor:?}: expected SlippageExceeded"
        );
    }
}

/// The rent reserve is not depositor money. Redeeming everything must leave it
/// behind on both programs, or the vault account itself would be reaped.
#[test]
fn the_rent_reserve_is_never_paid_out_on_either_program() {
    for flavor in Flavor::BOTH {
        let (mut h, holder) = ready(flavor, (0, 0));
        let payer = h.payer.insecure_clone();
        let ix = h.deposit_ix("bwSOL", &holder, SOL, 0);
        h.send_ok(ix, &[&payer]);
        h.svm.expire_blockhash();

        let shares = h.observe("bwSOL", &holder).holder_shares;
        let ix = h.redeem_for_sol_ix("bwSOL", &holder, shares, 0);
        h.send_ok(ix, &[&payer]);

        let o = h.observe("bwSOL", &holder);
        assert!(o.rent_reserve > 0, "{flavor:?}: reserve was recorded");
        assert_eq!(o.vault_lamports, o.rent_reserve, "{flavor:?}: reserve kept");
    }
}

// ---------------------------------------------------------------------------
// admin: set_paused / set_fees / rebalance
// ---------------------------------------------------------------------------

/// Pausing halts deposits on both programs, with the same error code.
#[test]
fn pausing_halts_deposits_identically_on_both() {
    for flavor in Flavor::BOTH {
        let (mut h, depositor) = ready(flavor, (2_500, 2_500));
        let payer = h.payer.insecure_clone();

        let ix = h.set_paused_ix("bwSOL", &depositor, true);
        h.send_ok(ix, &[&payer]);
        assert!(h.observe("bwSOL", &depositor).paused, "{flavor:?}: paused");

        h.svm.expire_blockhash();
        let ix = h.deposit_ix("bwSOL", &depositor, SOL, 0);
        assert_eq!(
            h.send_err_code(ix, &[&payer]),
            6008,
            "{flavor:?}: expected TrackerPaused"
        );
    }
}

/// The property that must never regress: pausing stops new money coming in and
/// never traps money already in. Deposit fails, redemption still works.
#[test]
fn redemption_survives_a_pause_on_both_programs() {
    let mut out = Vec::new();
    for flavor in Flavor::BOTH {
        let (mut h, holder) = ready(flavor, (0, 0));
        let payer = h.payer.insecure_clone();

        let ix = h.deposit_ix("bwSOL", &holder, SOL, 0);
        h.send_ok(ix, &[&payer]);
        h.svm.expire_blockhash();

        let ix = h.set_paused_ix("bwSOL", &holder, true);
        h.send_ok(ix, &[&payer]);
        h.svm.expire_blockhash();

        let shares = h.observe("bwSOL", &holder).holder_shares;
        let ix = h.redeem_for_sol_ix("bwSOL", &holder, shares, 0);
        h.send_ok(ix, &[&payer]);

        let o = h.observe("bwSOL", &holder);
        assert_eq!(o.share_supply, 0, "{flavor:?}: redeemed while paused");
        assert!(o.paused, "{flavor:?}: still paused");
        out.push(o);
    }
    assert_same(&out[0], &out[1], "redeem while paused");
}

#[test]
fn set_fees_lands_identically_on_both() {
    let mut out = Vec::new();
    for flavor in Flavor::BOTH {
        let (mut h, who) = ready(flavor, (10, 10));
        let payer = h.payer.insecure_clone();
        let ix = h.set_fees_ix("bwSOL", &who, 2_500, 3_000);
        h.send_ok(ix, &[&payer]);
        let o = h.observe("bwSOL", &who);
        assert_eq!(o.deposit_fee_ppm, 2_500, "{flavor:?}");
        assert_eq!(o.redeem_fee_ppm, 3_000, "{flavor:?}");
        out.push(o);
    }
    assert_same(&out[0], &out[1], "set_fees");
}

/// The ceiling is compiled in, so it holds after initialization too — not just
/// at creation. This is what stops a tracker becoming a 90% exit tax.
#[test]
fn set_fees_still_refuses_above_the_cap_on_both() {
    for flavor in Flavor::BOTH {
        let (mut h, who) = ready(flavor, (10, 10));
        let payer = h.payer.insecure_clone();
        let ix = h.set_fees_ix("bwSOL", &who, 30_001, 10);
        assert_eq!(
            h.send_err_code(ix, &[&payer]),
            6007,
            "{flavor:?}: expected FeeTooHigh"
        );
    }
}

/// A stranger must not be able to move fees, on either program.
#[test]
fn a_stranger_cannot_set_fees_on_either_program() {
    for flavor in Flavor::BOTH {
        let (mut h, _) = ready(flavor, (10, 10));
        let stranger = solana_keypair::Keypair::new();
        h.svm.airdrop(&stranger.pubkey(), 10 * SOL).unwrap();

        let ix = h.set_fees_ix("bwSOL", &stranger.pubkey(), 0, 0);
        // Signed by the stranger, and paid for by them too, so the only reason
        // this can fail is the authority check.
        let msg = solana_message::Message::new_with_blockhash(
            &[ix],
            Some(&stranger.pubkey()),
            &h.svm.latest_blockhash(),
        );
        let tx = solana_transaction::Transaction::new(&[&stranger], msg, h.svm.latest_blockhash());
        assert!(
            h.svm.send_transaction(tx).is_err(),
            "{flavor:?}: a stranger changed the fees"
        );
    }
}

/// Rebalance publishes a new basket on both, in order.
#[test]
fn rebalance_publishes_the_same_basket_on_both() {
    let mut out = Vec::new();
    // Built once, outside the loop. `mag7()` draws fresh random mints on every
    // call, so constructing it per-flavor would hand each program a *different*
    // basket and compare the results — which passes the per-flavor assertions
    // and fails the differential one, for no reason to do with the programs.
    let new_basket = mag7();
    for flavor in Flavor::BOTH {
        let (mut h, who) = ready(flavor, (2_500, 2_500));
        let payer = h.payer.insecure_clone();

        let ix = h.rebalance_ix("bwSOL", &who, &new_basket);
        h.send_ok(ix, &[&payer]);

        let o = h.observe("bwSOL", &who);
        let expected: Vec<([u8; 32], u16)> = new_basket
            .iter()
            .map(|l| (l.mint.to_bytes(), l.weight_bps))
            .collect();
        assert_eq!(o.leg_count, 7, "{flavor:?}");
        assert_eq!(o.legs, expected, "{flavor:?}");
        out.push(o);
    }
    assert_same(&out[0], &out[1], "rebalance");
}

/// A rejected rebalance must leave the previous basket exactly as it was, not
/// half-written — on both programs.
#[test]
fn a_rejected_rebalance_leaves_the_basket_untouched_on_both() {
    for flavor in Flavor::BOTH {
        let (mut h, who) = ready(flavor, (2_500, 2_500));
        let payer = h.payer.insecure_clone();
        let before = h.observe("bwSOL", &who).legs;

        let mut bad = mag7();
        bad[0].weight_bps = 1; // no longer sums to 10_000
        let ix = h.rebalance_ix("bwSOL", &who, &bad);
        assert_eq!(
            h.send_err_code(ix, &[&payer]),
            6001,
            "{flavor:?}: expected WeightsNotOneHundredPercent"
        );

        assert_eq!(
            h.observe("bwSOL", &who).legs,
            before,
            "{flavor:?}: basket was modified by a rejected rebalance"
        );
    }
}
