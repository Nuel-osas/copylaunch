import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWalletSelector } from '@near-wallet-selector/react-hook';
import {
  CONTRACT,
  GAS,
  accessKeys,
  accountUrl,
  agoText,
  fmtNear,
  fmtPct,
  fmtTokens,
  marketCap,
  parseNear,
  parseTokens,
  pricePerMillion,
  readOutcome,
  reason,
  shortAccount,
  soldBps,
  txUrl,
  untilText,
  view,
} from './near.js';

const REPO = import.meta.env.VITE_REPO || '';

// ---- data -------------------------------------------------------------------------------------

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function useChain(tick) {
  const [s, setS] = useState({ config: null, tokens: [], trades: [], totals: null, tradeCount: null, error: null, loaded: false });
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [config, tokens, trades, totals, tradeCount] = await Promise.all([
          view('get_config'),
          view('get_tokens', { from_index: 0, limit: 100 }),
          view('get_trades', { limit: 60 }),
          view('get_totals'),
          view('get_trade_count'),
        ]);
        if (alive) setS({ config, tokens, trades, totals, tradeCount, error: null, loaded: true });
      } catch (e) {
        if (alive) setS((p) => ({ ...p, error: reason(e) }));
      }
    }
    load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tick]);
  return s;
}

function useMine(accountId, tick) {
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
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [accountId, tick]);
  return m;
}

/** Sends one call through the connected wallet and reports what happened. */
function useSend(onDone) {
  const { callFunction, signedAccountId, signIn } = useWalletSelector();
  const [busy, setBusy] = useState(null);
  const [toasts, setToasts] = useState([]);
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
        onDone?.();
        return value ?? null;
      } catch (e) {
        push({ kind: 'error', text: `${label}: ${reason(e)}` });
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [callFunction, signedAccountId, signIn, onDone, push],
  );
  return { send, busy, toasts, push };
}

// ---- small pieces -----------------------------------------------------------------------------

function hue(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function Monogram({ token, size = 48 }) {
  const [broken, setBroken] = useState(false);
  if (token.image && !broken) {
    return <img className="mono" src={token.image} alt="" width={size} height={size} onError={() => setBroken(true)} />;
  }
  const h = hue(token.symbol);
  return (
    <span className="mono" style={{ width: size, height: size, background: `oklch(0.78 0.16 ${h})`, fontSize: size * 0.34 }} aria-hidden="true">
      {token.symbol.slice(0, 2).toUpperCase()}
    </span>
  );
}

function Label({ children }) {
  return <span className="label">{children}</span>;
}

function Acct({ id }) {
  return (
    <a className="acct" href={accountUrl(id)} target="_blank" rel="noreferrer" title={id}>
      {shortAccount(id)}
    </a>
  );
}

function Bar({ value, max, tone = 'accent' }) {
  const v = BigInt(value || 0);
  const m = BigInt(max || 0);
  const pct = m > 0n ? Number((v * 1000n) / m) / 10 : 0;
  return (
    <span className={`bar bar-${tone}`} role="img" aria-label={`${pct}%`}>
      <span style={{ width: `${Math.min(100, pct)}%` }} />
    </span>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

// ---- sections ---------------------------------------------------------------------------------

function Header({ onNav }) {
  const { signedAccountId, signIn, signOut } = useWalletSelector();
  return (
    <header className="top">
      <a className="brand" href="#top" onClick={() => onNav('top')}>
        <img src="./logo.svg" alt="" width="26" height="26" />
        <span>CopyLaunch</span>
      </a>
      <nav className="nav">
        <a href="#launches">Launches</a>
        <a href="#follow">Follow</a>
        <a href="#dashboard">Dashboard</a>
        <a href="#rules">Rules</a>
      </nav>
      <span className="net">
        <i /> testnet
      </span>
      {signedAccountId ? (
        <button className="btn btn-ghost" onClick={() => signOut()} title="Sign out">
          {shortAccount(signedAccountId, 20)}
        </button>
      ) : (
        <button className="btn btn-accent" onClick={() => signIn()}>
          Connect wallet
        </button>
      )}
    </header>
  );
}

function Hero({ chain }) {
  const t = chain.totals;
  const copies = chain.trades.reduce((n, tr) => n + tr.copies.length, 0);
  const free = t ? BigInt(t.balance) - BigInt(t.storage_stake) : null;
  return (
    <section className="hero" id="top">
      <div className="hero-copy">
        <Label>[ memecoin launchpad · copy trading · NEAR testnet ]</Label>
        <h1>
          Copy a creator's buys.
          <br />
          <em>Never past the leash you set.</em>
        </h1>
        <p className="lede">
          Following a creator on CopyLaunch is an allowance held by the contract: a total cap, a cap per trade, an end date,
          revocable at any time. When the creator buys, every follower buys in the same transaction, at the same price. A
          copy that would break a limit does not happen.
        </p>
        <div className="hero-actions">
          <a className="btn btn-accent" href="#launches">
            Browse launches
          </a>
          <a className="btn btn-ghost" href="#follow">
            Follow a creator
          </a>
        </div>
      </div>

      <figure className="flow" aria-label="How one buy is copied">
        <figcaption>
          <Label>[ one buy, three followers ]</Label>
        </figcaption>
        <div className="flow-row flow-src">
          <b>creator</b> buys <b>1 NEAR</b> of FROG
        </div>
        <div className="flow-gate">
          <span>allowance gate</span>
          <small>cap · per trade · expiry · checked on chain</small>
        </div>
        <ul className="flow-fans">
          <li className="ok">
            <span>ann</span>
            <span>0.5 / trade</span>
            <b>copies 0.5 NEAR</b>
          </li>
          <li className="ok">
            <span>bob</span>
            <span>2 / trade</span>
            <b>copies 1 NEAR</b>
          </li>
          <li className="no">
            <span>cat</span>
            <span>expired</span>
            <b>nothing spent</b>
          </li>
        </ul>
        <div className="flow-row flow-out">
          one fill on the curve · <b>one price for all three</b> · the creator earns only from followers' profit
        </div>
      </figure>

      <dl className="stats">
        <div>
          <dt>Tokens launched</dt>
          <dd>{chain.loaded ? chain.tokens.length : '…'}</dd>
        </div>
        <div>
          <dt>Trades</dt>
          <dd>{chain.tradeCount ?? '…'}</dd>
        </div>
        <div>
          <dt>Copies in the last {chain.trades.length} trades</dt>
          <dd>{chain.loaded ? copies : '…'}</dd>
        </div>
        <div>
          <dt>Owed to users / held</dt>
          <dd>
            {t ? `${fmtNear(t.owed, 2)} / ${fmtNear(free, 2)}` : '…'} <small>NEAR</small>
          </dd>
        </div>
      </dl>
      {chain.error ? <p className="warn">Could not read the contract: {chain.error}</p> : null}
    </section>
  );
}

function TokenCard({ token, onTrade, onFollow, me }) {
  const sold = soldBps(token);
  return (
    <article className="card token">
      <div className="token-head">
        <Monogram token={token} />
        <div>
          <h3>{token.symbol.toUpperCase()}</h3>
          <p className="muted">{token.name}</p>
        </div>
        <span className="muted small right">{agoText(token.created_at_ms)}</span>
      </div>
      {token.description ? <p className="desc">{token.description}</p> : null}
      <dl className="kv">
        <div>
          <dt>Market cap</dt>
          <dd>{fmtNear(marketCap(token), 2)} NEAR</dd>
        </div>
        <div>
          <dt>Per 1M</dt>
          <dd>{fmtNear(pricePerMillion(token), 4)}</dd>
        </div>
        <div>
          <dt>Trades</dt>
          <dd>{token.trades}</dd>
        </div>
      </dl>
      <div className="sold">
        <Bar value={BigInt(token.supply) - BigInt(token.token_reserve)} max={token.supply} />
        <span className="small muted">{fmtPct(sold)} bought from the curve</span>
      </div>
      <p className="small muted">
        by <Acct id={token.creator} />
      </p>
      <div className="row">
        <button className="btn btn-accent" onClick={() => onTrade(token.symbol)} disabled={!token.ready}>
          {token.ready ? 'Trade' : 'Deploying…'}
        </button>
        {token.creator !== me ? (
          <button className="btn btn-ghost" onClick={() => onFollow(token.creator)}>
            Follow creator
          </button>
        ) : (
          <span className="small muted">your token</span>
        )}
      </div>
    </article>
  );
}

function LaunchForm({ config, send, busy }) {
  const [f, setF] = useState({ symbol: '', name: '', description: '', image: '' });
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: k === 'symbol' ? e.target.value.toLowerCase() : e.target.value }));
  const symbolOk = /^[a-z0-9]{2,10}$/.test(f.symbol);
  const imageOk = !f.image || (f.image.startsWith('https://') && f.image.length <= 300);
  const ok = symbolOk && f.name.trim().length > 0 && f.name.trim().length <= 40 && f.description.length <= 280 && imageOk && config;
  async function submit(e) {
    e.preventDefault();
    if (!ok) return;
    const r = await send(
      `Launch ${f.symbol.toUpperCase()}`,
      'launch',
      { symbol: f.symbol, name: f.name.trim(), description: f.description.trim() || null, image: f.image || null },
      BigInt(config.launch_cost),
    );
    if (r !== undefined) setF({ symbol: '', name: '', description: '', image: '' });
  }
  return (
    <form className="card launch" onSubmit={submit}>
      <h3>Launch a token</h3>
      <p className="muted small">
        A new NEP-141 contract at <code>{f.symbol || 'symbol'}.{CONTRACT}</code>, one billion tokens, all of them in the curve.
        Nobody gets a free allocation, the creator included.
      </p>
      <Field label="Symbol" hint="2 to 10 characters, lower-case letters and digits. It becomes an account name.">
        <input value={f.symbol} onChange={set('symbol')} maxLength={10} placeholder="frog" aria-invalid={f.symbol !== '' && !symbolOk} />
      </Field>
      <Field label="Name">
        <input value={f.name} onChange={set('name')} maxLength={40} placeholder="Frog Coin" />
      </Field>
      <Field label="Description" hint={`${f.description.length} of 280`}>
        <textarea value={f.description} onChange={set('description')} maxLength={280} rows={2} placeholder="What the meme is" />
      </Field>
      <Field label="Image (optional)" hint="An https link">
        <input value={f.image} onChange={set('image')} placeholder="https://…" aria-invalid={!imageOk} />
      </Field>
      <button className="btn btn-accent wide" disabled={!ok || !!busy}>
        {busy?.startsWith('Launch') ? 'Launching…' : `Launch for ${config ? fmtNear(config.launch_cost, 3) : '…'} NEAR`}
      </button>
      <p className="small muted">The cost pays for the token contract's storage on chain. Anything extra comes back.</p>
    </form>
  );
}

function Launches({ chain, onTrade, onFollow, me, send, busy }) {
  const [sort, setSort] = useState('new');
  const tokens = useMemo(() => {
    const list = [...chain.tokens];
    if (sort === 'new') list.sort((a, b) => b.created_at_ms - a.created_at_ms);
    if (sort === 'cap') list.sort((a, b) => (marketCap(b) > marketCap(a) ? 1 : -1));
    if (sort === 'trades') list.sort((a, b) => b.trades - a.trades);
    return list;
  }, [chain.tokens, sort]);
  return (
    <section className="section" id="launches">
      <div className="section-head">
        <Label>[ 01 · launches ]</Label>
        <h2>Every token here has a curve and its own NEP-141 contract.</h2>
        <div className="seg" role="tablist" aria-label="Sort launches">
          {[
            ['new', 'Newest'],
            ['cap', 'Market cap'],
            ['trades', 'Most traded'],
          ].map(([k, v]) => (
            <button key={k} role="tab" aria-selected={sort === k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>
              {v}
            </button>
          ))}
        </div>
      </div>
      <div className="launch-grid">
        <LaunchForm config={chain.config} send={send} busy={busy} />
        {tokens.map((t) => (
          <TokenCard key={t.symbol} token={t} onTrade={onTrade} onFollow={onFollow} me={me} />
        ))}
        {chain.loaded && tokens.length === 0 ? <p className="muted">No launches yet. Be the first.</p> : null}
      </div>
    </section>
  );
}

function TradeDrawer({ symbol, chain, mine, me, send, busy, onClose, onFollow }) {
  const token = chain.tokens.find((t) => t.symbol === symbol);
  const [side, setSide] = useState('buy');
  const [amount, setAmount] = useState('1');
  const [quote, setQuote] = useState(null);
  const [qErr, setQErr] = useState(null);
  const held = BigInt(mine?.holdings?.find((h) => h.symbol === symbol)?.balance ?? 0);
  const trader = me || token?.creator;

  const parsed = side === 'buy' ? parseNear(amount) : parseTokens(amount);
  useEffect(() => {
    setQuote(null);
    setQErr(null);
    if (!token || !parsed || parsed <= 0n || !trader) return undefined;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const q =
          side === 'buy'
            ? await view('quote_buy', { symbol, near_in: parsed.toString(), buyer: trader })
            : await view('quote_sell', { symbol, tokens_in: parsed.toString(), seller: trader });
        if (alive) setQuote(q);
      } catch (e) {
        if (alive) setQErr(reason(e));
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [symbol, side, amount, trader, token?.near_reserve]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!token) return null;
  const trades = chain.trades.filter((t) => t.symbol === symbol).slice(0, 8);
  const tooMuch = side === 'sell' && parsed !== null && parsed > held;

  async function submit(e) {
    e.preventDefault();
    if (!parsed || !quote) return;
    // 2% slippage allowed against the quote.
    const min = (BigInt(quote.own) * 98n) / 100n;
    if (side === 'buy') {
      await send(`Buy ${token.symbol.toUpperCase()}`, 'buy', { symbol, min_tokens_out: min.toString() }, parsed);
    } else {
      await send(`Sell ${token.symbol.toUpperCase()}`, 'sell', { symbol, amount: parsed.toString(), min_near_out: min.toString() }, 1n);
    }
  }

  return (
    <div className="drawer-back" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Trade ${token.symbol}`} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <Monogram token={token} size={44} />
          <div>
            <h3>{token.symbol.toUpperCase()}</h3>
            <p className="muted small">
              {token.name} · by <Acct id={token.creator} />
            </p>
          </div>
          <button className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <dl className="kv">
          <div>
            <dt>Market cap</dt>
            <dd>{fmtNear(marketCap(token), 2)} NEAR</dd>
          </div>
          <div>
            <dt>NEAR in curve</dt>
            <dd>{fmtNear(token.near_reserve, 3)}</dd>
          </div>
          <div>
            <dt>You hold</dt>
            <dd>{me ? fmtTokens(held) : '…'}</dd>
          </div>
        </dl>
        <p className="small">
          Contract <a href={accountUrl(token.account_id)} target="_blank" rel="noreferrer"><code>{token.account_id}</code></a>
        </p>

        <form onSubmit={submit} className="trade-form">
          <div className="seg wide" role="tablist">
            {['buy', 'sell'].map((s) => (
              <button
                type="button"
                key={s}
                role="tab"
                aria-selected={side === s}
                className={side === s ? 'on' : ''}
                onClick={() => {
                  setSide(s);
                  setAmount(s === 'buy' ? '1' : held > 0n ? (held / 10n ** 18n).toString() : '');
                }}
              >
                {s === 'buy' ? 'Buy' : 'Sell'}
              </button>
            ))}
          </div>
          <Field label={side === 'buy' ? 'Spend (NEAR)' : `Sell (${token.symbol.toUpperCase()}, whole tokens)`}>
            <div className="with-btn">
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={amount !== '' && !parsed} />
              {side === 'sell' && held > 0n ? (
                <button type="button" className="btn btn-ghost" onClick={() => setAmount((held / 10n ** 18n).toString())}>
                  Max
                </button>
              ) : null}
            </div>
          </Field>

          <div className="quote">
            {qErr ? <p className="warn small">{qErr}</p> : null}
            {quote ? (
              <>
                <p>
                  {side === 'buy' ? 'You get about ' : 'You receive about '}
                  <b>{side === 'buy' ? `${fmtTokens(quote.own)} ${token.symbol.toUpperCase()}` : `${fmtNear(quote.own, 4)} NEAR`}</b>
                </p>
                {quote.copies.length > 0 ? (
                  <div className="copies">
                    <p className="small">
                      {me ? 'Your' : "The creator's"} {quote.copies.length} follower{quote.copies.length > 1 ? 's' : ''}{' '}
                      {side === 'buy' ? 'buy' : 'sell'} with {me ? 'you' : 'them'}, in the same transaction, at the same price:
                    </p>
                    <ul>
                      {quote.copies.map((c) => (
                        <li key={c.follower}>
                          <Acct id={c.follower} />
                          <span>{side === 'buy' ? `${fmtNear(c.near, 3)} NEAR` : `${fmtTokens(c.tokens)}`}</span>
                          <span className="muted">{side === 'buy' ? `${fmtTokens(c.tokens)}, no fee` : `${fmtNear(c.near, 4)} NEAR${BigInt(c.fee) > 0n ? `, ${fmtNear(c.fee, 4)} of profit to you` : ', no fee'}`}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="small muted">{me ? 'Nobody follows you yet: this trade is not copied.' : 'Connect a wallet to see your own quote.'}</p>
                )}
                <p className="small muted">Fails if the price moves more than 2% before it lands.</p>
              </>
            ) : null}
          </div>

          {tooMuch ? <p className="warn small">You hold {fmtTokens(held)}.</p> : null}
          <button className="btn btn-accent wide" disabled={!quote || !!busy || tooMuch}>
            {busy ? `${busy}…` : !me ? 'Connect wallet to trade' : side === 'buy' ? `Buy for ${amount || 0} NEAR` : 'Sell'}
          </button>
        </form>

        {token.creator !== me ? (
          <button className="btn btn-ghost wide" onClick={() => onFollow(token.creator)}>
            Copy {shortAccount(token.creator)}'s next buys
          </button>
        ) : null}

        <h4>Recent trades</h4>
        {trades.length === 0 ? <p className="muted small">No trades yet.</p> : null}
        <ul className="feed compact">
          {trades.map((t) => (
            <TradeRow key={t.index} trade={t} me={me} />
          ))}
        </ul>
      </aside>
    </div>
  );
}

function FollowSection({ chain, me, target, setTarget, send, busy }) {
  const now = useNow(30_000);
  const [total, setTotal] = useState('2');
  const [perTrade, setPerTrade] = useState('0.5');
  const [hours, setHours] = useState('24');
  const [info, setInfo] = useState(null);
  const [existing, setExisting] = useState(null);
  const creators = useMemo(() => [...new Set(chain.tokens.map((t) => t.creator))], [chain.tokens]);
  const cfg = chain.config;

  useEffect(() => {
    setInfo(null);
    setExisting(null);
    if (!/^[a-z0-9._-]{2,64}$/.test(target)) return undefined;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const [c, a] = await Promise.all([
          view('get_creator', { creator: target }),
          me ? view('get_allowance', { follower: me, creator: target }) : Promise.resolve(null),
        ]);
        if (alive) {
          setInfo(c);
          setExisting(a);
        }
      } catch {
        if (alive) setInfo(null);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [target, me, chain.tradeCount]);

  const tot = parseNear(total);
  const per = parseNear(perTrade);
  const h = Number(hours);
  const min = cfg ? BigInt(cfg.min_copy) : null;
  const problems = [];
  if (!target) problems.push('Pick a creator.');
  if (me && target === me) problems.push('You cannot follow yourself.');
  if (existing) problems.push('You already follow this creator. Revoke first to change the limits.');
  if (tot === null || (min && tot < min)) problems.push(`The total cap must be at least ${cfg ? fmtNear(cfg.min_copy) : '0.05'} NEAR.`);
  if (per === null || (min && per < min)) problems.push(`The per-trade cap must be at least ${cfg ? fmtNear(cfg.min_copy) : '0.05'} NEAR.`);
  if (tot !== null && per !== null && per > tot) problems.push('The per-trade cap cannot be larger than the total cap.');
  if (!(h > 0) || h > 24 * 365) problems.push('The length must be between a few minutes and 365 days.');
  const expires = now + Math.round(h * 3_600_000);
  const fee = info ? info.fee_bps : null;

  async function submit(e) {
    e.preventDefault();
    if (problems.length || !cfg || fee === null) return;
    await send(
      `Follow ${shortAccount(target)}`,
      'follow',
      { creator: target, per_trade_cap: per.toString(), expires_at_ms: String(Date.now() + Math.round(h * 3_600_000)), max_fee_bps: fee },
      tot + BigInt(cfg.follow_storage_fee),
    );
  }

  return (
    <section className="section" id="follow">
      <div className="section-head">
        <Label>[ 02 · follow ]</Label>
        <h2>Following is a leash you hold, not a key you hand over.</h2>
        <p className="muted">
          The contract holds the total cap you deposit. It is the most your copies can ever spend. Revoke and the unspent part
          comes straight back to your wallet, in the same transaction.
        </p>
      </div>
      <div className="follow-grid">
        <form className="card" onSubmit={submit}>
          <Field label="Creator to copy" hint={creators.length ? 'Or pick one who launched here:' : null}>
            <input value={target} onChange={(e) => setTarget(e.target.value.trim().toLowerCase())} placeholder="creator.testnet" />
          </Field>
          {creators.length ? (
            <div className="chips">
              {creators.slice(0, 8).map((c) => (
                <button type="button" key={c} className={c === target ? 'chip on' : 'chip'} onClick={() => setTarget(c)}>
                  {shortAccount(c, 16)}
                </button>
              ))}
            </div>
          ) : null}
          <div className="two">
            <Field label="Total cap (NEAR)" hint="Deposited now. The most copies can spend.">
              <input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />
            </Field>
            <Field label="Per-trade cap (NEAR)" hint="The most one copy can spend.">
              <input inputMode="decimal" value={perTrade} onChange={(e) => setPerTrade(e.target.value)} />
            </Field>
          </div>
          <Field label="Ends after">
            <div className="chips">
              {[
                ['0.05', '3 min'],
                ['1', '1 hour'],
                ['24', '1 day'],
                ['168', '7 days'],
                ['720', '30 days'],
              ].map(([v, l]) => (
                <button type="button" key={v} className={hours === v ? 'chip on' : 'chip'} onClick={() => setHours(v)}>
                  {l}
                </button>
              ))}
            </div>
          </Field>
          {problems.length ? (
            <ul className="problems small">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          <button className="btn btn-accent wide" disabled={problems.length > 0 || !!busy || fee === null}>
            {busy?.startsWith('Follow') ? 'Signing…' : `Follow and deposit ${tot !== null && cfg ? fmtNear(tot + BigInt(cfg.follow_storage_fee), 3) : '…'} NEAR`}
          </button>
          <p className="small muted">Includes a {cfg ? fmtNear(cfg.follow_storage_fee) : '0.01'} NEAR fee for the record on chain.</p>
        </form>

        <div className="card summary">
          <Label>[ what you are agreeing to ]</Label>
          {target && tot !== null && per !== null ? (
            <ol>
              <li>
                You lock <b>{fmtNear(tot)} NEAR</b>. Nothing else in your wallet can be touched.
              </li>
              <li>
                Each time <b>{shortAccount(target)}</b> buys, you buy the same amount, up to <b>{fmtNear(per)} NEAR</b>, at their
                price, in their transaction.
              </li>
              <li>
                Copies cost you no fee. They earn <b>{fee === null ? '…' : `${fee / 100}%`}</b> of your profit, and only once you have
                taken out more than you put in. The share is fixed for this allowance even if they raise it later.
              </li>
              <li>
                When they sell part of a position, the tokens your copies bought sell in the same share, at the same price. While
                you hold copies, they cannot take that token out of the launchpad; they can only sell it here, with you. Tokens you
                bought yourself are never touched.
              </li>
              <li>
                It ends <b>{new Date(expires).toLocaleString()}</b> ({untilText(expires, now)}), when the cap is spent, or when you
                revoke.
              </li>
            </ol>
          ) : (
            <p className="muted">Pick a creator and limits.</p>
          )}
          {info ? (
            <dl className="kv">
              <div>
                <dt>Followers</dt>
                <dd>
                  {info.followers} / {cfg?.max_followers ?? '…'}
                </dd>
              </div>
              <div>
                <dt>Copied so far</dt>
                <dd>{fmtNear(info.copied_volume, 2)} NEAR</dd>
              </div>
              <div>
                <dt>Fees earned</dt>
                <dd>{fmtNear(info.fees_earned, 4)}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function TradeRow({ trade, me }) {
  const t = trade;
  const fee = t.copies.reduce((a, c) => a + BigInt(c.fee), 0n);
  const mineCopy = me ? t.copies.find((c) => c.follower === me) : null;
  return (
    <li className={`trade ${t.side}`}>
      <div className="trade-main">
        <span className={`side ${t.side}`}>{t.side}</span>
        <Acct id={t.trader} />
        <span>
          {t.side === 'buy' ? `${fmtNear(t.near, 3)} NEAR → ${fmtTokens(t.tokens)}` : `${fmtTokens(t.tokens)} → ${fmtNear(t.near, 3)} NEAR`}{' '}
          <b>{t.symbol.toUpperCase()}</b>
        </span>
        <span className="muted small right">{agoText(t.timestamp_ms)}</span>
      </div>
      {t.copies.length ? (
        <ul className="trade-copies">
          {t.copies.map((c) => (
            <li key={c.follower} className={c.follower === me ? 'me' : ''}>
              ↳ <Acct id={c.follower} /> {t.side === 'buy' ? `copied ${fmtNear(c.near, 3)} NEAR → ${fmtTokens(c.tokens)}` : `sold ${fmtTokens(c.tokens)} → ${fmtNear(c.near, 3)} NEAR${BigInt(c.fee) > 0n ? ` (paid ${fmtNear(c.fee, 4)} of profit to the creator)` : ''}`}
            </li>
          ))}
          <li className="muted">↳ same price for all{fee > 0n ? ` · creator earned ${fmtNear(fee, 4)} NEAR of followers' profit` : t.side === 'buy' ? ' · no fee on copies' : ''}</li>
        </ul>
      ) : null}
      {t.closed.length ? (
        <ul className="trade-copies">
          {t.closed.map((c) => (
            <li key={c.follower} className="amber">
              ↳ <Acct id={c.follower} /> not copied: allowance {c.reason}{BigInt(c.refunded) > 0n ? `, ${fmtNear(c.refunded, 3)} NEAR back to claim` : ', nothing left in it'}
            </li>
          ))}
        </ul>
      ) : null}
      {mineCopy ? <span className="sr-only">includes your copy</span> : null}
    </li>
  );
}

function Dashboard({ chain, mine, me, send, busy }) {
  const now = useNow(1000);
  const { signIn } = useWalletSelector();
  const [newFee, setNewFee] = useState('');
  const cfg = chain.config;
  if (!me) {
    return (
      <section className="section" id="dashboard">
        <div className="section-head">
          <Label>[ 03 · dashboard ]</Label>
          <h2>Your allowances, your followers, your fees.</h2>
        </div>
        <div className="card center">
          <p>Connect a testnet wallet to see your allowances, the trades copied for you and the fees you earned.</p>
          <button className="btn btn-accent" onClick={() => signIn()}>
            Connect wallet
          </button>
        </div>
      </section>
    );
  }
  const mineTrades = chain.trades.filter(
    (t) => t.trader === me || t.copies.some((c) => c.follower === me) || t.closed.some((c) => c.follower === me),
  );
  const claimable = BigInt(mine?.claimable ?? 0);
  const feeBps = Number(newFee) * 100;
  const feeOk = newFee !== '' && Number.isFinite(feeBps) && Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= (cfg?.max_fee_bps ?? 2000);

  return (
    <section className="section" id="dashboard">
      <div className="section-head">
        <Label>[ 03 · dashboard ]</Label>
        <h2>Your allowances, your followers, your fees.</h2>
        {mine?.error ? <p className="warn">Could not read your account: {mine.error}</p> : null}
      </div>

      <div className="dash">
        <div className="card">
          <h3>Creators you copy</h3>
          {!mine ? <p className="muted">Reading…</p> : null}
          {mine && mine.following.length === 0 ? <p className="muted">None yet. Follow a creator to start copying.</p> : null}
          <ul className="allowances">
            {mine?.following.map((a) => {
              const expired = a.expires_at_ms <= now;
              return (
                <li key={a.id} className={expired ? 'expired' : ''}>
                  <div className="row between">
                    <Acct id={a.creator} />
                    <span className={expired ? 'amber small' : 'small muted'}>{expired ? 'expired' : `ends in ${untilText(a.expires_at_ms, now)}`}</span>
                  </div>
                  <Bar value={a.spent} max={a.total_cap} />
                  <dl className="kv">
                    <div>
                      <dt>Spent</dt>
                      <dd>
                        {fmtNear(a.spent)} / {fmtNear(a.total_cap)}
                      </dd>
                    </div>
                    <div>
                      <dt>Per trade</dt>
                      <dd>{fmtNear(a.per_trade_cap)}</dd>
                    </div>
                    <div>
                      <dt>Copies</dt>
                      <dd>{a.copies}</dd>
                    </div>
                    <div>
                      <dt>Profit share</dt>
                      <dd>{a.fee_bps / 100}%</dd>
                    </div>
                  </dl>
                  <button
                    className="btn btn-danger wide"
                    disabled={!!busy}
                    onClick={() => send(`Revoke ${shortAccount(a.creator)}`, 'revoke', { creator: a.creator }, 1n)}
                  >
                    Revoke and get {fmtNear(a.remaining)} NEAR back
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="card">
          <h3>People copying you</h3>
          <dl className="kv">
            <div>
              <dt>Followers</dt>
              <dd>{mine?.creator?.followers ?? '…'}</dd>
            </div>
            <div>
              <dt>Copied volume</dt>
              <dd>{mine ? fmtNear(mine.creator.copied_volume, 3) : '…'}</dd>
            </div>
            <div>
              <dt>Fees earned</dt>
              <dd>{mine ? fmtNear(mine.creator.fees_earned, 4) : '…'}</dd>
            </div>
            <div>
              <dt>Your fee</dt>
              <dd>{mine ? `${mine.creator.fee_bps / 100}%` : '…'}</dd>
            </div>
          </dl>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (feeOk) send(`Set fee to ${newFee}%`, 'set_fee', { fee_bps: feeBps }, BigInt(cfg.set_fee_deposit));
            }}
          >
            <input className="grow" inputMode="decimal" placeholder="Share of profit in %, e.g. 10" value={newFee} onChange={(e) => setNewFee(e.target.value)} />
            <button className="btn btn-ghost" disabled={!feeOk || !!busy}>
              Set fee
            </button>
          </form>
          <p className="small muted">Your share of followers' profit, never of their buys. Applies to new followers only. Up to {cfg ? cfg.max_fee_bps / 100 : 20}%.</p>
          <ul className="followers">
            {mine?.followers.map((a) => (
              <li key={a.id}>
                <Acct id={a.follower} />
                <span className="small muted">
                  {fmtNear(a.remaining)} of {fmtNear(a.total_cap)} left · {fmtNear(a.per_trade_cap)}/trade · {a.expired ? 'expired' : untilText(a.expires_at_ms, now)}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h3>Waiting for you</h3>
          <p className="big">
            {fmtNear(claimable, 4)} <small>NEAR</small>
          </p>
          <p className="small muted">Creator fees, proceeds of copied sells and refunds from allowances that expired.</p>
          <button className="btn btn-accent wide" disabled={claimable === 0n || !!busy} onClick={() => send('Claim', 'claim', {}, 1n)}>
            Claim
          </button>
          <h3 className="mt">Holdings</h3>
          {mine && mine.holdings.length === 0 ? <p className="muted small">No tokens yet.</p> : null}
          <ul className="holdings">
            {mine?.holdings.map((h) => (
              <li key={h.symbol}>
                <b>{h.symbol.toUpperCase()}</b>
                <span>{fmtTokens(h.balance)}</span>
                <button
                  className="btn btn-ghost small"
                  disabled={!!busy}
                  onClick={() => send(`Withdraw ${h.symbol.toUpperCase()}`, 'withdraw_token', { symbol: h.symbol, amount: h.balance }, BigInt(cfg.withdraw_deposit))}
                  title="Send these tokens to your wallet as a plain NEP-141 balance"
                >
                  To wallet
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="card mt">
        <h3>Your trades and copies</h3>
        {mineTrades.length === 0 ? <p className="muted small">Nothing in the latest {chain.trades.length} trades.</p> : null}
        <ul className="feed">
          {mineTrades.map((t) => (
            <TradeRow key={t.index} trade={t} me={me} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function Feed({ chain, me }) {
  return (
    <section className="section" id="feed">
      <div className="section-head">
        <Label>[ 04 · on chain now ]</Label>
        <h2>Every trade, and every copy it carried.</h2>
      </div>
      <ul className="feed card">
        {chain.trades.length === 0 ? <li className="muted">No trades yet.</li> : null}
        {chain.trades.slice(0, 25).map((t) => (
          <TradeRow key={t.index} trade={t} me={me} />
        ))}
      </ul>
    </section>
  );
}

function Rules({ chain }) {
  const c = chain.config;
  const t = chain.totals;
  const [keys, setKeys] = useState(null);
  useEffect(() => {
    accessKeys(CONTRACT).then(setKeys, () => setKeys(undefined));
  }, [chain.tradeCount]);
  const keyText =
    keys === null
      ? 'reading…'
      : keys === undefined
        ? 'could not read'
        : keys.full === 0
          ? 'locked: the contract account has no full-access key, so its code can never change'
          : `not locked yet: the contract account has ${keys.full} full-access key${keys.full > 1 ? 's' : ''}, so its code could still be replaced`;
  const rows = c
    ? [
        ['Supply per token', `${fmtTokens(c.token_supply)}, minted once to the launchpad, all of it in the curve`],
        ['Curve', `constant product with a virtual reserve of ${fmtNear(c.virtual_near)} NEAR; rounding always favours the curve`],
        ['Smallest buy / copy', `${fmtNear(c.min_trade)} NEAR / ${fmtNear(c.min_copy)} NEAR`],
        ['Record fee', `${fmtNear(c.fill_storage_fee)} NEAR per fill, ${fmtNear(c.follow_storage_fee)} NEAR per follow`],
        ['Creator fee', `${c.default_fee_bps / 100}% of followers' profit unless the creator sets another, at most ${c.max_fee_bps / 100}%; nothing on copied buys, nothing until a follower has taken out more than they put in`],
        ['Withdrawals', 'a creator cannot take a token out while anyone copying them holds copies of it; they can only sell it here, with their followers'],
        ['Limits', `${c.max_followers} followers per creator, ${c.max_following} creators per follower, allowances up to ${c.max_allowance_days} days`],
        ['Token contract', `${c.token_code_bytes.toLocaleString()} bytes, sha256 ${c.token_code_sha256.slice(0, 16)}…`],
        ['Admin', 'no owner, no admin or upgrade method, no pause; token accounts have no keys'],
        ['Contract account', keyText],
      ]
    : [];
  return (
    <section className="section" id="rules">
      <div className="section-head">
        <Label>[ 05 · rules ]</Label>
        <h2>Every rule is a constant in the contract.</h2>
        <p className="muted">Read live from <code>get_config</code> and <code>get_totals</code> on {CONTRACT}.</p>
      </div>
      <div className="rules">
        <dl className="card table">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="card">
          <h3>The books</h3>
          {t ? (
            <dl className="kv col">
              <div>
                <dt>In curves</dt>
                <dd>{fmtNear(t.curves, 4)} NEAR</dd>
              </div>
              <div>
                <dt>In allowances</dt>
                <dd>{fmtNear(t.allowances, 4)} NEAR</dd>
              </div>
              <div>
                <dt>Waiting to be claimed</dt>
                <dd>{fmtNear(t.claimable, 4)} NEAR</dd>
              </div>
              <div>
                <dt>Owed to users</dt>
                <dd>
                  <b>{fmtNear(t.owed, 4)} NEAR</b>
                </dd>
              </div>
              <div>
                <dt>Held, less storage</dt>
                <dd>
                  <b>{fmtNear(BigInt(t.balance) - BigInt(t.storage_stake), 4)} NEAR</b>
                </dd>
              </div>
            </dl>
          ) : (
            <p className="muted">Reading…</p>
          )}
          <p className="small muted">Anyone can compare the two. If held is ever below owed, something is wrong.</p>
        </div>
      </div>
    </section>
  );
}

function Toasts({ toasts }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.kind === 'ok' ? 'Done' : 'Refused'}</span>
          <p>{t.text}</p>
          {t.hash ? (
            <a href={txUrl(t.hash)} target="_blank" rel="noreferrer">
              View transaction
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const { signedAccountId: me } = useWalletSelector();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const chain = useChain(tick);
  const mine = useMine(me, tick);
  const { send, busy, toasts } = useSend(refresh);
  // A token link (#t/<symbol>) opens its trade panel, so a creator can share it.
  const fromHash = () => (window.location.hash.match(/^#t\/([a-z0-9]{2,10})$/) || [])[1] || null;
  const [trading, setTradingState] = useState(fromHash);
  const [target, setTarget] = useState('');
  const setTrading = useCallback((symbol) => {
    setTradingState(symbol);
    const want = symbol ? `#t/${symbol}` : '';
    if (window.location.hash !== want) window.history.replaceState(null, '', want || window.location.pathname);
  }, []);
  useEffect(() => {
    const onHash = () => setTradingState(fromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const follow = useCallback((creator) => {
    setTrading(null);
    setTarget(creator);
    document.getElementById('follow')?.scrollIntoView({ behavior: 'smooth' });
  }, [setTrading]);

  return (
    <>
      <div className="guides" aria-hidden="true" />
      <Header onNav={() => setTrading(null)} />
      <main>
        <Hero chain={chain} />
        <Launches chain={chain} onTrade={setTrading} onFollow={follow} me={me} send={send} busy={busy} />
        <FollowSection chain={chain} me={me} target={target} setTarget={setTarget} send={send} busy={busy} />
        <Dashboard chain={chain} mine={mine} me={me} send={send} busy={busy} />
        <Feed chain={chain} me={me} />
        <Rules chain={chain} />
      </main>
      <footer className="foot">
        <span>
          CopyLaunch · built at NEAR HACKATHON 2026 · contract{' '}
          <a href={accountUrl(CONTRACT)} target="_blank" rel="noreferrer">
            {CONTRACT}
          </a>
        </span>
        {REPO ? (
          <a href={REPO} target="_blank" rel="noreferrer">
            Source
          </a>
        ) : null}
        <span className="muted">Testnet only. Testnet NEAR has no value.</span>
      </footer>
      {trading ? (
        <TradeDrawer symbol={trading} chain={chain} mine={mine} me={me} send={send} busy={busy} onClose={() => setTrading(null)} onFollow={follow} />
      ) : null}
      <Toasts toasts={toasts} />
    </>
  );
}
