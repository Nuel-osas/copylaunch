// Shared helpers for the testnet scripts. Testnet only: every script refuses another network.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider, actions } from 'near-api-js';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '..');
export const RPC = process.env.NEAR_RPC ?? 'https://rpc.testnet.fastnear.com';
export const CONTRACT = process.env.COPYLAUNCH ?? 'copylaunch.testnet';
export const TGAS = 10n ** 12n;
export const NEAR = 10n ** 24n;
export const EXPLORER = 'https://testnet.nearblocks.io/txns/';

if (!/testnet/.test(RPC)) throw new Error(`refusing ${RPC}: these scripts are for testnet only`);

export const provider = new JsonRpcProvider({ url: RPC });

/**
 * Loads an account whose key near-cli saved in ~/.near-credentials/testnet/<id>.json.
 * The key is read from disk and handed to the signer. It is never printed or copied.
 */
export function account(id) {
  const file = path.join(os.homedir(), '.near-credentials', 'testnet', `${id}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `no key for ${id}. Create the account with:\n  near account create-account sponsor-by-faucet-service ${id} autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`,
    );
  }
  const { private_key, secret_key } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Account(id, provider, private_key ?? secret_key);
}

export async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429 && attempt < 5) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }
}

/** Read-only contract call. A failed read throws; it never returns a default. */
export async function view(contractId, method, args = {}) {
  const r = await rpc('query', {
    request_type: 'call_function',
    finality: 'optimistic',
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  if (r.error) throw new Error(`${contractId}.${method}: ${r.error}`);
  return JSON.parse(Buffer.from(r.result).toString('utf8'));
}

/** Account record, or null if the account does not exist. Any other failure throws. */
export async function accountInfo(accountId) {
  try {
    return await rpc('query', { request_type: 'view_account', finality: 'optimistic', account_id: accountId });
  } catch (e) {
    if (/UNKNOWN_ACCOUNT|does not exist/.test(String(e.message))) return null;
    throw e;
  }
}

export const balanceOf = async (id) => BigInt((await accountInfo(id))?.amount ?? 0n);

function failureText(status) {
  const text = JSON.stringify(status?.Failure ?? status);
  const m = text.match(/Smart contract panicked: ([^"\\]+)/);
  return m ? m[1] : text;
}

function outcome(res) {
  const receipts = res.receipts_outcome.map((r) => r.outcome);
  const failed = receipts.find((o) => o.status && typeof o.status === 'object' && 'Failure' in o.status);
  const topFailed = res.status && typeof res.status === 'object' && 'Failure' in res.status;
  const out = {
    ok: !failed && !topFailed,
    hash: res.transaction_outcome.id,
    // The function call itself is the first receipt; this is what counts against the 300 Tgas limit.
    gas: BigInt(receipts[0]?.gas_burnt ?? 0),
    logs: receipts.flatMap((o) => o.logs),
  };
  if (!out.ok) {
    out.error = failureText(failed ? failed.status : res.status);
    return out;
  }
  const v = res.status?.SuccessValue;
  if (v) {
    try {
      out.value = JSON.parse(Buffer.from(v, 'base64').toString('utf8'));
    } catch {
      out.value = undefined;
    }
  }
  return out;
}

/** Sends one function call. Never throws on a contract failure: returns `{ ok: false, error }`. */
export async function call(signer, contractId, method, args = {}, { gas = 300n * TGAS, deposit = 0n } = {}) {
  const res = await signer.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(method, new TextEncoder().encode(JSON.stringify(args)), gas, deposit)],
    throwOnFailure: false,
    waitUntil: 'FINAL',
  });
  return outcome(res);
}

/** Sends raw actions (used for the deploy). */
export async function send(signer, receiverId, acts) {
  const res = await signer.signAndSendTransaction({ receiverId, actions: acts, throwOnFailure: false, waitUntil: 'FINAL' });
  return outcome(res);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tgas = (g) => (Number(g) / 1e12).toFixed(1);

/** yoctoNEAR (string or bigint) to a decimal string with up to `dp` places, for display only. */
export function near(yocto, dp = 4) {
  const v = BigInt(yocto);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const scale = 10n ** BigInt(24 - dp);
  const r = (a + scale / 2n) / scale;
  const whole = r / 10n ** BigInt(dp);
  const frac = (r % 10n ** BigInt(dp)).toString().padStart(dp, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Token base units (18 decimals) to a rounded decimal string, for display only. */
export function tokens(units) {
  const whole = BigInt(units) / 10n ** 18n;
  return whole.toLocaleString('en-US');
}

/** Decimal NEAR ("0.5") to yoctoNEAR, exactly. */
export function yocto(amount) {
  const [w, f = ''] = String(amount).split('.');
  if (!/^\d+$/.test(w) || !/^\d*$/.test(f) || f.length > 24) throw new Error(`not a NEAR amount: ${amount}`);
  return BigInt(w) * NEAR + BigInt(f.padEnd(24, '0'));
}
