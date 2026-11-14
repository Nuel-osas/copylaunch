// Everything the pages read from chain, polled, plus the wallet sender and sound.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWalletSelector } from '@near-wallet-selector/react-hook';
import { CONTRACT, GAS, allTrades, marketCap, pricePath, readOutcome, reason, tradeVolume, view } from './near.js';

const POLL_MS = 8000;

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Tokens, the whole trade log, totals and config. The trade log is refetched only when it grew. */
export function useChain(tick) {
  const [s, setS] = useState({ config: null, tokens: [], trades: [], totals: null, tradeCount: null, error: null, loaded: false, fresh: {} });
  const last = useRef({ count: -1, trades: [], volumes: {} });
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [config, tokens, totals, tradeCount] = await Promise.all([
          view('get_config'),
          view('get_tokens', { from_index: 0, limit: 100 }),
          view('get_totals'),
          view('get_trade_count'),
        ]);
        let trades = last.current.trades;
        if (tradeCount !== last.current.count) trades = await allTrades();
        // Which tokens traded since the last poll, so their cards can pulse.
        const fresh = {};
        for (const t of tokens) {
          const before = last.current.volumes[t.symbol];
          if (before !== undefined && before !== t.trades) fresh[t.symbol] = Date.now();
        }
        last.current = { count: tradeCount, trades, volumes: Object.fromEntries(tokens.map((t) => [t.symbol, t.trades])) };
        if (alive) setS((p) => ({ config, tokens, trades, totals, tradeCount, error: null, loaded: true, fresh: { ...p.fresh, ...fresh } }));
      } catch (e) {
        if (alive) setS((p) => ({ ...p, error: reason(e) }));
      }
    }
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tick]);
  return s;
}

/** Per-token figures derived from the trade log: price path, 24 h volume, copies. */
export function useTokenStats(chain) {
  return useMemo(() => {
    const out = {};
    if (!chain.config) return out;
    const day = Date.now() - 86_400_000;
    for (const token of chain.tokens) {
      const trades = chain.trades.filter((t) => t.symbol === token.symbol);
      let vol24 = 0n;
      let copies = 0;
      for (const t of trades) {
        if (t.timestamp_ms >= day) vol24 += tradeVolume(t);
        copies += t.copies.length;
      }
      out[token.symbol] = { ...pricePath(token, trades, chain.config), vol24, copies, trades, cap: marketCap(token) };
    }
    return out;
  }, [chain.tokens, chain.trades, chain.config]);
}

/** What followers put into and took out of a creator's copies, from the trade log. */
export function flockFlows(trades, creator) {
  let paidIn = 0n;
  let takenOut = 0n;
  let fees = 0n;
  let copies = 0;
  for (const t of trades) {
    if (t.trader !== creator) continue;
    for (const c of t.copies) {
      copies += 1;
      if (t.side === 'buy') paidIn += BigInt(c.near);
      else {
        takenOut += BigInt(c.near) + BigInt(c.fee);
        fees += BigInt(c.fee);
      }
    }
  }
  return { paidIn, takenOut, fees, copies };
}

/** Everyone who launched or traded, with their public creator record. */
export function useCreators(chain) {
  const [rows, setRows] = useState([]);
  const key = `${chain.tradeCount}-${chain.tokens.length}`;
  useEffect(() => {
    if (!chain.loaded) return undefined;
    let alive = true;
    const ids = [...new Set([...chain.tokens.map((t) => t.creator), ...chain.trades.map((t) => t.trader)])];
    Promise.all(ids.map((id) => view('get_creator', { creator: id }).catch(() => null))).then((list) => {
      if (!alive) return;
      const out = list.filter(Boolean).map((c) => ({
        ...c,
        launched: chain.tokens.filter((t) => t.creator === c.creator).length,
        flows: flockFlows(chain.trades, c.creator),
      }));
      out.sort((a, b) => b.followers - a.followers || (BigInt(b.copied_volume) > BigInt(a.copied_volume) ? 1 : -1));
      setRows(out);
    });
    return () => {
      alive = false;
    };
  }, [key, chain.loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  return rows;
}

export function useMine(accountId, tick) {
  const [m, setM] = useState(null);
  useEffect(() => {
    if (!accountId) {
      setM(null);
      return undefined;
    }
    let alive = true;
    async function load() {
      try {
        const [following, followers, claimable, holdings, creator] = await Promise.all([
          view('get_following', { follower: accountId }),
          view('get_followers', { creator: accountId }),
          view('get_claimable', { account_id: accountId }),
          view('get_holdings', { account_id: accountId }),
          view('get_creator', { creator: accountId }),
        ]);
        if (alive) setM({ following, followers, claimable, holdings, creator, error: null });
      } catch (e) {
        if (alive) setM((p) => ({ ...(p || {}), error: reason(e) }));
      }
    }
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [accountId, tick]);
  return m;
}

/** Sends one call through the connected wallet; reports, celebrates and refreshes. */
export function useSend(onDone) {
  const { callFunction, signedAccountId, signIn } = useWalletSelector();
  const [busy, setBusy] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [party, setParty] = useState(null);
  const push = useCallback((t) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((x) => [...x, { id, ...t }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), t.kind === 'error' ? 14000 : 10000);
  }, []);
  const send = useCallback(
    async (label, method, args, deposit, contractId = CONTRACT) => {
      if (!signedAccountId) {
        signIn();
        return undefined;
      }
      setBusy(label);
      try {
        const out = await callFunction({ contractId, method, args, deposit: BigInt(deposit).toString(), gas: GAS });
        const { hash, value } = readOutcome(out);
        push({ kind: 'ok', text: label, hash });
        if ((method === 'buy' || method === 'sell') && value) {
          setParty({ trade: value, hash, at: Date.now() });
          sound('coin');
        } else sound('ok');
        onDone?.();
        return value ?? null;
      } catch (e) {
        push({ kind: 'error', text: `${label}: ${reason(e)}` });
        sound('no');
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [callFunction, signedAccountId, signIn, onDone, push],
  );
  return { send, busy, toasts, party, clearParty: () => setParty(null) };
}

// ---- sound: off unless the visitor turns it on ------------------------------------------------

let audio = null;
export function soundOn() {
  try {
    return localStorage.getItem('copylaunch:sound') === 'on';
  } catch {
    return false;
  }
}
export function setSound(on) {
  try {
    localStorage.setItem('copylaunch:sound', on ? 'on' : 'off');
  } catch {
    /* private mode: sound simply stays off next visit */
  }
  if (on) sound('ok');
}
export function sound(kind) {
  if (!soundOn()) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const now = audio.currentTime;
    const notes = { coin: [880, 1320, 1760], ok: [660, 990], no: [220, 160], quack: [540, 380] }[kind] || [660];
    notes.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = kind === 'quack' || kind === 'no' ? 'sawtooth' : 'triangle';
      o.frequency.setValueAtTime(f, now + i * 0.07);
      g.gain.setValueAtTime(0.0001, now + i * 0.07);
      g.gain.exponentialRampToValueAtTime(0.08, now + i * 0.07 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.07 + 0.12);
      o.connect(g).connect(audio.destination);
      o.start(now + i * 0.07);
      o.stop(now + i * 0.07 + 0.14);
    });
  } catch {
    /* no audio available */
  }
}
