//! The follow allowance: what a follower lets one creator's trades spend on their behalf.
//!
//! NEAR has no way for a contract to pull native NEAR out of somebody's account, so the
//! allowance is funded: the follower deposits `total_cap` when they follow, and the contract
//! holds it. Every debit goes through `Allowance::spend`, which is the only place the limits
//! are enforced.

use near_sdk::near;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Allowance {
    /// Unique per grant. A follower who revokes and follows again gets a new id.
    pub id: u64,
    /// The most this allowance can ever spend, in yoctoNEAR. Deposited in full at the grant.
    pub total_cap: u128,
    /// Spent so far.
    pub spent: u128,
    /// The most one copied trade may spend.
    pub per_trade_cap: u128,
    /// Block timestamp (nanoseconds) from which nothing more can be spent.
    pub expires_at_ns: u64,
    /// The creator's fee when the follower agreed, in basis points. Fixed for this allowance.
    pub fee_bps: u16,
    pub created_at_ns: u64,
    /// How many trades were copied under it.
    pub copies: u32,
}

/// Why a spend was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Denied {
    Zero,
    Expired,
    OverPerTradeCap,
    OverTotalCap,
}

impl Allowance {
    pub fn remaining(&self) -> u128 {
        self.total_cap - self.spent
    }

    pub fn is_expired(&self, now_ns: u64) -> bool {
        now_ns >= self.expires_at_ns
    }

    /// Debits the allowance, or refuses and changes nothing.
    pub fn spend(&mut self, amount: u128, now_ns: u64) -> Result<(), Denied> {
        if amount == 0 {
            return Err(Denied::Zero);
        }
        if self.is_expired(now_ns) {
            return Err(Denied::Expired);
        }
        if amount > self.per_trade_cap {
            return Err(Denied::OverPerTradeCap);
        }
        if amount > self.remaining() {
            return Err(Denied::OverTotalCap);
        }
        self.spent += amount;
        self.copies += 1;
        Ok(())
    }

    /// How much a copy of a creator's buy of `creator_amount` is sized at: the creator's own
    /// amount, cut down to the per-trade cap and to what is left. Zero once expired.
    pub fn copy_size(&self, creator_amount: u128, now_ns: u64) -> u128 {
        if self.is_expired(now_ns) {
            return 0;
        }
        creator_amount.min(self.per_trade_cap).min(self.remaining())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEAR: u128 = 10u128.pow(24);

    fn grant() -> Allowance {
        Allowance {
            id: 1,
            total_cap: 5 * NEAR,
            spent: 0,
            per_trade_cap: 2 * NEAR,
            expires_at_ns: 1_000,
            fee_bps: 100,
            created_at_ns: 0,
            copies: 0,
        }
    }

    #[test]
    fn a_spend_inside_both_caps_is_debited_and_counted() {
        let mut a = grant();
        assert_eq!(a.spend(2 * NEAR, 10), Ok(()));
        assert_eq!(a.spent, 2 * NEAR);
        assert_eq!(a.remaining(), 3 * NEAR);
        assert_eq!(a.copies, 1);
    }

    #[test]
    fn a_spend_over_the_per_trade_cap_is_refused_and_changes_nothing() {
        let mut a = grant();
        assert_eq!(a.spend(2 * NEAR + 1, 10), Err(Denied::OverPerTradeCap));
        assert_eq!(a, grant());
    }

    #[test]
    fn a_spend_over_what_is_left_of_the_total_cap_is_refused() {
        let mut a = grant();
        a.spend(2 * NEAR, 10).unwrap();
        a.spend(2 * NEAR, 11).unwrap();
        // 1 NEAR left; 2 NEAR is inside the per-trade cap but over the total.
        let before = a.clone();
        assert_eq!(a.spend(2 * NEAR, 12), Err(Denied::OverTotalCap));
        assert_eq!(a, before);
    }

    #[test]
    fn the_last_yocto_can_be_spent_and_then_nothing_more() {
        let mut a = grant();
        a.spend(2 * NEAR, 10).unwrap();
        a.spend(2 * NEAR, 11).unwrap();
        assert_eq!(a.spend(NEAR, 12), Ok(()));
        assert_eq!(a.spent, a.total_cap);
        assert_eq!(a.spend(1, 13), Err(Denied::OverTotalCap));
        assert_eq!(a.spent, a.total_cap);
    }

    #[test]
    fn a_spend_at_the_expiry_time_is_refused_and_one_nanosecond_earlier_is_not() {
        let mut a = grant();
        assert_eq!(a.spend(NEAR, 1_000), Err(Denied::Expired));
        assert_eq!(a.spend(NEAR, 5_000), Err(Denied::Expired));
        assert_eq!(a.spent, 0);
        assert_eq!(a.spend(NEAR, 999), Ok(()));
    }

    #[test]
    fn an_expired_allowance_is_refused_even_for_an_amount_inside_every_cap() {
        let mut a = grant();
        assert_eq!(a.spend(1, 1_000), Err(Denied::Expired));
    }

    #[test]
    fn a_zero_spend_is_refused() {
        let mut a = grant();
        assert_eq!(a.spend(0, 10), Err(Denied::Zero));
        assert_eq!(a.copies, 0);
    }

    #[test]
    fn a_copy_is_sized_at_the_smallest_of_the_trade_the_per_trade_cap_and_what_is_left() {
        let mut a = grant();
        assert_eq!(a.copy_size(NEAR, 10), NEAR); // the creator's own amount
        assert_eq!(a.copy_size(9 * NEAR, 10), 2 * NEAR); // the per-trade cap
        a.spend(2 * NEAR, 10).unwrap();
        a.spend(2 * NEAR, 10).unwrap();
        assert_eq!(a.copy_size(9 * NEAR, 10), NEAR); // what is left
        assert_eq!(a.copy_size(9 * NEAR, 1_000), 0); // expired
    }

    #[test]
    fn whatever_size_a_copy_is_given_the_gate_accepts_it_until_expiry() {
        // The sizing rule and the gate agree: a sized copy is never refused for a cap.
        let mut a = grant();
        for creator_amount in [NEAR / 2, 3 * NEAR, 7 * NEAR, NEAR, 10 * NEAR] {
            let size = a.copy_size(creator_amount, 10);
            if size == 0 {
                break;
            }
            assert_eq!(a.spend(size, 10), Ok(()));
            assert!(a.spent <= a.total_cap);
        }
        assert_eq!(a.spent, a.total_cap);
    }
}
