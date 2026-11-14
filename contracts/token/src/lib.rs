//! The token contract CopyLaunch deploys once per launch.
//!
//! Standard NEP-141 (transfers), NEP-145 (storage) and NEP-148 (metadata), built on
//! `near-contract-standards`. The whole supply is minted once, to the launchpad, when the
//! contract is created. There is no owner, no mint method and no burn method after that.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::{log, near, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue};

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Token,
    Metadata,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
}

#[near]
impl Contract {
    /// Creates the token and mints `total_supply` to `owner_id` (the launchpad). Runs once.
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128, metadata: FungibleTokenMetadata) -> Self {
        metadata.assert_valid();
        let mut this = Self {
            token: FungibleToken::new(StorageKey::Token),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
        };
        this.token.internal_register_account(&owner_id);
        this.token.internal_deposit(&owner_id, total_supply.0);
        FtMint { owner_id: &owner_id, amount: total_supply, memo: Some("whole supply, minted once at launch") }.emit();
        this
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            log!("Account @{} burned {}", sender_id, burned);
        }
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        // `force` would burn the caller's balance. Not offered here: the supply never changes,
        // so an account can only unregister once its balance is zero.
        let _ = force;
        self.token.internal_storage_unregister(Some(false)).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_contract_standards::fungible_token::metadata::FT_METADATA_SPEC;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn meta() -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Frog".into(),
            symbol: "FROG".into(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 18,
        }
    }

    fn as_caller(who: &str, yocto: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("frog.pad.test"))
            .predecessor_account_id(acc(who))
            .attached_deposit(NearToken::from_yoctonear(yocto))
            .build());
    }

    #[test]
    fn the_whole_supply_is_minted_once_to_the_launchpad() {
        as_caller("pad.test", 0);
        let c = Contract::new(acc("pad.test"), U128(1_000), meta());
        assert_eq!(c.ft_total_supply().0, 1_000);
        assert_eq!(c.ft_balance_of(acc("pad.test")).0, 1_000);
        assert_eq!(c.ft_metadata().symbol, "FROG");
        assert_eq!(c.ft_metadata().decimals, 18);
    }

    #[test]
    fn a_transfer_moves_tokens_and_keeps_the_supply() {
        as_caller("pad.test", 0);
        let mut c = Contract::new(acc("pad.test"), U128(1_000), meta());
        as_caller("alice.test", c.storage_balance_bounds().min.as_yoctonear());
        c.storage_deposit(None, None);
        as_caller("pad.test", 1);
        c.ft_transfer(acc("alice.test"), U128(400), None);
        assert_eq!(c.ft_balance_of(acc("alice.test")).0, 400);
        assert_eq!(c.ft_balance_of(acc("pad.test")).0, 600);
        assert_eq!(c.ft_total_supply().0, 1_000);
    }

    #[test]
    #[should_panic(expected = "have enough balance")]
    fn nobody_can_send_more_than_they_hold() {
        as_caller("pad.test", 0);
        let mut c = Contract::new(acc("pad.test"), U128(1_000), meta());
        as_caller("alice.test", c.storage_balance_bounds().min.as_yoctonear());
        c.storage_deposit(None, None);
        as_caller("pad.test", 1);
        c.ft_transfer(acc("alice.test"), U128(1_001), None);
    }

    #[test]
    #[should_panic(expected = "is not registered")]
    fn a_transfer_to_an_unregistered_account_fails() {
        as_caller("pad.test", 0);
        let mut c = Contract::new(acc("pad.test"), U128(1_000), meta());
        as_caller("pad.test", 1);
        c.ft_transfer(acc("bob.test"), U128(1), None);
    }
}
