//! CopyLaunch: a meme-token launchpad where following a creator is a funded, capped, expiring,
//! revocable allowance, and a copied trade clears at one price for the creator and every follower.
//!
//! One contract holds every curve, every balance and every allowance, so a creator's trade and
//! all of its copies happen in a single receipt: either all of it lands or none of it does.
//! Each launched token is also a real NEP-141 contract (a sub-account of this one) that holders
//! can withdraw to.
//!
//! There is no owner and no admin method. Every parameter is a constant in this file.

use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    assert_one_yocto, env, is_promise_success, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise,
};

pub mod allowance;
pub mod curve;
#[cfg(test)]
mod tests;

use allowance::Allowance;
use curve::mul_div;

// ---- parameters: fixed at compile time, readable through `get_config` ------------------------

pub const ONE_NEAR: u128 = 10u128.pow(24);
/// Every token has 18 decimals and a supply of one billion, all of it in the curve at launch.
pub const TOKEN_DECIMALS: u8 = 18;
pub const TOKEN_SUPPLY: u128 = 1_000_000_000 * 10u128.pow(18);
/// The curve prices as if it already held this much NEAR. It sets the starting price.
pub const VIRTUAL_NEAR: u128 = 20 * ONE_NEAR;
/// Flat charge per fill (the trader's own, and each copy) for the bytes it adds to the chain.
pub const FILL_STORAGE_FEE: u128 = ONE_NEAR / 200;
/// Flat charge for the bytes of a new allowance.
pub const FOLLOW_STORAGE_FEE: u128 = ONE_NEAR / 100;
/// Flat charge for the launchpad's record of a new token (the token's own account is extra).
pub const LAUNCH_STORAGE_FEE: u128 = ONE_NEAR / 50;
/// Deposit for publishing a creator fee.
pub const SET_FEE_DEPOSIT: u128 = ONE_NEAR / 500;
/// Deposit for withdrawing tokens to a wallet: pays the NEP-145 registration on the token.
pub const WITHDRAW_DEPOSIT: u128 = ONE_NEAR / 500;
/// What the token contract asks to register one account (125 bytes).
pub const TOKEN_REGISTRATION: u128 = ONE_NEAR / 800;
pub const MIN_TRADE: u128 = ONE_NEAR / 100;
/// The smallest copy. Below this the flat fee would eat the trade.
pub const MIN_COPY: u128 = ONE_NEAR / 20;
/// A creator who never set a fee takes this share of a follower's profit, and only of profit: it is
/// charged when the creator's sell takes the follower's copied tokens out for more than they cost.
/// Copied buys carry no fee, so trading back and forth earns the creator nothing.
pub const DEFAULT_FEE_BPS: u16 = 1_000;
pub const MAX_FEE_BPS: u16 = 2_000;
/// Followers one creator can have. Bounds the gas of a copied trade.
pub const MAX_FOLLOWERS: usize = 32;
/// Creators one account can follow.
pub const MAX_FOLLOWING: usize = 16;
pub const MAX_ALLOWANCE_NS: u64 = 365 * 24 * 60 * 60 * 1_000_000_000;
/// Bytes of state a fresh token account needs besides its code.
const TOKEN_ACCOUNT_EXTRA_BYTES: u128 = 2_500;

const GAS_TOKEN_NEW: Gas = Gas::from_tgas(30);
const GAS_TOKEN_CALL: Gas = Gas::from_tgas(12);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);

/// The token contract's code. Tests never deploy it, so they compile without it.
#[cfg(target_arch = "wasm32")]
const TOKEN_WASM: &[u8] = include_bytes!("../../../build/copylaunch_token.wasm");
#[cfg(not(target_arch = "wasm32"))]
const TOKEN_WASM: &[u8] = &[0u8; 1_024];

// ---- state -----------------------------------------------------------------------------------

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Key {
    Tokens,
    Balances,
    Allowances,
    Followers,
    Following,
    FeeBps,
    Copied,
    Claimable,
    Trades,
    Stats,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Token {
    pub symbol: String,
    pub name: String,
    pub description: String,
    pub image: Option<String>,
    pub creator: AccountId,
    /// The NEP-141 contract for this token.
    pub account_id: AccountId,
    /// NEAR the curve really holds (the virtual reserve is not in here).
    pub near_reserve: u128,
    /// Tokens still in the curve.
    pub token_reserve: u128,
    pub created_at_ns: u64,
    /// True once the NEP-141 contract is deployed. Nothing trades before that.
    pub ready: bool,
    pub trades: u64,
    pub volume: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}

/// One follower's part of a copied trade.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct CopyFill {
    pub follower: AccountId,
    /// Buy: NEAR taken from the allowance. Sell: NEAR credited to the follower, after the fee.
    pub near: U128,
    /// The creator's share of this follower's profit. Zero on every buy, and on a sell at a loss.
    pub fee: U128,
    pub tokens: U128,
}

/// An allowance that was closed because a copy found it expired.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Closed {
    pub follower: AccountId,
    /// Unspent NEAR handed back (claimable by the follower).
    pub refunded: U128,
    pub reason: String,
}

/// One entry of the on-chain trade log.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Trade {
    pub index: u64,
    pub symbol: String,
    pub trader: AccountId,
    pub side: Side,
    /// Buy: NEAR the trader paid. Sell: NEAR the trader received.
    pub near: U128,
    pub tokens: U128,
    pub timestamp_ms: u64,
    pub copies: Vec<CopyFill>,
    pub closed: Vec<Closed>,
}

/// One follower's copies of one creator's trades in one token, under one allowance.
///
/// The creator's fee is measured on cash, not on prices: it is a share of what the follower has
/// taken out of this position beyond everything they put in. Until a follower has their money back,
/// the creator earns nothing, however the sells are split.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Position {
    /// Tokens the copies bought and the creator's sells have not yet taken out.
    pub tokens: u128,
    /// NEAR the follower's allowance spent on copied buys of this token.
    pub paid: u128,
    /// NEAR the creator's sells have returned to the follower, before the creator's fee.
    pub taken: u128,
    /// NEAR paid to the creator out of this position so far.
    pub fees: u128,
}

impl Position {
    /// The creator's fee on a further `net` taken out, at `fee_bps`: whatever brings the total paid
    /// to `fee_bps` of the profit so far, and never more than `net` itself.
    pub fn fee_on(&self, net: u128, fee_bps: u16) -> u128 {
        let taken = self.taken + net;
        let owed = if taken > self.paid { (taken - self.paid) * fee_bps as u128 / 10_000 } else { 0 };
        owed.saturating_sub(self.fees).min(net)
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct CreatorStats {
    pub fees_earned: u128,
    pub copied_volume: u128,
    pub copies: u64,
}

/// Running sums of everything the contract owes, kept so anyone can compare them with its balance.
#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Totals {
    /// NEAR inside all curves.
    pub curves: u128,
    /// Unspent NEAR inside all allowances.
    pub allowances: u128,
    /// Fees and sale proceeds waiting to be claimed.
    pub claimable: u128,
    /// Flat fees kept for storage.
    pub storage_fees: u128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct CopyLaunch {
    tokens: IterableMap<String, Token>,
    /// (symbol, holder) -> tokens held inside the launchpad.
    balances: LookupMap<(String, AccountId), u128>,
    /// (follower, creator) -> allowance.
    allowances: LookupMap<(AccountId, AccountId), Allowance>,
    followers: LookupMap<AccountId, Vec<AccountId>>,
    following: LookupMap<AccountId, Vec<AccountId>>,
    fee_bps: LookupMap<AccountId, u16>,
    /// (allowance id, symbol) -> tokens bought by copies under that allowance and not yet sold, and their cost.
    copied: LookupMap<(u64, String), Position>,
    claimable: LookupMap<AccountId, u128>,
    trades: Vector<Trade>,
    stats: LookupMap<AccountId, CreatorStats>,
    totals: Totals,
    next_allowance_id: u64,
}

// ---- what the views return -------------------------------------------------------------------

#[near(serializers = [json])]
pub struct TokenView {
    pub symbol: String,
    pub name: String,
    pub description: String,
    pub image: Option<String>,
    pub creator: AccountId,
    pub account_id: AccountId,
    pub near_reserve: U128,
    pub token_reserve: U128,
    pub virtual_near: U128,
    pub supply: U128,
    pub created_at_ms: u64,
    pub ready: bool,
    pub trades: u64,
    pub volume: U128,
}

#[near(serializers = [json])]
pub struct AllowanceView {
    pub id: u64,
    pub follower: AccountId,
    pub creator: AccountId,
    pub total_cap: U128,
    pub spent: U128,
    pub remaining: U128,
    pub per_trade_cap: U128,
    pub expires_at_ms: u64,
    pub expired: bool,
    pub fee_bps: u16,
    pub created_at_ms: u64,
    pub copies: u32,
}

#[near(serializers = [json])]
pub struct CreatorView {
    pub creator: AccountId,
    pub fee_bps: u16,
    pub followers: u32,
    pub fees_earned: U128,
    pub copied_volume: U128,
    pub copies: u64,
}

#[near(serializers = [json])]
pub struct HoldingView {
    pub symbol: String,
    pub balance: U128,
}

#[near(serializers = [json])]
pub struct PositionView {
    pub tokens: U128,
    pub paid: U128,
    pub taken: U128,
    pub fees: U128,
}

#[near(serializers = [json])]
pub struct QuoteView {
    /// Buy: tokens the trader gets. Sell: NEAR the trader gets.
    pub own: U128,
    /// What every follower's copy would be, at the same price.
    pub copies: Vec<CopyFill>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub token_decimals: u8,
    pub token_supply: U128,
    pub virtual_near: U128,
    pub fill_storage_fee: U128,
    pub follow_storage_fee: U128,
    pub launch_cost: U128,
    pub set_fee_deposit: U128,
    pub withdraw_deposit: U128,
    pub min_trade: U128,
    pub min_copy: U128,
    pub default_fee_bps: u16,
    pub max_fee_bps: u16,
    pub max_followers: u32,
    pub max_following: u32,
    pub max_allowance_days: u32,
    pub token_code_bytes: u32,
    pub token_code_sha256: String,
}

#[near(serializers = [json])]
pub struct TotalsView {
    pub curves: U128,
    pub allowances: U128,
    pub claimable: U128,
    /// curves + allowances + claimable: what users could take out.
    pub owed: U128,
    pub storage_fees: U128,
    /// The contract account's NEAR balance right now.
    pub balance: U128,
    /// NEAR the protocol locks for the contract's own storage.
    pub storage_stake: U128,
}

// ---- plans: a trade is sized in full before anything is written -------------------------------

struct CopyBuy {
    follower: AccountId,
    /// The allowance as it will be after this copy.
    allowance: Allowance,
    gross: u128,
    net: u128,
    tokens: u128,
}

struct BuyPlan {
    own_tokens: u128,
    total_net: u128,
    copies: Vec<CopyBuy>,
    expired: Vec<AccountId>,
}

struct CopySell {
    follower: AccountId,
    allowance_id: u64,
    tokens: u128,
    gross: u128,
    /// The follower's position before this sell.
    position: Position,
    fee_bps: u16,
    /// The creator's fee on this sell, from `Position::fee_on`.
    fee: u128,
}

struct SellPlan {
    own_gross: u128,
    total_tokens: u128,
    copies: Vec<CopySell>,
    expired: Vec<AccountId>,
}

#[near]
impl CopyLaunch {
    #[init]
    pub fn new() -> Self {
        Self {
            tokens: IterableMap::new(Key::Tokens),
            balances: LookupMap::new(Key::Balances),
            allowances: LookupMap::new(Key::Allowances),
            followers: LookupMap::new(Key::Followers),
            following: LookupMap::new(Key::Following),
            fee_bps: LookupMap::new(Key::FeeBps),
            copied: LookupMap::new(Key::Copied),
            claimable: LookupMap::new(Key::Claimable),
            trades: Vector::new(Key::Trades),
            stats: LookupMap::new(Key::Stats),
            totals: Totals::default(),
            next_allowance_id: 1,
        }
    }

    // ---- launch ------------------------------------------------------------------------------

    /// Launches a token: records its curve here and deploys its NEP-141 contract at
    /// `<symbol>.<this contract>`, minting the whole supply to this contract. Attach
    /// `get_config().launch_cost`; anything above it comes back.
    #[payable]
    pub fn launch(&mut self, symbol: String, name: String, description: Option<String>, image: Option<String>) -> Promise {
        let creator = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= Self::launch_cost(), "attach at least the launch cost (see get_config)");
        require!(
            (2..=10).contains(&symbol.len()) && symbol.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()),
            "the symbol must be 2 to 10 characters, lower-case letters and digits only"
        );
        let name = name.trim().to_string();
        require!((1..=40).contains(&name.chars().count()), "the name must be 1 to 40 characters");
        let description = description.unwrap_or_default().trim().to_string();
        require!(description.chars().count() <= 280, "the description can be at most 280 characters");
        if let Some(url) = &image {
            require!(url.len() <= 300 && url.starts_with("https://"), "the image must be an https link of at most 300 characters");
        }
        require!(!self.tokens.contains_key(&symbol), "that symbol is taken");

        let current = env::current_account_id();
        let account_id: AccountId = format!("{symbol}.{current}")
            .parse()
            .unwrap_or_else(|_| env::panic_str("the symbol does not make a valid account name"));
        self.tokens.insert(
            symbol.clone(),
            Token {
                symbol: symbol.clone(),
                name: name.clone(),
                description,
                image,
                creator: creator.clone(),
                account_id: account_id.clone(),
                near_reserve: 0,
                token_reserve: TOKEN_SUPPLY,
                created_at_ns: env::block_timestamp(),
                ready: false,
                trades: 0,
                volume: 0,
            },
        );
        self.totals.storage_fees += LAUNCH_STORAGE_FEE;

        let args = json!({
            "owner_id": current,
            "total_supply": U128(TOKEN_SUPPLY),
            "metadata": {
                "spec": "ft-1.0.0",
                "name": name,
                "symbol": symbol.to_uppercase(),
                "icon": null,
                "reference": null,
                "reference_hash": null,
                "decimals": TOKEN_DECIMALS,
            },
        });
        Promise::new(account_id)
            .create_account()
            .transfer(NearToken::from_yoctonear(Self::token_account_deposit()))
            .deploy_contract(TOKEN_WASM.to_vec())
            .function_call("new".to_string(), args.to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_TOKEN_NEW)
            .then(Self::ext(current).with_static_gas(GAS_CALLBACK).on_launch(symbol, creator, U128(deposit)))
    }

    /// Runs after the token contract was (or was not) created.
    #[private]
    pub fn on_launch(&mut self, symbol: String, creator: AccountId, deposit: U128) -> bool {
        if is_promise_success() {
            self.tokens.get_mut(&symbol).unwrap_or_else(|| env::panic_str("unknown token")).ready = true;
            let extra = deposit.0 - Self::launch_cost();
            if extra > 0 {
                Promise::new(creator.clone()).transfer(NearToken::from_yoctonear(extra)).detach();
            }
            emit("launch", json!({ "symbol": symbol, "creator": creator }));
            return true;
        }
        // Creating the token account failed, and the protocol returned what was sent with it.
        // Forget the token and give the launcher everything back.
        self.tokens.remove(&symbol);
        self.totals.storage_fees -= LAUNCH_STORAGE_FEE;
        Promise::new(creator).transfer(NearToken::from_yoctonear(deposit.0)).detach();
        false
    }

    // ---- trading -----------------------------------------------------------------------------

    /// Buys `symbol` with the attached NEAR. If the caller has followers, each live allowance
    /// copies the buy inside its limits, and the caller and every follower get the same price.
    /// Copies pay no creator fee.
    #[payable]
    pub fn buy(&mut self, symbol: String, min_tokens_out: U128) -> Trade {
        let buyer = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        let now = env::block_timestamp();
        let token = self.ready_token(&symbol);
        let plan = self.plan_buy(&buyer, &token, deposit, now);
        require!(plan.own_tokens > 0, "too small to buy any tokens");
        require!(plan.own_tokens >= min_tokens_out.0, "the price moved: you would get fewer tokens than your minimum");

        let own_tokens = plan.own_tokens;
        let mut tokens_sold = own_tokens;
        let mut gross_total = 0u128;
        let mut fills = Vec::with_capacity(plan.copies.len());
        self.credit(&symbol, &buyer, own_tokens);
        for c in plan.copies {
            tokens_sold += c.tokens;
            gross_total += c.gross;
            self.credit(&symbol, &c.follower, c.tokens);
            let ckey = (c.allowance.id, symbol.clone());
            let mut p = self.copied.get(&ckey).copied().unwrap_or_default();
            p.tokens += c.tokens;
            p.paid += c.gross;
            self.copied.insert(ckey, p);
            self.allowances.insert((c.follower.clone(), buyer.clone()), c.allowance);
            fills.push(CopyFill { follower: c.follower, near: U128(c.gross), fee: U128(0), tokens: U128(c.tokens) });
        }
        let t = self.tokens.get_mut(&symbol).unwrap();
        t.near_reserve += plan.total_net;
        t.token_reserve -= tokens_sold;
        t.trades += 1;
        t.volume += plan.total_net;
        self.totals.curves += plan.total_net;
        self.totals.allowances -= gross_total;
        self.totals.storage_fees += (1 + fills.len() as u128) * FILL_STORAGE_FEE;
        if !fills.is_empty() {
            let mut s = self.stats.get(&buyer).cloned().unwrap_or_default();
            s.copied_volume += gross_total;
            s.copies += fills.len() as u64;
            self.stats.insert(buyer.clone(), s);
        }
        let closed = self.close_expired(&buyer, plan.expired);
        self.record(symbol, buyer, Side::Buy, deposit, own_tokens, fills, closed)
    }

    /// Sells `amount` of the caller's tokens back to the curve. If the caller has followers,
    /// each live allowance sells the same share of what it copied, at the same price. Once a
    /// follower has taken out more than they put into that position, the caller gets `fee_bps` of
    /// the excess; before that, nothing.
    /// The caller is paid at once; followers' proceeds and the caller's fees wait in `claim`.
    /// Needs 1 yoctoNEAR attached.
    #[payable]
    pub fn sell(&mut self, symbol: String, amount: U128, min_near_out: U128) -> Trade {
        assert_one_yocto();
        let seller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let token = self.ready_token(&symbol);
        let plan = self.plan_sell(&seller, &token, amount.0, now);
        require!(plan.own_gross > FILL_STORAGE_FEE, "too small to sell: the proceeds would not cover the record fee");
        let own_net = plan.own_gross - FILL_STORAGE_FEE;
        require!(own_net >= min_near_out.0, "the price moved: you would get less NEAR than your minimum");

        let mut paid = plan.own_gross;
        let mut fees = 0u128;
        let mut fills = Vec::with_capacity(plan.copies.len());
        self.debit(&symbol, &seller, amount.0);
        for c in plan.copies {
            paid += c.gross;
            fees += c.fee;
            self.debit(&symbol, &c.follower, c.tokens);
            let ckey = (c.allowance_id, symbol.clone());
            let mut p = c.position;
            let before_fee = c.gross - FILL_STORAGE_FEE;
            p.tokens = p.tokens.saturating_sub(c.tokens);
            p.taken += before_fee;
            p.fees += c.fee;
            self.copied.insert(ckey, p);
            let net = before_fee - c.fee;
            self.add_claimable(&c.follower, net);
            fills.push(CopyFill { follower: c.follower, near: U128(net), fee: U128(c.fee), tokens: U128(c.tokens) });
        }
        if fees > 0 {
            self.add_claimable(&seller, fees);
            let mut s = self.stats.get(&seller).cloned().unwrap_or_default();
            s.fees_earned += fees;
            self.stats.insert(seller.clone(), s);
        }
        let t = self.tokens.get_mut(&symbol).unwrap();
        t.near_reserve -= paid;
        t.token_reserve += plan.total_tokens;
        t.trades += 1;
        t.volume += paid;
        self.totals.curves -= paid;
        self.totals.storage_fees += (1 + fills.len() as u128) * FILL_STORAGE_FEE;
        let closed = self.close_expired(&seller, plan.expired);
        // The attached yocto goes back with the proceeds.
        Promise::new(seller.clone()).transfer(NearToken::from_yoctonear(own_net + 1)).detach();
        self.record(symbol, seller, Side::Sell, own_net, amount.0, fills, closed)
    }

    // ---- following ---------------------------------------------------------------------------

    /// Publishes the caller's share of followers' profit, in basis points. It applies to
    /// allowances granted from now on; existing ones keep the share they were granted at.
    #[payable]
    pub fn set_fee(&mut self, fee_bps: u16) {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= SET_FEE_DEPOSIT, "attach 0.002 NEAR for the record");
        require!(fee_bps <= MAX_FEE_BPS, "the fee can be at most 20% of profit");
        self.fee_bps.insert(env::predecessor_account_id(), fee_bps);
        self.totals.storage_fees += deposit;
    }

    /// Follows `creator`. The attached NEAR, less the 0.01 NEAR record fee, is the total cap:
    /// it is held here and is the most this allowance can ever spend. `per_trade_cap` bounds one
    /// copy, `expires_at_ms` ends it, and `max_fee_bps` is the highest creator fee the caller
    /// accepts as a share of profit (the grant fails if the creator's published share is higher).
    #[payable]
    pub fn follow(&mut self, creator: AccountId, per_trade_cap: U128, expires_at_ms: U64, max_fee_bps: u16) -> AllowanceView {
        let follower = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        let now = env::block_timestamp();
        require!(follower != creator, "you cannot follow yourself");
        require!(deposit >= FOLLOW_STORAGE_FEE + MIN_COPY, "attach the total cap (at least 0.05 NEAR) plus the 0.01 NEAR record fee");
        let total_cap = deposit - FOLLOW_STORAGE_FEE;
        require!(per_trade_cap.0 >= MIN_COPY, "the per-trade cap must be at least 0.05 NEAR");
        require!(per_trade_cap.0 <= total_cap, "the per-trade cap cannot be larger than the total cap");
        let expires_at_ns =
            expires_at_ms.0.checked_mul(1_000_000).unwrap_or_else(|| env::panic_str("the expiry is out of range"));
        require!(expires_at_ns > now, "the expiry must be in the future");
        require!(expires_at_ns - now <= MAX_ALLOWANCE_NS, "the expiry can be at most 365 days away");
        let fee_bps = self.fee_of(&creator);
        require!(fee_bps <= max_fee_bps, "the creator's fee is higher than the fee you accepted");
        let key = (follower.clone(), creator.clone());
        require!(!self.allowances.contains_key(&key), "you already follow this creator: revoke first to change the limits");

        let mut followers = self.followers.get(&creator).cloned().unwrap_or_default();
        require!(followers.len() < MAX_FOLLOWERS, "this creator already has the most followers a copied trade can carry");
        let mut following = self.following.get(&follower).cloned().unwrap_or_default();
        require!(following.len() < MAX_FOLLOWING, "you already follow the most creators one account can");
        followers.push(follower.clone());
        following.push(creator.clone());
        self.followers.insert(creator.clone(), followers);
        self.following.insert(follower.clone(), following);

        let allowance = Allowance {
            id: self.next_allowance_id,
            total_cap,
            spent: 0,
            per_trade_cap: per_trade_cap.0,
            expires_at_ns,
            fee_bps,
            created_at_ns: now,
            copies: 0,
        };
        self.next_allowance_id += 1;
        self.totals.allowances += total_cap;
        self.totals.storage_fees += FOLLOW_STORAGE_FEE;
        let view = allowance_view(&follower, &creator, &allowance, now);
        self.allowances.insert(key, allowance);
        emit("follow", json!({ "follower": follower, "creator": creator, "total_cap": U128(total_cap), "per_trade_cap": per_trade_cap, "expires_at_ms": expires_at_ms, "fee_bps": fee_bps }));
        view
    }

    /// Ends the caller's allowance for `creator` and sends the unspent NEAR straight back.
    /// Tokens already bought stay with the caller and are no longer sold when the creator sells.
    /// Works whether or not the allowance has expired. Needs 1 yoctoNEAR attached.
    #[payable]
    pub fn revoke(&mut self, creator: AccountId) -> U128 {
        assert_one_yocto();
        let follower = env::predecessor_account_id();
        let refunded = self
            .remove_allowance(&follower, &creator)
            .unwrap_or_else(|| env::panic_str("you do not follow this creator"));
        self.totals.allowances -= refunded;
        Promise::new(follower.clone()).transfer(NearToken::from_yoctonear(refunded + 1)).detach();
        emit("revoke", json!({ "follower": follower, "creator": creator, "refunded": U128(refunded) }));
        U128(refunded)
    }

    /// Pays out everything waiting for the caller: creator fees, proceeds of copied sells and
    /// refunds from expired allowances. Needs 1 yoctoNEAR attached.
    #[payable]
    pub fn claim(&mut self) -> U128 {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        let amount = self.claimable.remove(&who).unwrap_or(0);
        require!(amount > 0, "nothing to claim");
        self.totals.claimable -= amount;
        Promise::new(who).transfer(NearToken::from_yoctonear(amount + 1)).detach();
        U128(amount)
    }

    // ---- moving tokens to and from a wallet --------------------------------------------------

    /// Sends `amount` of the caller's tokens out to their own account on the token's NEP-141
    /// contract. Attach 0.002 NEAR: it registers the caller there if needed. If the transfer
    /// fails the tokens are put back.
    #[payable]
    pub fn withdraw_token(&mut self, symbol: String, amount: U128) -> Promise {
        let who = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= WITHDRAW_DEPOSIT, "attach 0.002 NEAR to register on the token contract");
        require!(amount.0 > 0, "the amount must be positive");
        let token = self.ready_token(&symbol);
        self.debit(&symbol, &who, amount.0);
        self.totals.storage_fees += deposit - TOKEN_REGISTRATION - 1;
        Promise::new(token.account_id)
            .function_call(
                "storage_deposit".to_string(),
                json!({ "account_id": who, "registration_only": true }).to_string().into_bytes(),
                NearToken::from_yoctonear(TOKEN_REGISTRATION),
                GAS_TOKEN_CALL,
            )
            .function_call(
                "ft_transfer".to_string(),
                json!({ "receiver_id": who, "amount": amount }).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_TOKEN_CALL,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_withdraw(symbol, who, amount))
    }

    #[private]
    pub fn on_withdraw(&mut self, symbol: String, who: AccountId, amount: U128) -> bool {
        if is_promise_success() {
            return true;
        }
        self.credit(&symbol, &who, amount.0);
        false
    }

    /// NEP-141 receiver: tokens sent here with `ft_transfer_call` are credited to the sender so
    /// they can be sold. Only a token this launchpad deployed is accepted. Keeps the full amount.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let _ = msg;
        let from = env::predecessor_account_id();
        let suffix = format!(".{}", env::current_account_id());
        let symbol = from
            .as_str()
            .strip_suffix(&suffix)
            .unwrap_or_else(|| env::panic_str("only tokens launched here can be deposited"))
            .to_string();
        let token = self.ready_token(&symbol);
        require!(token.account_id == from, "only tokens launched here can be deposited");
        self.credit(&symbol, &sender_id, amount.0);
        U128(0)
    }

    // ---- views -------------------------------------------------------------------------------

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            token_decimals: TOKEN_DECIMALS,
            token_supply: U128(TOKEN_SUPPLY),
            virtual_near: U128(VIRTUAL_NEAR),
            fill_storage_fee: U128(FILL_STORAGE_FEE),
            follow_storage_fee: U128(FOLLOW_STORAGE_FEE),
            launch_cost: U128(Self::launch_cost()),
            set_fee_deposit: U128(SET_FEE_DEPOSIT),
            withdraw_deposit: U128(WITHDRAW_DEPOSIT),
            min_trade: U128(MIN_TRADE),
            min_copy: U128(MIN_COPY),
            default_fee_bps: DEFAULT_FEE_BPS,
            max_fee_bps: MAX_FEE_BPS,
            max_followers: MAX_FOLLOWERS as u32,
            max_following: MAX_FOLLOWING as u32,
            max_allowance_days: (MAX_ALLOWANCE_NS / 86_400_000_000_000) as u32,
            token_code_bytes: TOKEN_WASM.len() as u32,
            token_code_sha256: env::sha256(TOKEN_WASM).iter().map(|b| format!("{b:02x}")).collect(),
        }
    }

    /// What the contract owes, next to what it holds.
    pub fn get_totals(&self) -> TotalsView {
        let t = &self.totals;
        TotalsView {
            curves: U128(t.curves),
            allowances: U128(t.allowances),
            claimable: U128(t.claimable),
            owed: U128(t.curves + t.allowances + t.claimable),
            storage_fees: U128(t.storage_fees),
            balance: U128(env::account_balance().as_yoctonear()),
            storage_stake: U128(env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear()),
        }
    }

    pub fn get_token(&self, symbol: String) -> Option<TokenView> {
        self.tokens.get(&symbol).map(token_view)
    }

    /// Tokens in launch order.
    pub fn get_tokens(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<TokenView> {
        self.tokens
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(token_view)
            .collect()
    }

    pub fn get_token_count(&self) -> u32 {
        self.tokens.len()
    }

    pub fn get_balance(&self, symbol: String, account_id: AccountId) -> U128 {
        U128(self.balance(&symbol, &account_id))
    }

    /// Every token the account holds inside the launchpad.
    pub fn get_holdings(&self, account_id: AccountId) -> Vec<HoldingView> {
        self.tokens
            .keys()
            .filter_map(|symbol| {
                let balance = self.balance(symbol, &account_id);
                (balance > 0).then(|| HoldingView { symbol: symbol.clone(), balance: U128(balance) })
            })
            .collect()
    }

    pub fn get_creator(&self, creator: AccountId) -> CreatorView {
        let s = self.stats.get(&creator).cloned().unwrap_or_default();
        CreatorView {
            fee_bps: self.fee_of(&creator),
            followers: self.followers.get(&creator).map_or(0, |f| f.len() as u32),
            fees_earned: U128(s.fees_earned),
            copied_volume: U128(s.copied_volume),
            copies: s.copies,
            creator,
        }
    }

    pub fn get_allowance(&self, follower: AccountId, creator: AccountId) -> Option<AllowanceView> {
        let now = env::block_timestamp();
        self.allowances.get(&(follower.clone(), creator.clone())).map(|a| allowance_view(&follower, &creator, a, now))
    }

    /// The allowances other accounts have granted this creator.
    pub fn get_followers(&self, creator: AccountId) -> Vec<AllowanceView> {
        let now = env::block_timestamp();
        self.followers
            .get(&creator)
            .map(|list| {
                list.iter()
                    .filter_map(|f| self.allowances.get(&(f.clone(), creator.clone())).map(|a| allowance_view(f, &creator, a, now)))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The allowances this account has granted.
    pub fn get_following(&self, follower: AccountId) -> Vec<AllowanceView> {
        let now = env::block_timestamp();
        self.following
            .get(&follower)
            .map(|list| {
                list.iter()
                    .filter_map(|c| self.allowances.get(&(follower.clone(), c.clone())).map(|a| allowance_view(&follower, c, a, now)))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The follower's position from copying `creator` in `symbol` under their current allowance:
    /// tokens still held, NEAR paid in, NEAR taken out by the creator's sells, fees paid.
    pub fn get_copied(&self, follower: AccountId, creator: AccountId, symbol: String) -> PositionView {
        let p = self
            .allowances
            .get(&(follower, creator))
            .and_then(|a| self.copied.get(&(a.id, symbol)).copied())
            .unwrap_or_default();
        PositionView { tokens: U128(p.tokens), paid: U128(p.paid), taken: U128(p.taken), fees: U128(p.fees) }
    }

    pub fn get_claimable(&self, account_id: AccountId) -> U128 {
        U128(self.claimable.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_trade_count(&self) -> u64 {
        self.trades.len() as u64
    }

    /// The trade log, newest first. `before_index` pages backwards (omit it for the latest).
    pub fn get_trades(&self, before_index: Option<u64>, limit: Option<u32>) -> Vec<Trade> {
        let len = self.trades.len() as u64;
        let end = before_index.unwrap_or(len).min(len);
        let limit = limit.unwrap_or(50).min(100) as u64;
        (end.saturating_sub(limit)..end).rev().filter_map(|i| self.trades.get(i as u32).cloned()).collect()
    }

    /// What `buy` would do right now for `buyer` attaching `near_in`: their tokens and every copy.
    pub fn quote_buy(&self, symbol: String, near_in: U128, buyer: AccountId) -> QuoteView {
        let token = self.ready_token(&symbol);
        let plan = self.plan_buy(&buyer, &token, near_in.0, env::block_timestamp());
        QuoteView {
            own: U128(plan.own_tokens),
            copies: plan
                .copies
                .into_iter()
                .map(|c| CopyFill { follower: c.follower, near: U128(c.gross), fee: U128(0), tokens: U128(c.tokens) })
                .collect(),
        }
    }

    /// What `sell` would do right now for `seller` selling `tokens_in`: their NEAR and every copy.
    pub fn quote_sell(&self, symbol: String, tokens_in: U128, seller: AccountId) -> QuoteView {
        let token = self.ready_token(&symbol);
        let plan = self.plan_sell(&seller, &token, tokens_in.0, env::block_timestamp());
        QuoteView {
            own: U128(plan.own_gross.saturating_sub(FILL_STORAGE_FEE)),
            copies: plan
                .copies
                .into_iter()
                .map(|c| CopyFill { follower: c.follower, near: U128(c.gross - FILL_STORAGE_FEE - c.fee), fee: U128(c.fee), tokens: U128(c.tokens) })
                .collect(),
        }
    }
}

// ---- internals -------------------------------------------------------------------------------

impl CopyLaunch {
    /// NEAR a new token account needs to pay for its own code and state.
    fn token_account_deposit() -> u128 {
        (TOKEN_WASM.len() as u128 + TOKEN_ACCOUNT_EXTRA_BYTES) * env::storage_byte_cost().as_yoctonear()
    }

    fn launch_cost() -> u128 {
        Self::token_account_deposit() + LAUNCH_STORAGE_FEE
    }

    fn ready_token(&self, symbol: &String) -> Token {
        let token = self.tokens.get(symbol).unwrap_or_else(|| env::panic_str("there is no token with that symbol"));
        require!(token.ready, "this token is still being created");
        token.clone()
    }

    fn fee_of(&self, creator: &AccountId) -> u16 {
        self.fee_bps.get(creator).copied().unwrap_or(DEFAULT_FEE_BPS)
    }

    fn balance(&self, symbol: &str, who: &AccountId) -> u128 {
        self.balances.get(&(symbol.to_string(), who.clone())).copied().unwrap_or(0)
    }

    fn credit(&mut self, symbol: &str, who: &AccountId, amount: u128) {
        let key = (symbol.to_string(), who.clone());
        let held = self.balances.get(&key).copied().unwrap_or(0);
        self.balances.insert(key, held + amount);
    }

    fn debit(&mut self, symbol: &str, who: &AccountId, amount: u128) {
        let key = (symbol.to_string(), who.clone());
        let held = self.balances.get(&key).copied().unwrap_or(0);
        require!(held >= amount, "you do not hold that many tokens");
        self.balances.insert(key, held - amount);
    }

    fn add_claimable(&mut self, who: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let held = self.claimable.get(who).copied().unwrap_or(0);
        self.claimable.insert(who.clone(), held + amount);
        self.totals.claimable += amount;
    }

    /// Removes an allowance and both list entries. Returns its unspent NEAR, or `None` if there
    /// was no such allowance. The caller decides where the unspent NEAR goes.
    fn remove_allowance(&mut self, follower: &AccountId, creator: &AccountId) -> Option<u128> {
        let a = self.allowances.remove(&(follower.clone(), creator.clone()))?;
        if let Some(list) = self.followers.get_mut(creator) {
            list.retain(|f| f != follower);
        }
        if let Some(list) = self.following.get_mut(follower) {
            list.retain(|c| c != creator);
        }
        Some(a.remaining())
    }

    /// Closes allowances a trade found expired: the unspent NEAR becomes claimable by the follower.
    fn close_expired(&mut self, creator: &AccountId, followers: Vec<AccountId>) -> Vec<Closed> {
        let mut closed = Vec::with_capacity(followers.len());
        for follower in followers {
            if let Some(refunded) = self.remove_allowance(&follower, creator) {
                self.totals.allowances -= refunded;
                self.add_claimable(&follower, refunded);
                closed.push(Closed { follower, refunded: U128(refunded), reason: "expired".to_string() });
            }
        }
        closed
    }

    /// Sizes a buy and all of its copies without writing anything.
    fn plan_buy(&self, buyer: &AccountId, token: &Token, deposit: u128, now: u64) -> BuyPlan {
        require!(deposit >= MIN_TRADE, "the smallest buy is 0.01 NEAR");
        let own_net = deposit - FILL_STORAGE_FEE;
        let mut copies = Vec::new();
        let mut expired = Vec::new();
        if let Some(list) = self.followers.get(buyer) {
            for follower in list {
                let Some(a) = self.allowances.get(&(follower.clone(), buyer.clone())) else { continue };
                if a.is_expired(now) {
                    expired.push(follower.clone());
                    continue;
                }
                let gross = a.copy_size(deposit, now);
                if gross < MIN_COPY {
                    continue; // used up: nothing left worth copying
                }
                let mut a = a.clone();
                if a.spend(gross, now).is_err() {
                    continue; // the gate refused: no copy
                }
                let net = gross - FILL_STORAGE_FEE;
                copies.push(CopyBuy { follower: follower.clone(), allowance: a, gross, net, tokens: 0 });
            }
        }
        // One price for everybody: the whole batch buys together and is shared out by NEAR paid in.
        let total_net = own_net + copies.iter().map(|c| c.net).sum::<u128>();
        let tokens_out = curve::buy_out(VIRTUAL_NEAR, token.near_reserve, token.token_reserve, total_net);
        for c in copies.iter_mut() {
            c.tokens = mul_div(tokens_out, c.net, total_net);
        }
        BuyPlan { own_tokens: mul_div(tokens_out, own_net, total_net), total_net, copies, expired }
    }

    /// Sizes a sell and all of its copies without writing anything.
    fn plan_sell(&self, seller: &AccountId, token: &Token, amount: u128, now: u64) -> SellPlan {
        let held = self.balance(&token.symbol, seller);
        require!(amount > 0, "the amount must be positive");
        require!(amount <= held, "you do not hold that many tokens");
        let mut copies = Vec::new();
        let mut expired = Vec::new();
        if let Some(list) = self.followers.get(seller) {
            for follower in list {
                let Some(a) = self.allowances.get(&(follower.clone(), seller.clone())) else { continue };
                if a.is_expired(now) {
                    expired.push(follower.clone());
                    continue;
                }
                let p = self.copied.get(&(a.id, token.symbol.clone())).copied().unwrap_or_default();
                // The same share of the copied position as the seller sells of their own holding.
                let tokens = mul_div(p.tokens, amount, held).min(self.balance(&token.symbol, follower));
                if tokens > 0 {
                    copies.push(CopySell { follower: follower.clone(), allowance_id: a.id, tokens, gross: 0, position: p, fee_bps: a.fee_bps, fee: 0 });
                }
            }
        }
        let price = |copies: &Vec<CopySell>| {
            let total_tokens = amount + copies.iter().map(|c| c.tokens).sum::<u128>();
            let near_out = curve::sell_out(VIRTUAL_NEAR, token.near_reserve, token.token_reserve, total_tokens)
                .unwrap_or_else(|| env::panic_str("the curve cannot pay for this sale"));
            (total_tokens, near_out)
        };
        // A copy whose proceeds would not cover the record fee is left out. Dropping copies only
        // raises the price for the rest, so one pass is enough.
        let (total_tokens, near_out) = price(&copies);
        copies.retain(|c| mul_div(near_out, c.tokens, total_tokens) > FILL_STORAGE_FEE);
        let (total_tokens, near_out) = price(&copies);
        for c in copies.iter_mut() {
            c.gross = mul_div(near_out, c.tokens, total_tokens);
            require!(c.gross > FILL_STORAGE_FEE, "a copied sale would not cover its record fee");
            // The creator shares in profit only: what the follower has taken out beyond what they put in.
            c.fee = c.position.fee_on(c.gross - FILL_STORAGE_FEE, c.fee_bps);
        }
        SellPlan { own_gross: mul_div(near_out, amount, total_tokens), total_tokens, copies, expired }
    }

    #[allow(clippy::too_many_arguments)]
    fn record(&mut self, symbol: String, trader: AccountId, side: Side, near: u128, tokens: u128, copies: Vec<CopyFill>, closed: Vec<Closed>) -> Trade {
        let trade = Trade {
            index: self.trades.len() as u64,
            symbol,
            trader,
            side,
            near: U128(near),
            tokens: U128(tokens),
            timestamp_ms: env::block_timestamp() / 1_000_000,
            copies,
            closed,
        };
        self.trades.push(trade.clone());
        emit("trade", json!(trade));
        trade
    }
}

fn token_view(t: &Token) -> TokenView {
    TokenView {
        symbol: t.symbol.clone(),
        name: t.name.clone(),
        description: t.description.clone(),
        image: t.image.clone(),
        creator: t.creator.clone(),
        account_id: t.account_id.clone(),
        near_reserve: U128(t.near_reserve),
        token_reserve: U128(t.token_reserve),
        virtual_near: U128(VIRTUAL_NEAR),
        supply: U128(TOKEN_SUPPLY),
        created_at_ms: t.created_at_ns / 1_000_000,
        ready: t.ready,
        trades: t.trades,
        volume: U128(t.volume),
    }
}

fn allowance_view(follower: &AccountId, creator: &AccountId, a: &Allowance, now_ns: u64) -> AllowanceView {
    AllowanceView {
        id: a.id,
        follower: follower.clone(),
        creator: creator.clone(),
        total_cap: U128(a.total_cap),
        spent: U128(a.spent),
        remaining: U128(a.remaining()),
        per_trade_cap: U128(a.per_trade_cap),
        expires_at_ms: a.expires_at_ns / 1_000_000,
        expired: a.is_expired(now_ns),
        fee_bps: a.fee_bps,
        created_at_ms: a.created_at_ns / 1_000_000,
        copies: a.copies,
    }
}

/// NEP-297 event log.
fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "copylaunch", "version": "1.0.0", "event": event, "data": [data] })
    ));
}
