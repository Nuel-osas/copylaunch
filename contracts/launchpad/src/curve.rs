//! The price curve: constant product with a virtual NEAR reserve.
//!
//! A token starts with its whole supply in the curve and no NEAR. Price is
//! `(VIRTUAL_NEAR + near_reserve) / token_reserve`. Every result is rounded down, in the
//! curve's favour, so the curve can always pay for every token it has sold.

uint::construct_uint! {
    /// 256-bit integer, used only for the intermediate product in `mul_div`.
    pub struct U256(4);
}

/// `floor(a * b / d)` with a 256-bit intermediate. Panics on a zero divisor or a result over u128.
pub fn mul_div(a: u128, b: u128, d: u128) -> u128 {
    assert!(d != 0, "division by zero");
    let q = U256::from(a) * U256::from(b) / U256::from(d);
    assert!(q <= U256::from(u128::MAX), "result does not fit");
    q.as_u128()
}

/// Tokens the curve gives for `near_in`, at reserves `(virtual_near + near_reserve, token_reserve)`.
/// Always strictly less than `token_reserve`.
pub fn buy_out(virtual_near: u128, near_reserve: u128, token_reserve: u128, near_in: u128) -> u128 {
    mul_div(token_reserve, near_in, virtual_near + near_reserve + near_in)
}

/// NEAR the curve pays for `tokens_in`. Returns `None` if that would be more than the curve
/// holds, which the maths rules out for tokens the curve itself sold; the caller fails closed.
pub fn sell_out(virtual_near: u128, near_reserve: u128, token_reserve: u128, tokens_in: u128) -> Option<u128> {
    let out = mul_div(virtual_near + near_reserve, tokens_in, token_reserve + tokens_in);
    (out <= near_reserve).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const V: u128 = 20 * 10u128.pow(24);
    const SUPPLY: u128 = 1_000_000_000 * 10u128.pow(18);

    #[test]
    fn mul_div_is_exact_where_u128_would_overflow() {
        // 1e27 * 1e30 overflows u128 (max 3.4e38); the quotient does not.
        assert_eq!(mul_div(10u128.pow(27), 10u128.pow(30), 10u128.pow(25)), 10u128.pow(32));
        assert_eq!(mul_div(7, 3, 2), 10); // floor(10.5)
        assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
        assert_eq!(mul_div(0, 5, 9), 0);
    }

    #[test]
    #[should_panic(expected = "division by zero")]
    fn mul_div_refuses_a_zero_divisor() {
        mul_div(1, 1, 0);
    }

    #[test]
    #[should_panic(expected = "does not fit")]
    fn mul_div_refuses_a_result_over_u128() {
        mul_div(u128::MAX, 2, 1);
    }

    #[test]
    fn a_first_buy_of_one_near_gets_one_twenty_first_of_the_supply() {
        let out = buy_out(V, 0, SUPPLY, 10u128.pow(24));
        assert_eq!(out, SUPPLY / 21); // 1 / (20 + 1), rounded down
    }

    #[test]
    fn buying_then_selling_everything_never_pays_out_more_than_went_in() {
        let mut near = 0u128;
        let mut tokens = SUPPLY;
        let mut held = 0u128;
        let mut paid = 0u128;
        for step in 1..=50u128 {
            let n = step * 37 * 10u128.pow(22) + step; // odd sizes on purpose
            let out = buy_out(V, near, tokens, n);
            near += n;
            tokens -= out;
            held += out;
            paid += n;
        }
        let back = sell_out(V, near, tokens, held).expect("the curve can pay for what it sold");
        assert!(back <= paid);
        assert!(paid - back < 100, "only rounding dust stays behind, got {}", paid - back);
    }

    #[test]
    fn the_price_only_rises_as_tokens_are_bought() {
        let mut near = 0u128;
        let mut tokens = SUPPLY;
        let mut last = 0u128;
        for _ in 0..30 {
            let n = 10u128.pow(24);
            let out = buy_out(V, near, tokens, n);
            near += n;
            tokens -= out;
            let price = mul_div(V + near, 10u128.pow(18), tokens); // yoctoNEAR per whole token
            assert!(price > last);
            last = price;
        }
    }

    #[test]
    fn selling_tokens_the_curve_never_sold_is_refused() {
        // Nothing was bought, so the curve holds no NEAR and can pay for nothing.
        assert_eq!(sell_out(V, 0, SUPPLY, 10u128.pow(18)), None);
    }
}
