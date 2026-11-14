//! Contract-level tests. The pure limit checks live next to the code they test, in
//! `allowance.rs` and `curve.rs`; these drive the public methods the way a wallet would.

use super::*;
use crate::curve::U256;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig, VMContext};

const PAD: &str = "pad.test";
const N: u128 = ONE_NEAR;
/// A fixed "now" in nanoseconds, and one hour.
const T0: u64 = 1_800_000_000_000_000_000;
const HOUR: u64 = 3_600_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(who: &str, yocto: u128, now: u64) -> VMContext {
    VMContextBuilder::new()
        .current_account_id(acc(PAD))
        .predecessor_account_id(acc(who))
        .attached_deposit(NearToken::from_yoctonear(yocto))
        .block_timestamp(now)
        .prepaid_gas(Gas::from_tgas(300))
        .build()
}

fn as_user(who: &str, yocto: u128, now: u64) {
    testing_env!(ctx(who, yocto, now));
}

/// The contract calling itself back with the result of a promise it started.
fn as_callback(result: PromiseResult, now: u64) {
    testing_env!(ctx(PAD, 0, now), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![result]);
}

/// NEAR sent to `who` by plain transfers during the current call.
fn paid_to(who: &str) -> u128 {
    get_created_receipts()
        .iter()
        .filter(|r| r.receiver_id.as_str() == who)
        .flat_map(|r| r.actions.iter())
        .map(|a| match a {
            MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
            _ => 0,
        })
        .sum()
}

/// A launchpad with one live token, FROG, launched by `dev.test`.
fn pad() -> CopyLaunch {
    as_user(PAD, 0, T0);
    let mut c = CopyLaunch::new();
    launch(&mut c, "frog", "dev.test");
    c
}

fn launch(c: &mut CopyLaunch, symbol: &str, creator: &str) {
    let cost = c.get_config().launch_cost.0;
    as_user(creator, cost, T0);
    c.launch(symbol.into(), "Frog".into(), Some("ribbit".into()), None).detach();
    as_callback(PromiseResult::Successful(vec![]), T0);
    assert!(c.on_launch(symbol.into(), acc(creator), U128(cost)));
}

/// `follower` follows `creator`: `total` held as the cap, `per_trade` per copy, ending at `expires`.
fn follow(c: &mut CopyLaunch, follower: &str, creator: &str, total: u128, per_trade: u128, expires: u64, now: u64) -> AllowanceView {
    as_user(follower, total + FOLLOW_STORAGE_FEE, now);
    c.follow(acc(creator), U128(per_trade), U64(expires / 1_000_000), MAX_FEE_BPS)
}

fn buy(c: &mut CopyLaunch, who: &str, near: u128, now: u64) -> Trade {
    as_user(who, near, now);
    c.buy("frog".into(), U128(0))
}

fn sell(c: &mut CopyLaunch, who: &str, tokens: u128, now: u64) -> Trade {
    as_user(who, 1, now);
    c.sell("frog".into(), U128(tokens), U128(0))
}

fn allowance(c: &CopyLaunch, follower: &str, creator: &str) -> AllowanceView {
    c.get_allowance(acc(follower), acc(creator)).expect("allowance exists")
}

fn bal(c: &CopyLaunch, who: &str) -> u128 {
    c.get_balance("frog".into(), acc(who)).0
}

// ---- the allowance, enforced through the public methods ---------------------------------------

#[test]
fn following_holds_the_total_cap_and_records_every_limit() {
    let mut c = pad();
    let a = follow(&mut c, "fan.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    assert_eq!(a.total_cap.0, 5 * N);
    assert_eq!(a.remaining.0, 5 * N);
    assert_eq!(a.spent.0, 0);
    assert_eq!(a.per_trade_cap.0, 2 * N);
    assert_eq!(a.expires_at_ms, (T0 + HOUR) / 1_000_000);
    assert_eq!(a.fee_bps, DEFAULT_FEE_BPS);
    assert!(!a.expired);
    assert_eq!(c.get_totals().allowances.0, 5 * N);
    assert_eq!(c.get_followers(acc("dev.test")).len(), 1);
    assert_eq!(c.get_following(acc("fan.test")).len(), 1);
}

#[test]
fn a_copy_is_cut_down_to_the_per_trade_cap() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    let t = buy(&mut c, "dev.test", 4 * N, T0 + 1);
    assert_eq!(t.copies.len(), 1);
    assert_eq!(t.copies[0].near.0, 2 * N, "the creator bought 4, the cap per trade is 2");
    assert_eq!(allowance(&c, "fan.test", "dev.test").spent.0, 2 * N);
    assert_eq!(allowance(&c, "fan.test", "dev.test").copies, 1);
}

#[test]
fn a_copy_is_no_bigger_than_the_creators_own_buy() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    let t = buy(&mut c, "dev.test", N / 2, T0 + 1);
    assert_eq!(t.copies[0].near.0, N / 2);
}

#[test]
fn copies_stop_at_the_total_cap_and_never_go_over_it() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    let spent: Vec<u128> = (1..=5).map(|i| buy(&mut c, "dev.test", 3 * N, T0 + i).copies.iter().map(|f| f.near.0).sum()).collect();
    // 2 + 2 + 1 (what was left), then nothing.
    assert_eq!(spent, vec![2 * N, 2 * N, N, 0, 0]);
    let a = allowance(&c, "fan.test", "dev.test");
    assert_eq!(a.spent.0, a.total_cap.0);
    assert_eq!(a.remaining.0, 0);
    assert_eq!(a.copies, 3);
    assert_eq!(c.get_totals().allowances.0, 0);
}

#[test]
fn a_remainder_too_small_to_copy_stays_in_the_allowance() {
    let mut c = pad();
    // 0.12 total, 0.1 per trade: after one copy 0.02 is left, under the 0.05 minimum.
    follow(&mut c, "fan.test", "dev.test", N * 12 / 100, N / 10, T0 + HOUR, T0);
    assert_eq!(buy(&mut c, "dev.test", N, T0 + 1).copies.len(), 1);
    assert_eq!(buy(&mut c, "dev.test", N, T0 + 2).copies.len(), 0);
    assert_eq!(allowance(&c, "fan.test", "dev.test").remaining.0, N * 2 / 100);
    // The follower gets it back by revoking.
    as_user("fan.test", 1, T0 + 3);
    assert_eq!(c.revoke(acc("dev.test")).0, N * 2 / 100);
}

#[test]
fn an_expired_allowance_copies_nothing_and_is_closed_with_the_rest_claimable() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    buy(&mut c, "dev.test", N, T0 + 1); // one copy of 1 NEAR while it is live
    let held = bal(&c, "fan.test");

    let t = buy(&mut c, "dev.test", N, T0 + HOUR); // exactly at the expiry time
    assert!(t.copies.is_empty(), "nothing is spent from an expired allowance");
    assert_eq!(t.closed.len(), 1);
    assert_eq!(t.closed[0].follower, acc("fan.test"));
    assert_eq!(t.closed[0].refunded.0, 4 * N);
    assert_eq!(t.closed[0].reason, "expired");
    assert_eq!(bal(&c, "fan.test"), held, "the follower's tokens did not change");
    assert!(c.get_allowance(acc("fan.test"), acc("dev.test")).is_none());
    assert!(c.get_followers(acc("dev.test")).is_empty());
    assert_eq!(c.get_claimable(acc("fan.test")).0, 4 * N);
    assert_eq!(c.get_totals().allowances.0, 0);

    as_user("fan.test", 1, T0 + HOUR + 1);
    assert_eq!(c.claim().0, 4 * N);
    assert_eq!(paid_to("fan.test"), 4 * N + 1);
}

#[test]
fn one_nanosecond_before_expiry_the_copy_still_happens() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    assert_eq!(buy(&mut c, "dev.test", N, T0 + HOUR - 1).copies.len(), 1);
}

#[test]
fn revoking_sends_the_unspent_near_back_and_ends_the_copying() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    buy(&mut c, "dev.test", 2 * N, T0 + 1);
    let held = bal(&c, "fan.test");

    as_user("fan.test", 1, T0 + 2);
    assert_eq!(c.revoke(acc("dev.test")).0, 3 * N);
    assert_eq!(paid_to("fan.test"), 3 * N + 1, "unspent NEAR plus the attached yocto, in the same call");
    assert!(c.get_allowance(acc("fan.test"), acc("dev.test")).is_none());
    assert!(c.get_following(acc("fan.test")).is_empty());
    assert_eq!(c.get_totals().allowances.0, 0);

    let t = buy(&mut c, "dev.test", 2 * N, T0 + 3);
    assert!(t.copies.is_empty() && t.closed.is_empty());
    assert_eq!(bal(&c, "fan.test"), held, "tokens already bought stay with the follower");
}

#[test]
fn an_expired_allowance_can_still_be_revoked_for_its_unspent_near() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    as_user("fan.test", 1, T0 + 2 * HOUR);
    assert_eq!(c.revoke(acc("dev.test")).0, 5 * N);
}

#[test]
#[should_panic(expected = "you do not follow this creator")]
fn nobody_can_revoke_an_allowance_they_did_not_grant() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    as_user("thief.test", 1, T0 + 1);
    c.revoke(acc("dev.test"));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn revoking_needs_a_full_access_signature() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    as_user("fan.test", 0, T0 + 1);
    c.revoke(acc("dev.test"));
}

#[test]
#[should_panic(expected = "the per-trade cap cannot be larger than the total cap")]
fn a_per_trade_cap_above_the_total_cap_is_refused() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", N, 2 * N, T0 + HOUR, T0);
}

#[test]
#[should_panic(expected = "the per-trade cap must be at least 0.05 NEAR")]
fn a_per_trade_cap_below_the_minimum_is_refused() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", N, MIN_COPY - 1, T0 + HOUR, T0);
}

#[test]
#[should_panic(expected = "attach the total cap")]
fn a_follow_with_no_cap_attached_is_refused() {
    let mut c = pad();
    as_user("fan.test", FOLLOW_STORAGE_FEE, T0);
    c.follow(acc("dev.test"), U128(MIN_COPY), U64((T0 + HOUR) / 1_000_000), MAX_FEE_BPS);
}

#[test]
#[should_panic(expected = "the expiry must be in the future")]
fn an_expiry_in_the_past_is_refused() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", N, N, T0, T0);
}

#[test]
#[should_panic(expected = "at most 365 days")]
fn an_expiry_more_than_a_year_away_is_refused() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", N, N, T0 + MAX_ALLOWANCE_NS + 1_000_000, T0);
}

#[test]
#[should_panic(expected = "you cannot follow yourself")]
fn following_yourself_is_refused() {
    let mut c = pad();
    follow(&mut c, "dev.test", "dev.test", N, N, T0 + HOUR, T0);
}

#[test]
#[should_panic(expected = "you already follow this creator")]
fn a_second_allowance_for_the_same_creator_is_refused() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", N, N, T0 + HOUR, T0);
    follow(&mut c, "fan.test", "dev.test", N, N, T0 + HOUR, T0);
}

#[test]
#[should_panic(expected = "this creator already has the most followers")]
fn a_creator_cannot_have_more_followers_than_one_trade_can_carry() {
    let mut c = pad();
    for i in 0..=MAX_FOLLOWERS {
        follow(&mut c, &format!("fan{i}.test"), "dev.test", N, N, T0 + HOUR, T0);
    }
}

#[test]
#[should_panic(expected = "you already follow the most creators")]
fn an_account_cannot_follow_more_creators_than_the_limit() {
    let mut c = pad();
    for i in 0..=MAX_FOLLOWING {
        follow(&mut c, "fan.test", &format!("dev{i}.test"), N, N, T0 + HOUR, T0);
    }
}

#[test]
fn revoking_and_following_again_starts_a_new_allowance_from_zero() {
    let mut c = pad();
    let first = follow(&mut c, "fan.test", "dev.test", 2 * N, N, T0 + HOUR, T0);
    buy(&mut c, "dev.test", N, T0 + 1);
    as_user("fan.test", 1, T0 + 2);
    c.revoke(acc("dev.test"));
    let second = follow(&mut c, "fan.test", "dev.test", 3 * N, N, T0 + HOUR, T0 + 3);
    assert!(second.id > first.id);
    assert_eq!(second.spent.0, 0);
    assert_eq!(c.get_copied(acc("fan.test"), acc("dev.test"), "frog".into()).0, 0, "the old copies are not tracked by the new allowance");
}

// ---- one price for the creator and the followers ----------------------------------------------

#[test]
fn the_creator_and_every_follower_buy_at_the_same_price() {
    let mut c = pad();
    follow(&mut c, "fan1.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    follow(&mut c, "fan2.test", "dev.test", 5 * N, N / 2, T0 + HOUR, T0);
    let t = buy(&mut c, "dev.test", 3 * N, T0 + 1);
    assert_eq!(t.copies.len(), 2);

    // NEAR that reached the curve for each of them, and tokens received.
    let own_net = 3 * N - FILL_STORAGE_FEE;
    let nets: Vec<(u128, u128)> = std::iter::once((own_net, t.tokens.0))
        .chain(t.copies.iter().map(|f| (f.near.0 - f.fee.0 - FILL_STORAGE_FEE, f.tokens.0)))
        .collect();
    // Same price means tokens / near is the same for all, up to one unit of rounding each.
    let (n0, t0) = nets[0];
    for (n, tk) in &nets[1..] {
        let cross_a = U256::from(*tk) * U256::from(n0);
        let cross_b = U256::from(t0) * U256::from(*n);
        let diff = if cross_a > cross_b { cross_a - cross_b } else { cross_b - cross_a };
        assert!(diff <= U256::from(n0) + U256::from(*n), "price differs by more than rounding");
    }
    assert_eq!(bal(&c, "fan1.test"), t.copies[0].tokens.0);
    assert_eq!(bal(&c, "fan2.test"), t.copies[1].tokens.0);
}

#[test]
fn a_creator_with_followers_gets_fewer_tokens_than_they_would_alone() {
    // The price the creator pays includes the followers' buying. That is the point: the
    // followed account cannot buy first and let its followers push the price up afterwards.
    let mut alone = pad();
    let solo = buy(&mut alone, "dev.test", 3 * N, T0 + 1).tokens.0;

    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, 3 * N, T0 + HOUR, T0);
    let with_followers = buy(&mut c, "dev.test", 3 * N, T0 + 1).tokens.0;
    assert!(with_followers < solo);
}

#[test]
fn the_quote_matches_what_the_buy_then_does() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    as_user("anyone.test", 0, T0 + 1);
    let q = c.quote_buy("frog".into(), U128(3 * N), acc("dev.test"));
    let t = buy(&mut c, "dev.test", 3 * N, T0 + 1);
    assert_eq!(q.own.0, t.tokens.0);
    assert_eq!(q.copies[0].tokens.0, t.copies[0].tokens.0);
    assert_eq!(q.copies[0].near.0, t.copies[0].near.0);
}

#[test]
#[should_panic(expected = "the price moved")]
fn a_buy_that_would_give_fewer_tokens_than_the_minimum_fails() {
    let mut c = pad();
    as_user("dev.test", N, T0);
    c.buy("frog".into(), U128(TOKEN_SUPPLY));
}

#[test]
#[should_panic(expected = "the smallest buy is 0.01 NEAR")]
fn a_dust_buy_is_refused() {
    let mut c = pad();
    buy(&mut c, "dev.test", MIN_TRADE - 1, T0);
}

// ---- the creator fee --------------------------------------------------------------------------

#[test]
fn the_creator_fee_is_taken_from_each_copy_and_is_claimable_by_the_creator() {
    let mut c = pad();
    as_user("dev.test", SET_FEE_DEPOSIT, T0);
    c.set_fee(250); // 2.5%
    follow(&mut c, "fan1.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    follow(&mut c, "fan2.test", "dev.test", 5 * N, N, T0 + HOUR, T0);
    let t = buy(&mut c, "dev.test", 4 * N, T0 + 1);
    assert_eq!(t.copies[0].fee.0, 2 * N * 250 / 10_000);
    assert_eq!(t.copies[1].fee.0, N * 250 / 10_000);
    let fees = 3 * N * 250 / 10_000;
    assert_eq!(c.get_claimable(acc("dev.test")).0, fees);
    let s = c.get_creator(acc("dev.test"));
    assert_eq!((s.fees_earned.0, s.copied_volume.0, s.copies, s.followers), (fees, 3 * N, 2, 2));

    as_user("dev.test", 1, T0 + 2);
    assert_eq!(c.claim().0, fees);
    assert_eq!(paid_to("dev.test"), fees + 1);
    assert_eq!(c.get_claimable(acc("dev.test")).0, 0);
}

#[test]
fn raising_the_fee_later_does_not_touch_an_allowance_already_granted() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, N, T0 + HOUR, T0); // granted at the default 1%
    as_user("dev.test", SET_FEE_DEPOSIT, T0 + 1);
    c.set_fee(MAX_FEE_BPS);
    let t = buy(&mut c, "dev.test", N, T0 + 2);
    assert_eq!(t.copies[0].fee.0, N / 100);
    assert_eq!(allowance(&c, "fan.test", "dev.test").fee_bps, DEFAULT_FEE_BPS);
}

#[test]
#[should_panic(expected = "the creator's fee is higher than the fee you accepted")]
fn a_follow_fails_if_the_creator_raised_the_fee_above_what_the_follower_accepted() {
    let mut c = pad();
    as_user("dev.test", SET_FEE_DEPOSIT, T0);
    c.set_fee(900);
    as_user("fan.test", N + FOLLOW_STORAGE_FEE, T0 + 1);
    c.follow(acc("dev.test"), U128(N), U64((T0 + HOUR) / 1_000_000), 100);
}

#[test]
#[should_panic(expected = "the fee can be at most 10%")]
fn a_fee_above_ten_percent_is_refused() {
    let mut c = pad();
    as_user("dev.test", SET_FEE_DEPOSIT, T0);
    c.set_fee(MAX_FEE_BPS + 1);
}

#[test]
#[should_panic(expected = "nothing to claim")]
fn claiming_nothing_fails() {
    let mut c = pad();
    as_user("dev.test", 1, T0);
    c.claim();
}

// ---- selling: followers leave at the creator's price ------------------------------------------

#[test]
fn when_the_creator_sells_half_each_follower_sells_half_of_what_they_copied_at_the_same_price() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    let b = buy(&mut c, "dev.test", 2 * N, T0 + 1);
    let copied = b.copies[0].tokens.0;

    let s = sell(&mut c, "dev.test", b.tokens.0 / 2, T0 + 2);
    assert_eq!(s.copies.len(), 1);
    let fill = &s.copies[0];
    assert!(fill.tokens.0 <= copied / 2 && copied / 2 - fill.tokens.0 <= 1, "half of the copied position, rounded down");
    assert_eq!(fill.fee.0, 0, "no creator fee on the way out");
    assert_eq!(bal(&c, "fan.test"), copied - fill.tokens.0);
    assert_eq!(c.get_copied(acc("fan.test"), acc("dev.test"), "frog".into()).0, copied - fill.tokens.0);
    assert_eq!(c.get_claimable(acc("fan.test")).0, fill.near.0);
    assert_eq!(paid_to("dev.test"), s.near.0 + 1, "the creator is paid in the same call");

    // Same NEAR per token for both, before the flat record fee, up to rounding.
    let a = U256::from(s.near.0 + FILL_STORAGE_FEE) * U256::from(fill.tokens.0);
    let b2 = U256::from(fill.near.0 + FILL_STORAGE_FEE) * U256::from(s.tokens.0);
    let diff = if a > b2 { a - b2 } else { b2 - a };
    assert!(diff <= U256::from(s.tokens.0) + U256::from(fill.tokens.0));
}

#[test]
fn a_creator_selling_everything_takes_the_followers_copies_out_with_them() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    let b = buy(&mut c, "dev.test", 2 * N, T0 + 1);
    sell(&mut c, "dev.test", b.tokens.0, T0 + 2);
    assert_eq!(bal(&c, "dev.test"), 0);
    assert_eq!(bal(&c, "fan.test"), 0);
    // Nobody front-ran anybody: the follower gets back what reached the curve, less the two
    // flat fees and the creator fee, up to rounding.
    let reached_curve = 2 * N - 2 * N / 100 - FILL_STORAGE_FEE;
    let back = c.get_claimable(acc("fan.test")).0;
    assert!(reached_curve - FILL_STORAGE_FEE - back < 1_000, "follower lost {} yocto to price", reached_curve - FILL_STORAGE_FEE - back);
}

#[test]
fn tokens_a_follower_bought_themselves_are_not_sold_by_the_creators_sell() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, N, T0 + HOUR, T0);
    let own = buy(&mut c, "fan.test", N, T0 + 1).tokens.0; // the follower's own buy
    let b = buy(&mut c, "dev.test", N, T0 + 2);
    let copied = b.copies[0].tokens.0;
    assert_eq!(bal(&c, "fan.test"), own + copied);

    let s = sell(&mut c, "dev.test", b.tokens.0, T0 + 3);
    assert_eq!(s.copies[0].tokens.0, copied);
    assert_eq!(bal(&c, "fan.test"), own);
}

#[test]
fn after_revoking_the_creators_sell_leaves_the_former_followers_tokens_alone() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, N, T0 + HOUR, T0);
    let b = buy(&mut c, "dev.test", N, T0 + 1);
    as_user("fan.test", 1, T0 + 2);
    c.revoke(acc("dev.test"));
    let s = sell(&mut c, "dev.test", b.tokens.0, T0 + 3);
    assert!(s.copies.is_empty());
    assert_eq!(bal(&c, "fan.test"), b.copies[0].tokens.0);
}

#[test]
fn after_expiry_the_creators_sell_leaves_the_tokens_alone_and_closes_the_allowance() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, N, T0 + HOUR, T0);
    let b = buy(&mut c, "dev.test", N, T0 + 1);
    let s = sell(&mut c, "dev.test", b.tokens.0, T0 + HOUR);
    assert!(s.copies.is_empty());
    assert_eq!(s.closed.len(), 1);
    assert_eq!(bal(&c, "fan.test"), b.copies[0].tokens.0);
    assert_eq!(c.get_claimable(acc("fan.test")).0, 4 * N);
}

#[test]
fn a_follower_can_sell_their_copied_tokens_themselves_at_any_time() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, N, T0 + HOUR, T0);
    let b = buy(&mut c, "dev.test", N, T0 + 1);
    let s = sell(&mut c, "fan.test", b.copies[0].tokens.0, T0 + 2);
    assert_eq!(bal(&c, "fan.test"), 0);
    assert_eq!(paid_to("fan.test"), s.near.0 + 1);
    // The creator's later sell finds nothing of the follower's to sell.
    let s2 = sell(&mut c, "dev.test", b.tokens.0, T0 + 3);
    assert!(s2.copies.is_empty());
}

#[test]
#[should_panic(expected = "you do not hold that many tokens")]
fn nobody_can_sell_more_than_they_hold() {
    let mut c = pad();
    let b = buy(&mut c, "dev.test", N, T0);
    sell(&mut c, "dev.test", b.tokens.0 + 1, T0 + 1);
}

#[test]
#[should_panic(expected = "the price moved")]
fn a_sell_that_would_pay_less_than_the_minimum_fails() {
    let mut c = pad();
    let b = buy(&mut c, "dev.test", N, T0);
    as_user("dev.test", 1, T0 + 1);
    c.sell("frog".into(), b.tokens, U128(N));
}

#[test]
#[should_panic(expected = "too small to sell")]
fn a_sell_too_small_to_cover_the_record_fee_fails() {
    let mut c = pad();
    buy(&mut c, "dev.test", N, T0);
    sell(&mut c, "dev.test", 1, T0 + 1);
}

// ---- launching --------------------------------------------------------------------------------

#[test]
fn a_launch_puts_the_whole_supply_in_the_curve_and_deploys_the_token_contract() {
    as_user(PAD, 0, T0);
    let mut c = CopyLaunch::new();
    let cost = c.get_config().launch_cost.0;
    as_user("dev.test", cost, T0);
    c.launch("frog".into(), "Frog".into(), None, Some("https://example.org/frog.png".into())).detach();

    let receipts = get_created_receipts();
    let deploy = receipts.iter().find(|r| r.receiver_id.as_str() == "frog.pad.test").expect("a receipt to the new token account");
    assert!(deploy.actions.iter().any(|a| matches!(a, MockAction::CreateAccount { .. })));
    assert!(deploy.actions.iter().any(|a| matches!(a, MockAction::DeployContract { .. })));
    let init = deploy
        .actions
        .iter()
        .find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, .. } => Some((method_name.clone(), args.clone())),
            _ => None,
        })
        .expect("the token is initialised in the same receipt");
    assert_eq!(init.0, b"new");
    let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(&init.1).unwrap();
    assert_eq!(args["owner_id"], PAD);
    assert_eq!(args["total_supply"], TOKEN_SUPPLY.to_string());
    assert_eq!(args["metadata"]["symbol"], "FROG");
    assert_eq!(args["metadata"]["decimals"], 18);

    // Not tradable until the token contract exists.
    assert!(!c.get_token("frog".into()).unwrap().ready);
    as_callback(PromiseResult::Successful(vec![]), T0);
    assert!(c.on_launch("frog".into(), acc("dev.test"), U128(cost)));
    let t = c.get_token("frog".into()).unwrap();
    assert!(t.ready);
    assert_eq!(t.token_reserve.0, TOKEN_SUPPLY);
    assert_eq!(t.near_reserve.0, 0);
    assert_eq!(t.account_id, acc("frog.pad.test"));
    assert_eq!(t.creator, acc("dev.test"));
}

#[test]
fn a_launch_whose_token_contract_could_not_be_created_is_undone_and_refunded() {
    as_user(PAD, 0, T0);
    let mut c = CopyLaunch::new();
    let cost = c.get_config().launch_cost.0;
    as_user("dev.test", cost + N, T0);
    c.launch("frog".into(), "Frog".into(), None, None).detach();
    as_callback(PromiseResult::Failed, T0);
    assert!(!c.on_launch("frog".into(), acc("dev.test"), U128(cost + N)));
    assert!(c.get_token("frog".into()).is_none());
    assert_eq!(paid_to("dev.test"), cost + N);
    assert_eq!(c.get_totals().storage_fees.0, 0);
    // The symbol is free again.
    launch(&mut c, "frog", "dev.test");
}

#[test]
fn anything_attached_above_the_launch_cost_comes_back() {
    as_user(PAD, 0, T0);
    let mut c = CopyLaunch::new();
    let cost = c.get_config().launch_cost.0;
    as_user("dev.test", cost + 3 * N, T0);
    c.launch("frog".into(), "Frog".into(), None, None).detach();
    as_callback(PromiseResult::Successful(vec![]), T0);
    c.on_launch("frog".into(), acc("dev.test"), U128(cost + 3 * N));
    assert_eq!(paid_to("dev.test"), 3 * N);
}

#[test]
#[should_panic(expected = "this token is still being created")]
fn a_token_cannot_be_bought_before_its_contract_exists() {
    as_user(PAD, 0, T0);
    let mut c = CopyLaunch::new();
    as_user("dev.test", c.get_config().launch_cost.0, T0);
    c.launch("frog".into(), "Frog".into(), None, None).detach();
    buy(&mut c, "dev.test", N, T0);
}

#[test]
#[should_panic(expected = "that symbol is taken")]
fn a_symbol_can_be_launched_only_once() {
    let mut c = pad();
    as_user("other.test", c.get_config().launch_cost.0, T0);
    c.launch("frog".into(), "Other frog".into(), None, None).detach();
}

#[test]
#[should_panic(expected = "the symbol must be 2 to 10 characters")]
fn a_symbol_that_cannot_be_an_account_name_is_refused() {
    let mut c = pad();
    as_user("dev.test", c.get_config().launch_cost.0, T0);
    c.launch("Fr.og".into(), "Frog".into(), None, None).detach();
}

#[test]
#[should_panic(expected = "attach at least the launch cost")]
fn a_launch_that_does_not_pay_for_the_token_account_is_refused() {
    let mut c = pad();
    as_user("dev.test", c.get_config().launch_cost.0 - 1, T0);
    c.launch("toad".into(), "Toad".into(), None, None).detach();
}

#[test]
#[should_panic(expected = "the image must be an https link")]
fn an_image_that_is_not_an_https_link_is_refused() {
    let mut c = pad();
    as_user("dev.test", c.get_config().launch_cost.0, T0);
    c.launch("toad".into(), "Toad".into(), None, Some("javascript:alert(1)".into())).detach();
}

// ---- moving tokens to and from a wallet -------------------------------------------------------

#[test]
fn withdrawing_sends_real_nep141_tokens_and_a_failed_transfer_puts_them_back() {
    let mut c = pad();
    let held = buy(&mut c, "dev.test", N, T0).tokens.0;
    as_user("dev.test", WITHDRAW_DEPOSIT, T0 + 1);
    c.withdraw_token("frog".into(), U128(held)).detach();
    assert_eq!(bal(&c, "dev.test"), 0);
    let calls: Vec<Vec<u8>> = get_created_receipts()
        .iter()
        .filter(|r| r.receiver_id.as_str() == "frog.pad.test")
        .flat_map(|r| r.actions.iter())
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, .. } => Some(method_name.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(calls, vec![b"storage_deposit".to_vec(), b"ft_transfer".to_vec()]);

    as_callback(PromiseResult::Failed, T0 + 2);
    assert!(!c.on_withdraw("frog".into(), acc("dev.test"), U128(held)));
    assert_eq!(bal(&c, "dev.test"), held);

    as_callback(PromiseResult::Successful(vec![]), T0 + 3);
    assert!(c.on_withdraw("frog".into(), acc("dev.test"), U128(1)));
    assert_eq!(bal(&c, "dev.test"), held, "a successful transfer changes nothing more");
}

#[test]
#[should_panic(expected = "you do not hold that many tokens")]
fn nobody_can_withdraw_more_than_they_hold() {
    let mut c = pad();
    let held = buy(&mut c, "dev.test", N, T0).tokens.0;
    as_user("dev.test", WITHDRAW_DEPOSIT, T0 + 1);
    c.withdraw_token("frog".into(), U128(held + 1)).detach();
}

#[test]
fn tokens_sent_back_by_the_token_contract_are_credited_to_the_sender() {
    let mut c = pad();
    as_user("frog.pad.test", 0, T0);
    assert_eq!(c.ft_on_transfer(acc("alice.test"), U128(500), String::new()).0, 0);
    assert_eq!(bal(&c, "alice.test"), 500);
}

#[test]
#[should_panic(expected = "only tokens launched here can be deposited")]
fn a_deposit_from_any_other_contract_is_refused() {
    let mut c = pad();
    as_user("fake.test", 0, T0);
    c.ft_on_transfer(acc("alice.test"), U128(500), String::new());
}

#[test]
#[should_panic(expected = "there is no token with that symbol")]
fn a_deposit_from_a_sub_account_that_is_not_a_launched_token_is_refused() {
    let mut c = pad();
    as_user("toad.pad.test", 0, T0);
    c.ft_on_transfer(acc("alice.test"), U128(500), String::new());
}

// ---- the books --------------------------------------------------------------------------------

/// Deterministic pseudo-random numbers (xorshift), so a failure reproduces.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn after_any_mix_of_trades_follows_and_revokes_the_books_still_balance() {
    let users = ["dev.test", "ann.test", "bob.test", "cat.test", "dan.test"];
    let mut c = pad();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut now = T0;
    // NEAR that came in and went out since launch.
    let mut came_in = 0u128;
    let mut went_out = 0u128;
    let base = {
        let t = c.get_totals();
        t.owed.0 + t.storage_fees.0
    };

    for step in 0..600 {
        now += 1 + rng.below(HOUR / 4);
        let who = users[rng.below(users.len() as u64) as usize];
        let other = users[rng.below(users.len() as u64) as usize];
        match rng.below(10) {
            0..=3 => {
                let near = MIN_TRADE + rng.below(3_000) as u128 * N / 1_000;
                buy(&mut c, who, near, now);
                came_in += near;
            }
            4..=5 => {
                let held = bal(&c, who);
                if held == 0 {
                    continue;
                }
                let tokens = held / (1 + rng.below(4) as u128);
                as_user("anyone.test", 0, now);
                if c.quote_sell("frog".into(), U128(tokens), acc(who)).own.0 == 0 {
                    continue; // too small to cover the record fee
                }
                sell(&mut c, who, tokens, now);
                came_in += 1;
                went_out += paid_to(who);
            }
            6..=7 => {
                if who == other || c.get_allowance(acc(who), acc(other)).is_some() {
                    continue;
                }
                let total = MIN_COPY + rng.below(4_000) as u128 * N / 1_000;
                let per_trade = MIN_COPY + (total - MIN_COPY) / (1 + rng.below(5) as u128);
                follow(&mut c, who, other, total, per_trade, now + 1 + rng.below(3 * HOUR), now);
                came_in += total + FOLLOW_STORAGE_FEE;
            }
            8 => {
                if c.get_allowance(acc(who), acc(other)).is_none() {
                    continue;
                }
                as_user(who, 1, now);
                c.revoke(acc(other));
                came_in += 1;
                went_out += paid_to(who);
            }
            _ => {
                if c.get_claimable(acc(who)).0 == 0 {
                    continue;
                }
                as_user(who, 1, now);
                c.claim();
                came_in += 1;
                went_out += paid_to(who);
            }
        }

        as_user("anyone.test", 0, now);
        let t = c.get_totals();
        let token = c.get_token("frog".into()).unwrap();
        // 1. Every yocto that came in is in a curve, an allowance, a claim or a kept fee, or went out.
        assert_eq!(base + came_in - went_out, t.owed.0 + t.storage_fees.0, "step {step}: NEAR is not conserved");
        // 2. The curve total is the one token's reserve.
        assert_eq!(t.curves.0, token.near_reserve.0, "step {step}");
        // 3. No tokens appear or vanish.
        let held: u128 = users.iter().map(|u| bal(&c, u)).sum();
        assert_eq!(token.token_reserve.0 + held, TOKEN_SUPPLY, "step {step}: token supply drifted");
        // 4. The unspent parts of all allowances are what the allowance total says, and no
        //    allowance ever spent more than its cap.
        let mut unspent = 0u128;
        for u in users {
            for a in c.get_following(acc(u)) {
                assert!(a.spent.0 <= a.total_cap.0, "step {step}: an allowance overspent");
                unspent += a.remaining.0;
            }
        }
        assert_eq!(unspent, t.allowances.0, "step {step}");
        // 5. What is claimable adds up.
        let claims: u128 = users.iter().map(|u| c.get_claimable(acc(u)).0).sum();
        assert_eq!(claims, t.claimable.0, "step {step}");
        // 6. The curve never falls below its starting product, so it can pay for every token out.
        let k = U256::from(VIRTUAL_NEAR + token.near_reserve.0) * U256::from(token.token_reserve.0);
        assert!(k >= U256::from(VIRTUAL_NEAR) * U256::from(TOKEN_SUPPLY), "step {step}: the curve lost value");
    }
    assert!(c.get_trade_count() > 200, "the run should have traded a lot, got {}", c.get_trade_count());
}

#[test]
fn if_everybody_sells_everything_the_curve_pays_them_all_and_is_left_with_dust() {
    let mut c = pad();
    follow(&mut c, "fan.test", "dev.test", 5 * N, 2 * N, T0 + HOUR, T0);
    buy(&mut c, "dev.test", 3 * N, T0 + 1);
    buy(&mut c, "ann.test", 7 * N, T0 + 2);
    buy(&mut c, "dev.test", N, T0 + 3);
    as_user("fan.test", 1, T0 + 4);
    c.revoke(acc("dev.test"));
    for who in ["ann.test", "fan.test", "dev.test"] {
        let held = bal(&c, who);
        sell(&mut c, who, held, T0 + 5);
    }
    let token = c.get_token("frog".into()).unwrap();
    assert!(token.near_reserve.0 < 1_000, "left in the curve: {} yocto", token.near_reserve.0);
    assert!(TOKEN_SUPPLY - token.token_reserve.0 < 1_000);
}

fn flush(c: &mut CopyLaunch) {
    c.tokens.flush();
    c.balances.flush();
    c.allowances.flush();
    c.followers.flush();
    c.following.flush();
    c.fee_bps.flush();
    c.copied.flush();
    c.claimable.flush();
    c.trades.flush();
    c.stats.flush();
}

/// Runs one call as `who` and returns (bytes of state it added, flat fees it paid).
/// The mocked chain restarts its byte counter with every call context, so both ends of the
/// measurement sit inside the same one.
fn grown(c: &mut CopyLaunch, who: &str, yocto: u128, now: u64, call: impl FnOnce(&mut CopyLaunch)) -> (u128, u128) {
    flush(c);
    as_user(who, yocto, now);
    let bytes = env::storage_usage();
    let fees = c.get_totals().storage_fees.0;
    call(c);
    flush(c);
    ((env::storage_usage() - bytes) as u128, c.get_totals().storage_fees.0 - fees)
}

#[test]
fn the_flat_fees_cover_the_bytes_even_with_the_longest_account_names() {
    // Storage costs NEAR. Each fill pays a flat fee instead of a metered one, so the fee has to
    // cover the worst case: 64-character account names and every record being new.
    let creator = "c".repeat(64);
    let fans: Vec<String> = (0..MAX_FOLLOWERS).map(|i| format!("{:0>64}", format!("f{i}"))).collect();
    as_user(PAD, 0, T0);
    let mut c = CopyLaunch::new();
    launch(&mut c, "frog", "dev.test");
    let byte_cost = env::storage_byte_cost().as_yoctonear();

    // Following: every follower's allowance and both list entries.
    for f in &fans {
        let (bytes, fees) = grown(&mut c, f, N + FOLLOW_STORAGE_FEE, T0, |c| {
            c.follow(acc(&creator), U128(N), U64((T0 + HOUR) / 1_000_000), MAX_FEE_BPS);
        });
        assert!(bytes > 0 && bytes * byte_cost <= fees, "follow: {bytes} bytes cost more than the {fees} yocto collected");
    }

    // A buy copied by every follower, all records new.
    let (bytes, fees) = grown(&mut c, &creator, N, T0 + 1, |c| {
        assert_eq!(c.buy("frog".into(), U128(0)).copies.len(), MAX_FOLLOWERS);
    });
    assert!(bytes > 0 && bytes * byte_cost <= fees, "copied buy: {bytes} bytes cost more than the {fees} yocto collected");
    println!("copied buy, {MAX_FOLLOWERS} followers, 64-char names: {bytes} bytes, {} collected for {}", fees, bytes * byte_cost);

    // A sell copied by every follower, all claim records new.
    let held = c.get_balance("frog".into(), acc(&creator)).0;
    let (bytes, fees) = grown(&mut c, &creator, 1, T0 + 2, |c| {
        assert_eq!(c.sell("frog".into(), U128(held / 2), U128(0)).copies.len(), MAX_FOLLOWERS);
    });
    assert!(bytes > 0 && bytes * byte_cost <= fees, "copied sell: {bytes} bytes cost more than the {fees} yocto collected");
    println!("copied sell: {bytes} bytes, {} collected for {}", fees, bytes * byte_cost);

    // A solo buy and a solo sell by a new account.
    let solo = "s".repeat(64);
    let (bytes, fees) = grown(&mut c, &solo, N, T0 + 3, |c| {
        c.buy("frog".into(), U128(0));
    });
    assert!(bytes * byte_cost <= fees, "solo buy: {bytes} bytes cost more than the {fees} yocto collected");
    println!("solo buy: {bytes} bytes, {} collected for {}", fees, bytes * byte_cost);
}

#[test]
fn a_full_set_of_followers_is_copied_in_one_call() {
    let mut c = pad();
    for i in 0..MAX_FOLLOWERS {
        follow(&mut c, &format!("fan{i}.test"), "dev.test", N, N / 2, T0 + HOUR, T0);
    }
    let t = buy(&mut c, "dev.test", N, T0 + 1);
    assert_eq!(t.copies.len(), MAX_FOLLOWERS);
    assert!(t.copies.iter().all(|f| f.near.0 == N / 2 && f.tokens.0 > 0));
}

// ---- views ------------------------------------------------------------------------------------

#[test]
fn the_trade_log_is_served_newest_first_and_pages_backwards() {
    let mut c = pad();
    for i in 0..5 {
        buy(&mut c, "dev.test", N, T0 + i);
    }
    as_user("anyone.test", 0, T0 + 9);
    let latest = c.get_trades(None, Some(2));
    assert_eq!(latest.iter().map(|t| t.index).collect::<Vec<_>>(), vec![4, 3]);
    let older = c.get_trades(Some(3), Some(10));
    assert_eq!(older.iter().map(|t| t.index).collect::<Vec<_>>(), vec![2, 1, 0]);
    assert_eq!(c.get_trade_count(), 5);
}

#[test]
fn the_config_publishes_every_parameter_and_the_token_code_hash() {
    let c = pad();
    let cfg = c.get_config();
    assert_eq!(cfg.token_supply.0, TOKEN_SUPPLY);
    assert_eq!(cfg.virtual_near.0, VIRTUAL_NEAR);
    assert_eq!(cfg.max_followers as usize, MAX_FOLLOWERS);
    assert_eq!(cfg.max_fee_bps, MAX_FEE_BPS);
    assert_eq!(cfg.max_allowance_days, 365);
    assert_eq!(cfg.token_code_sha256.len(), 64);
    assert!(cfg.launch_cost.0 > LAUNCH_STORAGE_FEE);
}

#[test]
fn holdings_list_only_the_tokens_an_account_holds() {
    let mut c = pad();
    launch(&mut c, "toad", "dev.test");
    buy(&mut c, "ann.test", N, T0 + 1);
    as_user("anyone.test", 0, T0 + 2);
    let h = c.get_holdings(acc("ann.test"));
    assert_eq!(h.len(), 1);
    assert_eq!(h[0].symbol, "frog");
    assert!(c.get_holdings(acc("bob.test")).is_empty());
    assert_eq!(c.get_token_count(), 2);
    assert_eq!(c.get_tokens(Some(1), None)[0].symbol, "toad");
}
