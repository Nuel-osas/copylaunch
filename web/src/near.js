// Chain reads and number formatting. Money stays in BigInt base units; strings only for display.

export const CONTRACT = import.meta.env.VITE_CONTRACT || 'copylaunch.testnet';
export const NETWORK = 'testnet';
export const EXPLORER = 'https://testnet.nearblocks.io';
export const ONE_NEAR = 10n ** 24n;
export const TOKEN_UNIT = 10n ** 18n;
export const GAS = '300000000000000';

// Public testnet RPCs that allow calls from a browser. Tried in order.
const RPCS = ['https://rpc.testnet.fastnear.com', 'https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];

function toBase64(text) {
  let s = '';
  for (const b of new TextEncoder().encode(text)) s += String.fromCharCode(b);
  return btoa(s);
}

async function rpc(method, params) {
  let last = new Error('no RPC answered');
  for (const url of RPCS) {
    let body;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'copylaunch', method, params }),
      });
      if (!res.ok) {
        last = new Error(`${url} answered ${res.status}`);
        continue;
      }
      body = await res.json();
    } catch (e) {
      last = e;
      continue;
    }
    // A contract or account error is an answer, not an outage: do not retry it elsewhere.
    if (body.error) throw new Error(body.error.data || body.error.message || JSON.stringify(body.error));
    return body.result;
  }
  throw last;
}

/** Read-only call. A failed read throws; it never turns into a default value. */
export async function view(method, args = {}, contractId = CONTRACT) {
  const r = await rpc('query', {
    request_type: 'call_function',
    finality: 'optimistic',
    account_id: contractId,
    method_name: method,
    args_base64: toBase64(JSON.stringify(args)),
  });
  if (r.error) throw new Error(r.error);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)));
}

export async function walletBalance(accountId) {
  const r = await rpc('query', { request_type: 'view_account', finality: 'optimistic', account_id: accountId });
  return BigInt(r.amount);
}

// ---- formatting -------------------------------------------------------------------------------

/** yoctoNEAR to a decimal string with at most `dp` places. */
export function fmtNear(yocto, dp = 3) {
  if (yocto === null || yocto === undefined) return '…';
  const v = BigInt(yocto);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const scale = 10n ** BigInt(24 - dp);
  const r = (a + scale / 2n) / scale;
  const whole = r / 10n ** BigInt(dp);
  const frac = (r % 10n ** BigInt(dp)).toString().padStart(dp, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}${frac ? '.' + frac : ''}`;
}

/** Decimal NEAR typed by a person ("0.5") to yoctoNEAR, exactly. Returns null if it is not a number. */
export function parseNear(text) {
  const t = String(text ?? '').trim();
  if (!/^\d*(\.\d{0,24})?$/.test(t) || t === '' || t === '.') return null;
  const [w, f = ''] = t.split('.');
  return BigInt(w || '0') * ONE_NEAR + BigInt(f.padEnd(24, '0'));
}

/** Token base units (18 decimals) to a short string: 21.8M, 3.2K, 950. */
export function fmtTokens(units) {
  if (units === null || units === undefined) return '…';
  const whole = BigInt(units) / TOKEN_UNIT;
  const steps = [
    [10n ** 9n, 'B'],
    [10n ** 6n, 'M'],
    [10n ** 3n, 'K'],
  ];
  for (const [size, suffix] of steps) {
    if (whole >= size) {
      const tenths = (whole * 10n) / size;
      return `${tenths / 10n}${tenths % 10n ? '.' + (tenths % 10n) : ''}${suffix}`;
    }
  }
  return whole.toString();
}

/** Tokens typed by a person ("1000000") to base units. Whole tokens only. */
export function parseTokens(text) {
  const t = String(text ?? '').trim().replace(/[, _]/g, '');
  if (!/^\d+$/.test(t)) return null;
  return BigInt(t) * TOKEN_UNIT;
}

/** Market cap in yoctoNEAR: price times supply, from the curve's reserves. */
export function marketCap(token) {
  const near = BigInt(token.virtual_near) + BigInt(token.near_reserve);
  return (near * BigInt(token.supply)) / BigInt(token.token_reserve);
}

/** yoctoNEAR per one million whole tokens. */
export function pricePerMillion(token) {
  const near = BigInt(token.virtual_near) + BigInt(token.near_reserve);
  return (near * 10n ** 6n * TOKEN_UNIT) / BigInt(token.token_reserve);
}

/** Share of the supply bought out of the curve, in basis points. */
export function soldBps(token) {
  const supply = BigInt(token.supply);
  return Number(((supply - BigInt(token.token_reserve)) * 10_000n) / supply);
}

export function fmtPct(bps) {
  return `${(bps / 100).toFixed(bps < 100 ? 2 : 1)}%`;
}

export function shortAccount(id, max = 18) {
  if (!id) return '';
  return id.length <= max ? id : `${id.slice(0, max - 7)}…${id.slice(-6)}`;
}

export function untilText(ms, now = Date.now()) {
  const d = ms - now;
  if (d <= 0) return 'expired';
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} days`;
}

export function agoText(ms, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export const txUrl = (hash) => `${EXPLORER}/txns/${hash}`;
export const accountUrl = (id) => `${EXPLORER}/address/${id}`;

/** The short reason a contract gave for refusing, out of whatever a wallet threw. */
export function reason(err) {
  const text = typeof err === 'string' ? err : err?.message || JSON.stringify(err);
  const m = text.match(/Smart contract panicked: ([^"\\]+)/) || text.match(/panicked at[^:]*: ([^"\\]+)/);
  if (m) return m[1];
  if (/User (cancelled|rejected)|rejected|closed/i.test(text)) return 'cancelled in the wallet';
  return text.length > 220 ? text.slice(0, 220) + '…' : text;
}

/** Reads a wallet's transaction outcome: the returned value, or throws with the contract's reason. */
export function readOutcome(outcome) {
  const o = Array.isArray(outcome) ? outcome[outcome.length - 1] : outcome;
  if (!o || typeof o !== 'object') return { hash: null, value: undefined };
  const hash = o.transaction?.hash || o.transaction_outcome?.id || null;
  const failed = [o.status, ...(o.receipts_outcome || []).map((r) => r.outcome?.status)].find(
    (s) => s && typeof s === 'object' && 'Failure' in s,
  );
  if (failed) throw new Error(JSON.stringify(failed.Failure));
  let value;
  const v = o.status?.SuccessValue;
  if (v) {
    try {
      value = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0))));
    } catch {
      value = undefined;
    }
  }
  return { hash, value };
}
