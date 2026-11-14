# CopyLaunch

A memecoin launchpad on NEAR testnet where following a creator is an on-chain allowance: a total cap,
a cap per trade, an end date, revocable at any time. When the creator buys, every follower's allowance
buys in the same transaction, at the same price as the creator. A copy that would break a limit does
not happen. The creator earns nothing from copies, only a share of what followers take out beyond what
they put in.

Built at NEAR HACKATHON 2026. Tracks: Memecoins With Mechanics (`memecoins`), Unstoppable DeFi (`defi`).
Status: deployed on testnet, not audited, testnet NEAR only.

## Deployed on testnet

| What | Where |
| --- | --- |
| Web app | https://nuel-osas.github.io/copylaunch/ (a token link: `#t/<symbol>`, e.g. [`#t/frog4frv`](https://nuel-osas.github.io/copylaunch/#t/frog4frv)) |
| Launchpad contract | [`copylaunch.testnet`](https://testnet.nearblocks.io/address/copylaunch.testnet), code hash `4D1c2uH5dPT9Dp4sZpFCKRf61LigGtzjS1ETu9beWSwo` |
| Deploy transactions | first deploy [`7HjjG2cc…`](https://testnet.nearblocks.io/txns/7HjjG2ccWD1jFHUcPTbD8EkPp1M5PiD5jvACUmrs9Qej), init [`6absJQHg…`](https://testnet.nearblocks.io/txns/6absJQHguLB947DJNRHviT6nxvhNzNEnSsxnwZvapYyf); upgrade to the profit-only fee and the withdrawal rule [`FriReWaP…`](https://testnet.nearblocks.io/txns/FriReWaP46HPprjXHDbYeZ3XgeXAqRQnYVXXoGG9qgTi) (state kept: no allowance was live) |
| Token contract code (one copy per launch) | sha256 `541ae10b335c65d32a0e43d70860272801147acc544c24a0b4c0883cb5dc883c` |
| Example tokens | [`frog4frv.copylaunch.testnet`](https://testnet.nearblocks.io/address/frog4frv.copylaunch.testnet) (the recorded run), [`frog4tt3.copylaunch.testnet`](https://testnet.nearblocks.io/address/frog4tt3.copylaunch.testnet) (before the upgrade), [`frog8bw6.copylaunch.testnet`](https://testnet.nearblocks.io/address/frog8bw6.copylaunch.testnet) (NEP-141) |
| Accounts used by the walkthrough | `cl-dev.testnet` (creator), `cl-ann.testnet` and `cl-bob.testnet` (followers) |
| Every transaction of the recorded run (50 of 50 checks) | [`docs/testnet-run.json`](docs/testnet-run.json) |

`make build && make check-deployed` rebuilds both contracts and compares them with the code on
testnet. On the machine that deployed them (macOS, rustc 1.93.1, wasm-opt 133) the hashes match.
Another machine or another wasm-opt can produce different bytes.

## The problem

Copying a trader on a memecoin launchpad today means one of two things. A bot holds a key to your
wallet and buys after the trader does. The bot can spend everything the key reaches, and it buys in a
later block, after the trader's own buy has already moved the price, so the follower pays more than the
person they copy. On NEAR there is also no way to let a contract pull a limited amount of native NEAR
from a wallet: a key either can move funds or it cannot.

CopyLaunch moves the copy into the contract:

- The follower deposits the most they are willing to spend. That deposit is the allowance's total cap.
  Nothing else in their wallet is reachable.
- The contract enforces the per-trade cap, the total cap and the end date on every copy. Revoking
  returns the unspent part in the same transaction.
- The creator's buy and every copy are filled as one batch on the curve and shared out by NEAR paid
  in, so everybody gets the same price. The creator cannot buy first and let followers push the price
  up for them.
- The creator is paid only out of followers' profit, so trading back and forth to collect fees earns
  them nothing, and they cannot take their tokens out of the launchpad while followers hold copies.

## Try it

### 1. In a browser (testnet wallet)

1. Open https://nuel-osas.github.io/copylaunch/ (or run `make web` and open http://localhost:5173).
   See: a live ticker of trades, every meme with a sparkline of its price, and below it each trade with the
   followers that copied it, all read from `copylaunch.testnet`.
2. Press "Connect" and pick a testnet wallet (Meteor, MyNearWallet, Intear or HERE).
   See: your account in the header.
3. Launch: open "Launch", fill in symbol and name, press "Launch for 1.711 NEAR".
   See: the new meme's page; its contract `<symbol>.copylaunch.testnet` exists on the explorer.
4. Follow: open a creator's page (click their name anywhere), set a total cap, a cap per trade and an end
   date under "Put a leash on it", press "Follow and lock".
   See: the leash under "My flock · Leashes you hold", with spent / total and a countdown.
5. Buy as the creator (a second account): open the meme's page. Before you sign, the trade box lists every
   follower who will buy with you and how much. Buy.
   See: a panel naming the followers who bought in the same transaction; in the trades list, one line per
   copy, each cut to its own per-trade cap, and "no fee on copies".
6. Let go as the follower: "My flock", then "Let go: get N NEAR back".
   See: the NEAR back in the wallet in the same transaction; the creator's next buy is not copied.

Other pages: "Lead ducks" ranks creators by followers, with what their followers put in and took out;
"Rules" shows every contract constant, whether the contract account is locked, and owed against held.
Each meme's price chart is rebuilt by replaying the contract's trade log, and says so when the replay ends
exactly on the curve the contract reports. A link `#/t/<symbol>` opens a meme; `#/c/<account>` a creator.

### 2. Without a wallet (read only)

```bash
near contract call-function as-read-only copylaunch.testnet get_config json-args '{}' network-config testnet now
near contract call-function as-read-only copylaunch.testnet get_trades json-args '{"limit":5}' network-config testnet now
near contract call-function as-read-only copylaunch.testnet get_totals json-args '{}' network-config testnet now
```

See: every parameter, the latest trades with their copies, and owed against held.

### 3. The whole flow with real transactions

```bash
# three faucet-funded testnet accounts (keys stay in ~/.near-credentials on this machine)
for a in my-dev my-ann my-bob; do
  near account create-account sponsor-by-faucet-service $a.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
done
CREATOR=my-dev.testnet FAN1=my-ann.testnet FAN2=my-bob.testnet make demo
```

See: 23 testnet transactions with explorer links and 50 checks, ending in "50 of 50 checks passed".
It launches a token, grants two allowances, has the contract refuse five bad grants, copies a buy at one
price with no fee, mirrors a partial sell with no fee (nobody has their money back yet), lets an outside
buy lift the price, mirrors the creator's exit and checks the fee is exactly 10% of each follower's
profit, lets one allowance expire, refuses the creator's withdrawal while a follower holds copies,
revokes, lets the creator withdraw, claims, and moves a token to a wallet as plain NEP-141 and back.
Takes about three minutes (one step waits for an expiry). In the recorded run the followers got back
0.5778 NEAR on 0.5 and 1.1716 on 1, and paid the creator 0.0078 and 0.0172.

### 4. Tests

```bash
make test
```

See: 89 tests pass (4 token, 85 launchpad), with no network and no keys.

## How it works

### The allowance (`contracts/launchpad/src/allowance.rs`)

| Limit | Enforced where | Refused how | Test |
| --- | --- | --- | --- |
| Total cap | `Allowance::spend` | `OverTotalCap`; copies are sized to what is left | `copies_stop_at_the_total_cap_and_never_go_over_it`, `the_last_yocto_can_be_spent_and_then_nothing_more` |
| Per-trade cap | `Allowance::spend` | `OverPerTradeCap`; copies are cut down to it | `a_copy_is_cut_down_to_the_per_trade_cap`, `a_spend_over_the_per_trade_cap_is_refused_and_changes_nothing` |
| End date | `Allowance::spend` (at or after `expires_at_ns`) | `Expired`; the next trade closes it and its rest becomes claimable | `an_expired_allowance_copies_nothing_and_is_closed_with_the_rest_claimable`, `one_nanosecond_before_expiry_the_copy_still_happens` |
| Revocable | `revoke` | unspent NEAR sent back in the same call; needs 1 yoctoNEAR (a full-access signature) | `revoking_sends_the_unspent_near_back_and_ends_the_copying`, `revoking_needs_a_full_access_signature` |
| Fee ceiling | `follow` | the grant fails if the creator's profit share is above `max_fee_bps`; later rises do not apply | `raising_the_fee_later_does_not_touch_an_allowance_already_granted` |
| Bad grants | `follow` | per-trade above total, below 0.05 NEAR, expiry past or over 365 days, self-follow, duplicate | one `should_panic` test each |

The allowance is funded rather than pulled. NEAR has no way for a contract to take native NEAR out of
an account later, so the follower deposits `total_cap` when following and the contract holds it. This is
the closest NEAR equivalent of a scoped spending allowance, and it means a copy can never fail for lack
of funds.

### A copied buy (`buy`, `plan_buy`)

1. The creator attaches NEAR to `buy`.
2. For each follower: if the allowance has expired it is closed and skipped; otherwise the copy is
   `min(creator's amount, per-trade cap, what is left)`, debited through `Allowance::spend`. Copies under
   0.05 NEAR are skipped.
3. Copies pay no fee.
4. The creator's NEAR and every copy's NEAR go into the curve as one fill. The tokens out are shared in
   proportion to NEAR paid in, so the price is the same for all of them.
5. One `Trade` record holds the creator's fill, each copy and each allowance closed.

Everything happens in one receipt. If any step fails, none of it happened.

### A copied sell (`sell`, `plan_sell`)

When the creator sells a share of their holding, each live allowance sells the same share of the tokens
its copies bought for that token, at the same price, in the same transaction. Tokens a follower bought
themselves are never touched. The creator is paid at once; followers' proceeds wait in `claim`.

### The creator's fee: a share of profit, measured in cash (`Position::fee_on`)

Each follower's copies of one creator in one token form a position that records the NEAR paid in, the
NEAR the creator's sells took out, and the fees paid. The creator gets `fee_bps` (10% unless they set
another, at most 20%) of what has come out beyond what went in. Until a follower has their money back,
the creator earns nothing.

The rule is measured on cash rather than on prices on purpose. On a curve, the first part of a position
sells back for more than its average cost, so a fee on each partial sell against average cost would pay
a creator who sold in small pieces on a round trip that made nobody any money
(`selling_in_small_pieces_earns_the_creator_nothing_either`). Buying with followers copying and selling,
over and over, earns the creator nothing either
(`a_creator_trading_back_and_forth_earns_nothing_from_followers`, 32 followers, highest fee, five rounds).

### No side door (`withdraw_token`)

While anyone with a live allowance for a creator holds tokens their copies bought, the creator cannot
withdraw that token to a wallet. They can only sell it here, which takes the followers out at the same
price. Otherwise a creator could move their tokens out and sell them from another account at the price
their followers' buying pushed up (`a_creator_cannot_withdraw_a_token_their_followers_hold_copies_of`).

### The token (`contracts/token`)

`launch` creates `<symbol>.copylaunch.testnet`, deploys a standard NEP-141 / NEP-145 / NEP-148 contract
built on `near-contract-standards`, and mints the whole supply (one billion, 18 decimals) to the
launchpad in the same receipt. If that fails, the launch is undone and the launcher refunded. The token
contract has no owner, no mint and no burn after that. Holders can move tokens out to their wallet
(`withdraw_token`) and back in (`ft_transfer_call` to the launchpad).

### The curve (`contracts/launchpad/src/curve.rs`)

Constant product with a virtual reserve of 20 NEAR: tokens out = `token_reserve × near_in /
(20 NEAR + near_reserve + near_in)`. Intermediate products use 256-bit integers and every result rounds
down in the curve's favour, so the curve can always pay for every token it sold
(`if_everybody_sells_everything_the_curve_pays_them_all_and_is_left_with_dust`).

### The books (`get_totals`)

The contract keeps running sums of what it owes (NEAR in curves, unspent allowances, unclaimed fees and
proceeds) next to its own balance and the NEAR locked for its storage. A randomised test runs 600 mixed
trades, follows, revokes and claims and checks after every step that no NEAR or token appears or
disappears and that no allowance spent past its cap
(`after_any_mix_of_trades_follows_and_revokes_the_books_still_balance`).

### Parameters

All constants in `contracts/launchpad/src/lib.rs`, readable through `get_config`. The contract has no
owner, no admin method, no upgrade method and no pause. Each token account has no access keys at all.

The `copylaunch.testnet` account itself still holds the deployer's full-access key, so whoever holds
that key could deploy different code. Deleting that key locks the contract for good; it has not been
done yet. Check the current state with
`near account list-keys copylaunch.testnet network-config testnet now` (the web app's Rules section
shows it too).

| Parameter | Value |
| --- | --- |
| Supply per token | 1,000,000,000 (18 decimals), all in the curve, no allocation to anyone |
| Virtual reserve | 20 NEAR |
| Smallest buy / smallest copy | 0.01 NEAR / 0.05 NEAR |
| Flat record fee | 0.005 NEAR per fill, 0.01 NEAR per follow (covers storage) |
| Creator fee | 10% of followers' profit by default, at most 20%; nothing on copied buys |
| Followers per creator / creators per follower | 32 / 16 |
| Longest allowance | 365 days |
| Launch cost | 1.711 NEAR on testnet today: the token contract's storage plus 0.02 NEAR |

## Measured

| What | Value | How |
| --- | --- | --- |
| Gas of a buy copied by 2 followers | 4.0 Tgas | `docs/testnet-run.json` |
| Gas of a sell mirrored by 2 followers, with the profit fee | 4.8 Tgas | same |
| Gas of a launch (first receipt) | 12.3 Tgas | same |
| State written by a buy copied by 32 followers with 64-character names | 12,300 bytes; the flat fees collected cover 1.3x its storage cost | unit test `the_flat_fees_cover_the_bytes_even_with_the_longest_account_names` |

Not measured on chain: the gas of a buy with 32 followers.

## Limits

- Testnet only. Not audited.
- The launchpad account still has its deployer's key (see Parameters), so the code can still be replaced.
- Same-price copying protects followers from the creator's own account, not from other accounts the
  creator controls: a second account could buy before the creator and sell after the followers' buys
  lift the price. Followers' caps bound what that can cost them.
- When an allowance ends, the creator's later sells no longer take that follower's copied tokens out,
  and the withdrawal block stops covering them; the follower sells them when they choose.
- 32 followers per creator, so one copied trade stays well inside one transaction's gas.
- Storage is paid by flat fees, sized for the worst case in a unit test, not metered per call.
- Followers' sell proceeds and expiry refunds wait in `claim` rather than being pushed, so one trade
  does not send dozens of transfers.
- Tokens bought here are held by the launchpad until withdrawn to a wallet.
- The pre-launch fixed-price round from the original plan was not built.
- The web app's wallet path is built on wallet-selector 10.1.4. It was rendered and read against
  testnet; signing through a browser wallet was not exercised by an automated test. Every contract
  method it calls is exercised by `make demo` with real testnet transactions.

## Why it does not use NEAR Intents

NEAR Intents (`intents.near`) and its 1Click API run on mainnet only: `intents.testnet` holds no
contract and the Intents documentation describes no testnet. CopyLaunch's copies fill on its own
curve, which Intents cannot reach, so Intents would only sit at the edges: a follower could fund an
allowance with USDC from Base, Solana or Ethereum through 1Click (wNEAR delivered to the follower,
then deposited with `ft_transfer_call`), and claimed proceeds could leave the same way. That needs a
mainnet deployment and wNEAR support in `follow`. Neither is built.

## Repository

| Path | What |
| --- | --- |
| `contracts/launchpad/src/lib.rs` | Launch, buy, sell, follow, revoke, claim, withdraw, views |
| `contracts/launchpad/src/allowance.rs` | The allowance and its limits, with tests |
| `contracts/launchpad/src/curve.rs` | The price curve and 256-bit maths, with tests |
| `contracts/launchpad/src/tests.rs` | Contract-level tests, including the randomised books test |
| `contracts/token/src/lib.rs` | The NEP-141 token deployed per launch |
| `scripts/build.sh` | Builds both contracts into `build/` |
| `scripts/deploy.mjs`, `scripts/demo.mjs`, `scripts/check-deployed.mjs` | Testnet deploy, walkthrough, code check |
| `web/` | The web app (React, Vite, wallet-selector) |

## Libraries, templates and AI

- Contracts: `near-sdk` 5.29.1, `near-contract-standards` 5.29.1 (the token's NEP-141/145/148 logic),
  `uint` 0.9.5 (256-bit intermediate maths).
- Scripts: `near-api-js` 7.4.0. CLI: `near-cli-rs` 0.30.1. Build: `wasm-opt` (binaryen) 133.
- Web: React 19.3.1, Vite 8.3.8, `@near-wallet-selector/*` 10.1.4, `buffer` 6.0.3. Fonts: Archivo and
  JetBrains Mono from Google Fonts (SIL Open Font License).
- No template was used.
- AI: the code, tests and this README were written with Claude Code (Anthropic) under the author's
  direction, and reviewed and run by the author.

## Other project

The same team also submitted **Waterline** (Investment Thesis track), an independent project:
https://github.com/Nuel-osas/waterline. The two share no code.

## Licence

MIT. See [LICENSE](LICENSE).
