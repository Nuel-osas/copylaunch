// Walks through CopyLaunch on NEAR testnet with real transactions and checks every step.
//
//   node scripts/demo.mjs
//
// Needs three funded testnet accounts whose keys near-cli saved on this machine: a creator and
// two followers (defaults below, or CREATOR / FAN1 / FAN2). SYMBOL reuses an existing token
// instead of launching a new one. Exits non-zero if any check fails.

import fs from 'node:fs';
import path from 'node:path';
import { CONTRACT, EXPLORER, NEAR, account, balanceOf, call, near, root, sleep, tgas, tokens, view, yocto } from './lib.mjs';

const CREATOR = process.env.CREATOR ?? 'cl-dev.testnet';
const FAN1 = process.env.FAN1 ?? 'cl-ann.testnet';
const FAN2 = process.env.FAN2 ?? 'cl-bob.testnet';
const SYMBOL = process.env.SYMBOL ?? `frog${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')}`;
const TOKEN = `${SYMBOL}.${CONTRACT}`;

const creator = account(CREATOR);
const fan1 = account(FAN1);
const fan2 = account(FAN2);
const cfg = await view(CONTRACT, 'get_config');
const FILL_FEE = BigInt(cfg.fill_storage_fee);

let step = 0;
let checks = 0;
const failures = [];
const txs = [];

function heading(text) {
  step += 1;
  console.log(`\n${String(step).padStart(2, '0')}  ${text}`);
}
function check(ok, text) {
  checks += 1;
  console.log(`      ${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failures.push(`step ${step}: ${text}`);
}
/** Sends a call that is expected to succeed. */
async function tx(signer, method, args, opts, label, contract = CONTRACT) {
  const r = await call(signer, contract, method, args, opts);
  txs.push({ step, label, account: signer.accountId, method, ok: r.ok, hash: r.hash, gas_tgas: Number(tgas(r.gas)) });
  console.log(`      ${label}: ${EXPLORER}${r.hash}  (${tgas(r.gas)} Tgas)`);
  if (!r.ok) {
    check(false, `${method} failed: ${r.error}`);
    throw new Error(`${method} failed: ${r.error}`);
  }
  return r;
}
/** Sends a call that the contract must refuse, and checks the reason. */
async function refused(signer, method, args, opts, reason, label) {
  const r = await call(signer, CONTRACT, method, args, opts);
  txs.push({ step, label, account: signer.accountId, method, ok: r.ok, hash: r.hash, refused: true });
  console.log(`      ${label}: ${EXPLORER}${r.hash}`);
  check(!r.ok && String(r.error).includes(reason), `refused with "${reason}"${r.ok ? ' (it went through!)' : r.error?.includes(reason) ? '' : `, got "${r.error}"`}`);
}
const allowance = (follower) => view(CONTRACT, 'get_allowance', { follower, creator: CREATOR });
const held = async (who) => BigInt(await view(CONTRACT, 'get_balance', { symbol: SYMBOL, account_id: who }));
const claimable = async (who) => BigInt(await view(CONTRACT, 'get_claimable', { account_id: who }));
/** NEAR per token times 1e18, for comparing prices. */
const price = (nearIn, tokensOut) => (BigInt(nearIn) * 10n ** 18n) / BigInt(tokensOut);
const close = (a, b) => (a > b ? a - b : b - a) <= 2n;

console.log(`CopyLaunch on testnet: ${CONTRACT}`);
console.log(`creator ${CREATOR}, followers ${FAN1} and ${FAN2}, token ${SYMBOL}`);

// ---- start from a clean slate if an earlier run left allowances behind ---------------------
for (const fan of [fan1, fan2]) {
  if (await allowance(fan.accountId)) await call(fan, CONTRACT, 'revoke', { creator: CREATOR }, { deposit: 1n });
}

heading('The creator launches a token: a curve here, and a NEP-141 contract of its own');
if (await view(CONTRACT, 'get_token', { symbol: SYMBOL })) {
  console.log(`      ${SYMBOL} already exists: reusing it`);
} else {
  await tx(creator, 'launch', { symbol: SYMBOL, name: 'Copy Frog', description: 'Launched by scripts/demo.mjs', image: null }, { deposit: BigInt(cfg.launch_cost) }, 'launch');
}
const token = await view(CONTRACT, 'get_token', { symbol: SYMBOL });
check(token?.ready === true, `${SYMBOL} is live on the launchpad`);
const meta = await view(TOKEN, 'ft_metadata');
check(meta.symbol === SYMBOL.toUpperCase() && meta.decimals === 18, `${TOKEN} answers ft_metadata: ${meta.symbol}, ${meta.decimals} decimals`);
const supply = BigInt(await view(TOKEN, 'ft_total_supply'));
const padHolds = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: CONTRACT }));
check(supply === BigInt(cfg.token_supply), `total supply is ${tokens(supply)}, minted once`);

heading('Two followers grant the creator a scoped allowance');
const hour = Date.now() + 3_600_000;
const soon = Date.now() + 150_000;
await tx(fan1, 'follow', { creator: CREATOR, per_trade_cap: yocto('0.5').toString(), expires_at_ms: String(hour), max_fee_bps: Number(cfg.default_fee_bps) }, { deposit: yocto('1.5') + BigInt(cfg.follow_storage_fee) }, `${FAN1} follows: 1.5 NEAR in total, 0.5 per trade, one hour`);
await tx(fan2, 'follow', { creator: CREATOR, per_trade_cap: yocto('1').toString(), expires_at_ms: String(soon), max_fee_bps: Number(cfg.default_fee_bps) }, { deposit: yocto('1') + BigInt(cfg.follow_storage_fee) }, `${FAN2} follows: 1 NEAR in total, 1 per trade, 150 seconds`);
let a1 = await allowance(FAN1);
let a2 = await allowance(FAN2);
check(a1.total_cap === yocto('1.5').toString() && a1.per_trade_cap === yocto('0.5').toString() && a1.spent === '0', `${FAN1}'s limits are on chain: cap 1.5, per trade 0.5, spent 0`);
check(a2.total_cap === yocto('1').toString() && a2.fee_bps === Number(cfg.default_fee_bps), `${FAN2}'s limits are on chain: cap 1, creator's share ${cfg.default_fee_bps / 100}% of profit`);

heading('Grants the contract refuses');
await refused(fan1, 'follow', { creator: CREATOR, per_trade_cap: yocto('0.5').toString(), expires_at_ms: String(hour), max_fee_bps: Number(cfg.default_fee_bps) }, { deposit: yocto('1') }, 'you already follow this creator', 'a second allowance for the same creator');
await refused(creator, 'follow', { creator: FAN1, per_trade_cap: yocto('2').toString(), expires_at_ms: String(hour), max_fee_bps: Number(cfg.default_fee_bps) }, { deposit: yocto('1') }, 'the per-trade cap cannot be larger than the total cap', 'a per-trade cap above the total cap');
await refused(creator, 'follow', { creator: FAN1, per_trade_cap: yocto('0.5').toString(), expires_at_ms: String(Date.now() - 60_000), max_fee_bps: Number(cfg.default_fee_bps) }, { deposit: yocto('1') }, 'the expiry must be in the future', 'an expiry in the past');
await refused(creator, 'follow', { creator: FAN1, per_trade_cap: yocto('0.5').toString(), expires_at_ms: String(hour), max_fee_bps: 0 }, { deposit: yocto('1') }, "the creator's fee is higher than the fee you accepted", 'a creator fee above what the follower accepts');
await refused(fan2, 'on_launch', { symbol: SYMBOL, creator: FAN2, deposit: '0' }, {}, 'Method on_launch is private', 'an outsider calling the launch callback');

heading('The creator buys 1 NEAR: both allowances copy it, inside their limits, at one price');
const feesBefore = await claimable(CREATOR);
const buy1 = await tx(creator, 'buy', { symbol: SYMBOL, min_tokens_out: '0' }, { deposit: yocto('1') }, 'buy');
const t1 = buy1.value;
const c1 = t1.copies.find((c) => c.follower === FAN1);
const c2 = t1.copies.find((c) => c.follower === FAN2);
check(t1.copies.length === 2, `two copies in the same transaction (${tgas(buy1.gas)} Tgas for the whole batch)`);
check(c1?.near === yocto('0.5').toString(), `${FAN1} spent 0.5 NEAR: the creator bought 1, the per-trade cap is 0.5`);
check(c2?.near === yocto('1').toString(), `${FAN2} spent 1 NEAR: the same as the creator`);
const p0 = price(yocto('1') - FILL_FEE, t1.tokens);
const p1 = price(BigInt(c1.near) - BigInt(c1.fee) - FILL_FEE, c1.tokens);
const p2 = price(BigInt(c2.near) - BigInt(c2.fee) - FILL_FEE, c2.tokens);
check(close(p0, p1) && close(p0, p2), `one price for all three: ${near(p0 * 10n ** 6n, 6)} NEAR per million tokens`);
check(c1.fee === '0' && c2.fee === '0', 'copied buys paid the creator nothing');
check((await claimable(CREATOR)) === feesBefore, 'the creator earned no fee from the copies');
a1 = await allowance(FAN1);
check(a1.spent === yocto('0.5').toString() && a1.remaining === yocto('1').toString(), `${FAN1}'s allowance: 0.5 spent, 1 left`);
check((await held(FAN1)) === BigInt(c1.tokens), `${FAN1} holds ${tokens(c1.tokens)} ${SYMBOL.toUpperCase()}`);

heading('The creator sells half: each follower sells half of what they copied, at the same price');
const before1 = await claimable(FAN1);
const sell1 = await tx(creator, 'sell', { symbol: SYMBOL, amount: (BigInt(t1.tokens) / 2n).toString(), min_near_out: '0' }, { deposit: 1n }, 'sell');
const s1 = sell1.value;
const sc1 = s1.copies.find((c) => c.follower === FAN1);
check(s1.copies.length === 2, 'both followers were taken out with the creator');
// The creator sold floor(T/2) of T tokens, so the follower's share rounds down: at most one unit under half.
const half = BigInt(c1.tokens) / 2n;
check(BigInt(sc1.tokens) <= half && half - BigInt(sc1.tokens) <= 1n, `${FAN1} sold half of the copied tokens (rounded down, to the unit)`);
check(s1.copies.every((c) => c.fee === '0'), 'no fee: no follower has their money back yet');
const ps = price(BigInt(s1.near) + FILL_FEE, s1.tokens);
const pf = price(BigInt(sc1.near) + FILL_FEE, sc1.tokens);
check(close(ps, pf), 'the creator and the follower got the same price');
check((await claimable(FAN1)) - before1 === BigInt(sc1.near), `${FAN1} can claim ${near(sc1.near)} NEAR`);

heading(`${FAN2} buys 4 NEAR on their own: not copied, and it lifts the price`);
const own2 = await tx(fan2, 'buy', { symbol: SYMBOL, min_tokens_out: '0' }, { deposit: yocto('4') }, `${FAN2}'s own buy`);
check(own2.value.copies.length === 0, 'nobody follows them, so nothing is copied');
const fan2OwnTokens = BigInt(own2.value.tokens);

heading('The creator sells the rest: followers in profit pay the creator 10% of the profit, and only of profit');
const position = (who) => view(CONTRACT, 'get_copied', { follower: who, creator: CREATOR, symbol: SYMBOL });
const pos1 = await position(FAN1);
const pos2 = await position(FAN2);
const fee2Before = await claimable(CREATOR);
const rest = await held(CREATOR);
const sell2 = await tx(creator, 'sell', { symbol: SYMBOL, amount: rest.toString(), min_near_out: '0' }, { deposit: 1n }, 'sell');
const s2 = sell2.value;
let feesNow = 0n;
for (const [who, pos] of [[FAN1, pos1], [FAN2, pos2]]) {
  const f = s2.copies.find((c) => c.follower === who);
  const takenAfter = BigInt(pos.taken) + BigInt(f.near) + BigInt(f.fee);
  const owed = takenAfter > BigInt(pos.paid) ? ((takenAfter - BigInt(pos.paid)) * BigInt(cfg.default_fee_bps)) / 10_000n : 0n;
  const expected = owed > BigInt(pos.fees) ? owed - BigInt(pos.fees) : 0n;
  feesNow += BigInt(f.fee);
  check(BigInt(f.fee) === expected, `${who}: paid ${near(pos.paid)}, got back ${near(takenAfter)} in total, fee ${near(f.fee, 6)} = ${cfg.default_fee_bps / 100}% of ${near(takenAfter > BigInt(pos.paid) ? takenAfter - BigInt(pos.paid) : 0n, 6)} profit`);
}
check(feesNow > 0n, 'the creator earned a share of real profit');
check((await claimable(CREATOR)) - fee2Before === feesNow, `the creator can claim ${near(feesNow, 6)} NEAR in fees`);
check((await held(FAN2)) === fan2OwnTokens, `${FAN2}'s own tokens were not sold`);

heading(`${FAN2}'s allowance expires: the next copy does not happen`);
const wait = soon - Date.now() + 6_000;
if (wait > 0) {
  console.log(`      waiting ${Math.ceil(wait / 1000)} s for the expiry time to pass on chain`);
  await sleep(wait);
}
const fan2Tokens = await held(FAN2);
const fan2Claim = await claimable(FAN2);
const buy2 = await tx(creator, 'buy', { symbol: SYMBOL, min_tokens_out: '0' }, { deposit: yocto('0.5') }, 'buy');
const t2 = buy2.value;
check(t2.copies.length === 1 && t2.copies[0].follower === FAN1, `only ${FAN1} copied`);
check(t2.closed.length === 1 && t2.closed[0].follower === FAN2 && t2.closed[0].reason === 'expired', `${FAN2}'s allowance was closed as expired`);
check((await held(FAN2)) === fan2Tokens, `${FAN2}'s tokens did not change`);
check((await allowance(FAN2)) === null, `${FAN2} no longer has an allowance`);
check((await claimable(FAN2)) - fan2Claim === BigInt(t2.closed[0].refunded), `${FAN2}'s unspent NEAR is claimable`);

heading('The creator cannot take the token out while a follower holds copies of it');
await refused(creator, 'withdraw_token', { symbol: SYMBOL, amount: (await held(CREATOR)).toString() }, { deposit: BigInt(cfg.withdraw_deposit) }, 'people copying you hold this token', `${CREATOR} tries to withdraw`);

heading(`${FAN1} revokes: the unspent NEAR is back in the wallet in the same transaction`);
a1 = await allowance(FAN1);
const walletBefore = await balanceOf(FAN1);
const rev = await tx(fan1, 'revoke', { creator: CREATOR }, { deposit: 1n }, 'revoke');
const walletAfter = await balanceOf(FAN1);
check(rev.value === a1.remaining, `the contract returned ${near(a1.remaining)} NEAR`);
check(walletAfter - walletBefore > BigInt(a1.remaining) - NEAR / 100n, `the wallet went up by ${near(walletAfter - walletBefore)} NEAR (the refund less gas)`);
const fan1Tokens = await held(FAN1);
const buy3 = await tx(creator, 'buy', { symbol: SYMBOL, min_tokens_out: '0' }, { deposit: yocto('0.5') }, 'the creator buys again');
check(buy3.value.copies.length === 0, 'nobody copied: there are no allowances left');
check((await held(FAN1)) === fan1Tokens, `${FAN1} keeps the tokens already bought`);
await refused(fan1, 'revoke', { creator: CREATOR }, { deposit: 1n }, 'you do not follow this creator', 'revoking twice');
const creatorOut = await held(CREATOR);
await tx(creator, 'withdraw_token', { symbol: SYMBOL, amount: creatorOut.toString() }, { deposit: BigInt(cfg.withdraw_deposit) }, 'with no follower holding copies, the creator may withdraw');
check(BigInt(await view(TOKEN, 'ft_balance_of', { account_id: CREATOR })) === creatorOut, `${TOKEN} says ${CREATOR} holds ${tokens(creatorOut)}`);

heading('Everybody claims what is waiting for them');
for (const who of [creator, fan1, fan2]) {
  const due = await claimable(who.accountId);
  if (due === 0n) continue;
  const r = await tx(who, 'claim', {}, { deposit: 1n }, `${who.accountId} claims ${near(due)} NEAR`);
  check(r.value === due.toString() && (await claimable(who.accountId)) === 0n, `${who.accountId} was paid and has nothing left to claim`);
}

heading(`${FAN1} takes the tokens out to the wallet as plain NEP-141, and sends some back`);
const out = await held(FAN1);
await tx(fan1, 'withdraw_token', { symbol: SYMBOL, amount: out.toString() }, { deposit: BigInt(cfg.withdraw_deposit) }, 'withdraw');
check(BigInt(await view(TOKEN, 'ft_balance_of', { account_id: FAN1 })) === out, `${TOKEN} says ${FAN1} holds ${tokens(out)}`);
check((await held(FAN1)) === 0n, 'the launchpad balance is zero');
await tx(fan1, 'ft_transfer_call', { receiver_id: CONTRACT, amount: (out / 2n).toString(), msg: '' }, { deposit: 1n }, 'send half back', TOKEN);
check((await held(FAN1)) === out / 2n, 'half is back on the launchpad, ready to sell');
check(BigInt(await view(TOKEN, 'ft_total_supply')) === supply, 'the total supply never changed');

heading('The books: what the contract owes against what it holds');
const totals = await view(CONTRACT, 'get_totals');
const tk = await view(CONTRACT, 'get_token', { symbol: SYMBOL });
const free = BigInt(totals.balance) - BigInt(totals.storage_stake);
console.log(`      owed to users ${near(totals.owed)} NEAR (curves ${near(totals.curves)}, allowances ${near(totals.allowances)}, claims ${near(totals.claimable)})`);
console.log(`      held ${near(totals.balance)} NEAR, of which ${near(totals.storage_stake)} is locked for storage`);
check(free >= BigInt(totals.owed), `the contract holds ${near(free - BigInt(totals.owed))} NEAR more than it owes`);
check(BigInt(await view(TOKEN, 'ft_balance_of', { account_id: CONTRACT })) >= BigInt(tk.token_reserve), 'it holds every token still in the curve');
void padHolds;

const result = {
  network: 'testnet',
  contract: CONTRACT,
  token: TOKEN,
  accounts: { creator: CREATOR, followers: [FAN1, FAN2] },
  ran_at: new Date().toISOString(),
  checks,
  failed: failures,
  copied_buy_gas_tgas: Number(tgas(buy1.gas)),
  copied_sell_gas_tgas: Number(tgas(sell2.gas)),
  transactions: txs,
};
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/testnet-run.json'), JSON.stringify(result, null, 2) + '\n');

console.log(`\n${checks - failures.length} of ${checks} checks passed. Transactions saved to docs/testnet-run.json`);
if (failures.length) {
  for (const f of failures) console.log(`  FAILED ${f}`);
  process.exit(1);
}
