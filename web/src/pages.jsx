import { useEffect, useMemo, useState } from 'react';
import { useWalletSelector } from '@near-wallet-selector/react-hook';
import { CONTRACT, accessKeys, accountUrl, agoText, fmtNear, fmtPct, fmtTokens, parseNear, parseTokens, reason, shortAccount, soldBps, untilText, view } from './near.js';
import { useNow } from './data.js';
import { Acct, Bar, CreatorAvatar, Duck, Explorer, Field, FlockScene, Label, PriceChart, Sparkline, Stat, TokenAvatar, TradeRow } from './ui.jsx';

const go = (hash) => {
  window.location.hash = hash;
  window.scrollTo({ top: 0 });
};

// ---- home -------------------------------------------------------------------------------------

export function Home({ chain, stats, creators, me }) {
  const copiesAll = chain.trades.reduce((n, t) => n + t.copies.length, 0);
  const t = chain.totals;
  const free = t ? BigInt(t.balance) - BigInt(t.storage_stake) : null;
  const top = [...chain.tokens].sort((a, b) => (stats[b.symbol]?.cap > stats[a.symbol]?.cap ? 1 : -1))[0];
  const newest = [...chain.tokens].sort((a, b) => b.created_at_ms - a.created_at_ms)[0];
  const leader = creators[0];
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <Label>copy trading on a leash · NEAR testnet</Label>
          <h1>
            Ducks
            <br />
            in a row<span className="dot">.</span>
          </h1>
          <p className="lede">
            Launch a meme. Follow a creator. When they buy, you buy in the <b>same transaction</b>, at the <b>same price</b>, never
            past the limits you set. They only earn when <b>you</b> profit.
          </p>
          <div className="row">
            <a className="btn btn-accent btn-lg" href="#/explore">
              Explore the pond
            </a>
            <a className="btn btn-ghost btn-lg" href="#/launch">
              Launch a meme
            </a>
          </div>
        </div>
        <FlockScene />
      </section>

      <dl className="strip">
        <Stat k="Memes launched" v={chain.loaded ? chain.tokens.length : '…'} />
        <Stat k="Trades" v={chain.tradeCount ?? '…'} />
        <Stat k="Copies filled" v={chain.loaded ? copiesAll : '…'} />
        <Stat k="Owed / held" v={t ? `${fmtNear(t.owed, 2)} / ${fmtNear(free, 2)}` : '…'} sub="NEAR" />
      </dl>
      {chain.error ? <p className="warn">Could not read the contract: {chain.error}</p> : null}

      {chain.loaded && chain.tokens.length ? (
        <section className="spotlight">
          {top ? (
            <a className="spot" href={`#/t/${top.symbol}`}>
              <Label>top of the pond</Label>
              <div className="spot-main">
                <TokenAvatar token={top} size={56} />
                <div>
                  <h3>{top.symbol.toUpperCase()}</h3>
                  <p className="muted">{fmtNear(stats[top.symbol]?.cap ?? 0n, 2)} NEAR market cap</p>
                </div>
              </div>
              <Sparkline pts={stats[top.symbol]?.pts} width={260} height={46} />
            </a>
          ) : null}
          {leader ? (
            <a className="spot" href={`#/c/${leader.creator}`}>
              <Label>lead duck</Label>
              <div className="spot-main">
                <CreatorAvatar id={leader.creator} size={56} />
                <div>
                  <h3>{shortAccount(leader.creator, 20)}</h3>
                  <p className="muted">
                    {leader.followers} follower{leader.followers === 1 ? '' : 's'} · {fmtNear(leader.copied_volume, 2)} NEAR copied
                  </p>
                </div>
              </div>
              <p className="small muted">Earned {fmtNear(leader.fees_earned, 4)} NEAR, all of it from followers' profit.</p>
            </a>
          ) : null}
          {newest ? (
            <a className="spot" href={`#/t/${newest.symbol}`}>
              <Label>fresh egg</Label>
              <div className="spot-main">
                <TokenAvatar token={newest} size={56} />
                <div>
                  <h3>{newest.symbol.toUpperCase()}</h3>
                  <p className="muted">
                    {newest.name} · {agoText(newest.created_at_ms)}
                  </p>
                </div>
              </div>
              <p className="small muted">by {shortAccount(newest.creator, 22)}</p>
            </a>
          ) : null}
        </section>
      ) : null}

      <Explore chain={chain} stats={stats} me={me} compact />

      <section className="section how">
        <div className="section-head">
          <Label>how it works</Label>
          <h2>Four moves. All of them on chain.</h2>
        </div>
        <ol className="steps">
          <li>
            <span className="step-n">1</span>
            <h3>Launch</h3>
            <p>Each meme gets its own NEP-141 contract and a billion tokens, all of them in the curve. No allocation for anyone, the creator included.</p>
          </li>
          <li>
            <span className="step-n">2</span>
            <h3>Follow on a leash</h3>
            <p>Deposit a total cap, set a cap per trade and an end date. That deposit is the most you can ever spend. Revoke and the rest comes straight back.</p>
          </li>
          <li>
            <span className="step-n">3</span>
            <h3>Copy at one price</h3>
            <p>The creator's buy and every copy fill as one batch, so the flock pays what the creator pays. When they sell, your copies sell with them.</p>
          </li>
          <li>
            <span className="step-n">4</span>
            <h3>Paid only from profit</h3>
            <p>Copies cost no fee. The creator gets a share of what you take out beyond what you put in, and nothing before that.</p>
          </li>
        </ol>
      </section>

      <section className="section">
        <div className="section-head row between">
          <div>
            <Label>live</Label>
            <h2>Every trade, and every duck that followed it.</h2>
          </div>
        </div>
        <ul className="feed card">
          {chain.trades.length === 0 ? <li className="muted">No trades yet.</li> : null}
          {chain.trades.slice(0, 12).map((tr) => (
            <TradeRow key={tr.index} trade={tr} me={me} />
          ))}
        </ul>
      </section>
    </>
  );
}

// ---- explore ----------------------------------------------------------------------------------

export function Explore({ chain, stats, me, compact = false }) {
  const [sort, setSort] = useState('trending');
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const l = chain.tokens.filter((t) => !ql || t.symbol.includes(ql) || t.name.toLowerCase().includes(ql) || t.creator.includes(ql));
    const s = (x) => stats[x.symbol] || {};
    const by = {
      trending: (a, b) => (s(b).vol24 > s(a).vol24 ? 1 : s(b).vol24 < s(a).vol24 ? -1 : b.trades - a.trades),
      new: (a, b) => b.created_at_ms - a.created_at_ms,
      cap: (a, b) => (s(b).cap > s(a).cap ? 1 : -1),
      copied: (a, b) => (s(b).copies || 0) - (s(a).copies || 0),
    }[sort];
    return l.sort(by);
  }, [chain.tokens, stats, sort, q]);
  const shown = compact ? list.slice(0, 9) : list;
  return (
    <section className="section" id="explore">
      <div className="section-head row between wrap">
        <div>
          <Label>the pond</Label>
          <h2>{compact ? 'Memes swimming right now.' : 'Every meme launched here.'}</h2>
        </div>
        <div className="row wrap">
          <input className="search" placeholder="Search symbol, name or creator" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tokens" />
          <div className="seg" role="tablist" aria-label="Sort">
            {[
              ['trending', 'Trending'],
              ['new', 'New'],
              ['cap', 'Market cap'],
              ['copied', 'Most copied'],
            ].map(([k, v]) => (
              <button key={k} role="tab" aria-selected={sort === k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="grid">
        {shown.map((t) => (
          <TokenCard key={t.symbol} token={t} st={stats[t.symbol]} fresh={chain.fresh[t.symbol]} me={me} />
        ))}
        {chain.loaded && shown.length === 0 ? (
          <div className="card empty-card">
            <Duck size={70} sleepy body="var(--duck-dim)" />
            <p>{q ? 'Nothing matches that.' : 'The pond is empty.'}</p>
            <a className="btn btn-accent" href="#/launch">
              Launch the first meme
            </a>
          </div>
        ) : null}
      </div>
      {compact && list.length > shown.length ? (
        <p className="center mt">
          <a className="btn btn-ghost" href="#/explore">
            See all {list.length}
          </a>
        </p>
      ) : null}
    </section>
  );
}

function TokenCard({ token, st, fresh, me }) {
  const pulse = fresh && Date.now() - fresh < 6000;
  return (
    <a className={`card token ${pulse ? 'pulse' : ''}`} href={`#/t/${token.symbol}`}>
      <div className="token-head">
        <TokenAvatar token={token} />
        <div className="grow">
          <h3>{token.symbol.toUpperCase()}</h3>
          <p className="muted small">{token.name}</p>
        </div>
        <Sparkline pts={st?.pts} width={92} height={34} />
      </div>
      <dl className="kv">
        <div>
          <dt>Mkt cap</dt>
          <dd>{st ? fmtNear(st.cap, 1) : '…'}</dd>
        </div>
        <div>
          <dt>Trades</dt>
          <dd>{token.trades}</dd>
        </div>
        <div>
          <dt>Copies</dt>
          <dd>{st?.copies ?? '…'}</dd>
        </div>
      </dl>
      <div className="sold">
        <Bar value={BigInt(token.supply) - BigInt(token.token_reserve)} max={token.supply} />
        <span className="small muted">{fmtPct(soldBps(token))} bought from the curve</span>
      </div>
      <p className="small muted row between">
        <span>
          by {token.creator === me ? 'you' : shortAccount(token.creator, 18)}
        </span>
        <span>{agoText(token.created_at_ms)}</span>
      </p>
    </a>
  );
}

// ---- token page -------------------------------------------------------------------------------

export function TokenPage({ symbol, chain, stats, mine, me, send, busy }) {
  const token = chain.tokens.find((t) => t.symbol === symbol);
  const st = stats[symbol];
  const [copied, setCopied] = useState(false);
  if (!chain.loaded) return <p className="muted pad">Reading the pond…</p>;
  if (!token)
    return (
      <div className="card empty-card pad">
        <Duck size={70} sleepy body="var(--duck-dim)" />
        <p>There is no meme called {symbol.toUpperCase()} here.</p>
        <a className="btn btn-accent" href="#/explore">
          Back to the pond
        </a>
      </div>
    );
  const share = () => {
    navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="page">
      <header className="tok-head">
        <TokenAvatar token={token} size={72} />
        <div className="grow">
          <h1>{token.symbol.toUpperCase()}</h1>
          <p className="muted">
            {token.name} · by <Acct id={token.creator} /> · {agoText(token.created_at_ms)}
          </p>
          {token.description ? <p className="desc">{token.description}</p> : null}
        </div>
        <div className="row">
          <button className="btn btn-ghost" onClick={share}>
            {copied ? 'Link copied' : 'Share'}
          </button>
          <a className="btn btn-ghost" href={accountUrl(token.account_id)} target="_blank" rel="noreferrer">
            Contract ↗
          </a>
        </div>
      </header>

      <div className="tok-grid">
        <div className="tok-main">
          <div className="card">
            <PriceChart pts={st?.pts} exact={st?.exact} />
          </div>
          <dl className="strip small-strip">
            <Stat k="Market cap" v={st ? fmtNear(st.cap, 2) : '…'} sub="NEAR" />
            <Stat k="NEAR in curve" v={fmtNear(token.near_reserve, 3)} />
            <Stat k="24 h volume" v={st ? fmtNear(st.vol24, 2) : '…'} sub="NEAR" />
            <Stat k="Copies" v={st?.copies ?? '…'} />
          </dl>
          <div className="card">
            <h3>Trades</h3>
            <ul className="feed">
              {st && st.trades.length === 0 ? <li className="muted">No trades yet. Be first.</li> : null}
              {st?.trades.slice(0, 40).map((tr) => (
                <TradeRow key={tr.index} trade={tr} me={me} showSymbol={false} />
              ))}
            </ul>
          </div>
        </div>
        <aside className="tok-side">
          <TradeBox token={token} mine={mine} me={me} send={send} busy={busy} />
          <CreatorCard id={token.creator} me={me} />
          <div className="card facts">
            <h3>Facts</h3>
            <dl className="kv col">
              <div>
                <dt>Token contract</dt>
                <dd>
                  <Explorer id={token.account_id} />
                </dd>
              </div>
              <div>
                <dt>Supply</dt>
                <dd>{fmtTokens(token.supply)}, minted once</dd>
              </div>
              <div>
                <dt>Bought from the curve</dt>
                <dd>{fmtPct(soldBps(token))}</dd>
              </div>
              <div>
                <dt>Total volume</dt>
                <dd>{fmtNear(token.volume, 2)} NEAR</dd>
              </div>
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
}

function TradeBox({ token, mine, me, send, busy }) {
  const symbol = token.symbol;
  const [side, setSide] = useState('buy');
  const [amount, setAmount] = useState('1');
  const [quote, setQuote] = useState(null);
  const [qErr, setQErr] = useState(null);
  const held = BigInt(mine?.holdings?.find((h) => h.symbol === symbol)?.balance ?? 0);
  const trader = me || token.creator;
  const parsed = side === 'buy' ? parseNear(amount) : parseTokens(amount);
  useEffect(() => {
    setQuote(null);
    setQErr(null);
    if (!parsed || parsed <= 0n) return undefined;
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
  }, [symbol, side, amount, trader, token.near_reserve]); // eslint-disable-line react-hooks/exhaustive-deps
  const tooMuch = side === 'sell' && parsed !== null && parsed > held;
  const whole = (v) => (v / 10n ** 18n).toString();
  async function submit(e) {
    e.preventDefault();
    if (!parsed || !quote) return;
    const min = (BigInt(quote.own) * 98n) / 100n; // 2% slippage
    if (side === 'buy') await send(`Buy ${symbol.toUpperCase()}`, 'buy', { symbol, min_tokens_out: min.toString() }, parsed);
    else await send(`Sell ${symbol.toUpperCase()}`, 'sell', { symbol, amount: parsed.toString(), min_near_out: min.toString() }, 1n);
  }
  return (
    <form className="card tradebox" onSubmit={submit}>
      <div className="seg wide" role="tablist">
        {['buy', 'sell'].map((s) => (
          <button
            type="button"
            key={s}
            role="tab"
            aria-selected={side === s}
            className={side === s ? `on ${s}` : ''}
            onClick={() => {
              setSide(s);
              setAmount(s === 'buy' ? '1' : held > 0n ? whole(held) : '');
            }}
          >
            {s === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>
      <Field label={side === 'buy' ? 'Spend' : 'Sell'} hint={side === 'sell' ? `You hold ${me ? fmtTokens(held) : '…'}` : null}>
        <div className="amount">
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={amount !== '' && !parsed} />
          <span>{side === 'buy' ? 'NEAR' : symbol.toUpperCase()}</span>
        </div>
      </Field>
      <div className="chips">
        {side === 'buy'
          ? ['0.1', '0.5', '1', '5'].map((v) => (
              <button type="button" key={v} className={amount === v ? 'chip on' : 'chip'} onClick={() => setAmount(v)}>
                {v}
              </button>
            ))
          : [25n, 50n, 100n].map((p) => (
              <button type="button" key={String(p)} className="chip" disabled={held === 0n} onClick={() => setAmount(whole((held * p) / 100n))}>
                {String(p)}%
              </button>
            ))}
      </div>
      <div className="quote">
        {qErr ? <p className="warn small">{qErr}</p> : null}
        {quote ? (
          <>
            <p className="quote-main">
              {side === 'buy' ? 'You get' : 'You receive'} about{' '}
              <b>{side === 'buy' ? `${fmtTokens(quote.own)} ${symbol.toUpperCase()}` : `${fmtNear(quote.own, 4)} NEAR`}</b>
            </p>
            {quote.copies.length > 0 ? (
              <div className="flock-preview">
                <div className="flock-mini" aria-hidden="true">
                  {quote.copies.slice(0, 6).map((c) => (
                    <Duck key={c.follower} size={22} />
                  ))}
                  <Duck size={34} crown />
                </div>
                <p className="small">
                  {quote.copies.length} follower{quote.copies.length > 1 ? 's' : ''} {side === 'buy' ? 'buy' : 'sell'} with {me ? 'you' : 'the creator'},
                  same transaction, same price:
                </p>
                <ul>
                  {quote.copies.map((c) => (
                    <li key={c.follower}>
                      <Acct id={c.follower} max={16} />
                      <span>{side === 'buy' ? `${fmtNear(c.near, 3)} NEAR` : `${fmtNear(c.near, 4)} NEAR`}</span>
                      <span className="muted">{BigInt(c.fee) > 0n ? `${fmtNear(c.fee, 4)} of profit to creator` : 'no fee'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="small muted">{me ? 'Nobody follows you yet, so this trade is not copied.' : 'Quoted as the creator. Connect a wallet for your own quote.'}</p>
            )}
            <p className="small muted">Fails if the price moves more than 2% before it lands.</p>
          </>
        ) : null}
      </div>
      {tooMuch ? <p className="warn small">You hold {fmtTokens(held)}.</p> : null}
      <button className={`btn btn-lg wide ${side === 'buy' ? 'btn-buy' : 'btn-sell'}`} disabled={!quote || !!busy || tooMuch}>
        {busy ? `${busy}…` : !me ? 'Connect wallet to trade' : side === 'buy' ? `Buy for ${amount || 0} NEAR` : `Sell ${amount || 0} ${symbol.toUpperCase()}`}
      </button>
    </form>
  );
}

function CreatorCard({ id, me }) {
  const [c, setC] = useState(null);
  useEffect(() => {
    view('get_creator', { creator: id }).then(setC, () => setC(null));
  }, [id]);
  return (
    <a className="card creator-card" href={`#/c/${id}`}>
      <div className="row">
        <CreatorAvatar id={id} size={44} />
        <div className="grow">
          <Label>creator</Label>
          <h3>{shortAccount(id, 22)}</h3>
        </div>
      </div>
      {c ? (
        <dl className="kv">
          <div>
            <dt>Followers</dt>
            <dd>{c.followers}</dd>
          </div>
          <div>
            <dt>Copied</dt>
            <dd>{fmtNear(c.copied_volume, 2)}</dd>
          </div>
          <div>
            <dt>Share</dt>
            <dd>{c.fee_bps / 100}%</dd>
          </div>
        </dl>
      ) : null}
      <span className="btn btn-accent wide">{id === me ? 'Your profile' : 'Copy their next buys'}</span>
    </a>
  );
}

// ---- creator page -----------------------------------------------------------------------------

export function CreatorPage({ id, chain, stats, me, send, busy }) {
  const [c, setC] = useState(null);
  const [followers, setFollowers] = useState([]);
  useEffect(() => {
    let alive = true;
    Promise.all([view('get_creator', { creator: id }), view('get_followers', { creator: id })]).then(
      ([cr, fl]) => {
        if (alive) {
          setC(cr);
          setFollowers(fl);
        }
      },
      () => alive && setC(null),
    );
    return () => {
      alive = false;
    };
  }, [id, chain.tradeCount]);
  const flows = useMemo(() => {
    let paidIn = 0n;
    let takenOut = 0n;
    for (const t of chain.trades) {
      if (t.trader !== id) continue;
      for (const cp of t.copies) {
        if (t.side === 'buy') paidIn += BigInt(cp.near);
        else takenOut += BigInt(cp.near) + BigInt(cp.fee);
      }
    }
    return { paidIn, takenOut };
  }, [chain.trades, id]);
  const launched = chain.tokens.filter((t) => t.creator === id);
  const trades = chain.trades.filter((t) => t.trader === id).slice(0, 20);
  const cfg = chain.config;
  return (
    <div className="page">
      <header className="tok-head">
        <CreatorAvatar id={id} size={80} />
        <div className="grow">
          <Label>creator</Label>
          <h1 className="acct-title">{id}</h1>
          <p className="muted">
            <Explorer id={id}>on the explorer</Explorer>
          </p>
        </div>
      </header>
      <dl className="strip">
        <Stat k="Followers" v={c ? `${c.followers} / ${cfg?.max_followers ?? 32}` : '…'} />
        <Stat k="NEAR copied" v={c ? fmtNear(c.copied_volume, 2) : '…'} />
        <Stat k="Flock took out / put in" v={`${fmtNear(flows.takenOut, 2)} / ${fmtNear(flows.paidIn, 2)}`} sub="NEAR" />
        <Stat k="Earned from flock profit" v={c ? fmtNear(c.fees_earned, 4) : '…'} sub={c ? `at ${c.fee_bps / 100}%` : ''} />
      </dl>
      <p className="small muted note">
        "Took out / put in" counts the NEAR the creator's sells returned to followers against what followers' copies spent, from the trade log.
        Positions still open are not counted.
      </p>
      <div className="tok-grid">
        <div className="tok-main">
          {launched.length ? (
            <div>
              <h3 className="sub">Launched</h3>
              <div className="grid">
                {launched.map((t) => (
                  <TokenCard key={t.symbol} token={t} st={stats[t.symbol]} fresh={chain.fresh[t.symbol]} me={me} />
                ))}
              </div>
            </div>
          ) : null}
          <div className="card mt">
            <h3>Recent trades</h3>
            <ul className="feed">
              {trades.length === 0 ? <li className="muted">No trades yet.</li> : null}
              {trades.map((tr) => (
                <TradeRow key={tr.index} trade={tr} me={me} />
              ))}
            </ul>
          </div>
        </div>
        <aside className="tok-side">
          {id === me ? (
            <div className="card">
              <h3>This is you</h3>
              <p className="muted">Followers, fees and your profit share are on your dashboard.</p>
              <a className="btn btn-accent wide" href="#/me">
                Open my flock
              </a>
            </div>
          ) : (
            <LeashForm target={id} chain={chain} me={me} send={send} busy={busy} />
          )}
          <div className="card">
            <h3>The flock</h3>
            {followers.length === 0 ? <p className="muted small">Nobody follows {shortAccount(id)} yet.</p> : null}
            <ul className="followers">
              {followers.map((a) => (
                <li key={a.id}>
                  <Acct id={a.follower} />
                  <Bar value={a.spent} max={a.total_cap} />
                  <span className="small muted">
                    {fmtNear(a.spent)} of {fmtNear(a.total_cap)} spent · {fmtNear(a.per_trade_cap)}/trade · {a.expired ? 'ended' : untilText(a.expires_at_ms)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

function LeashForm({ target, chain, me, send, busy }) {
  const now = useNow(30_000);
  const [total, setTotal] = useState('2');
  const [perTrade, setPerTrade] = useState('0.5');
  const [hours, setHours] = useState('24');
  const [info, setInfo] = useState(null);
  const [existing, setExisting] = useState(null);
  const cfg = chain.config;
  useEffect(() => {
    let alive = true;
    Promise.all([view('get_creator', { creator: target }), me ? view('get_allowance', { follower: me, creator: target }) : Promise.resolve(null)]).then(
      ([c, a]) => {
        if (alive) {
          setInfo(c);
          setExisting(a);
        }
      },
      () => alive && setInfo(null),
    );
    return () => {
      alive = false;
    };
  }, [target, me, chain.tradeCount]);
  const tot = parseNear(total);
  const per = parseNear(perTrade);
  const h = Number(hours);
  const min = cfg ? BigInt(cfg.min_copy) : null;
  const problems = [];
  if (existing) problems.push('You already follow this creator. Revoke on your dashboard to change the limits.');
  if (tot === null || (min && tot < min)) problems.push(`The total cap must be at least ${cfg ? fmtNear(cfg.min_copy) : '0.05'} NEAR.`);
  if (per === null || (min && per < min)) problems.push(`The per-trade cap must be at least ${cfg ? fmtNear(cfg.min_copy) : '0.05'} NEAR.`);
  if (tot !== null && per !== null && per > tot) problems.push('The per-trade cap cannot be larger than the total cap.');
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
  if (existing) {
    return (
      <div className="card leash">
        <Label>you follow them</Label>
        <Bar value={existing.spent} max={existing.total_cap} />
        <p className="small">
          {fmtNear(existing.spent)} of {fmtNear(existing.total_cap)} NEAR spent · {fmtNear(existing.per_trade_cap)} per trade ·{' '}
          {existing.expired ? 'ended' : `ends in ${untilText(existing.expires_at_ms, now)}`}
        </p>
        <a className="btn btn-ghost wide" href="#/me">
          Manage on your dashboard
        </a>
      </div>
    );
  }
  return (
    <form className="card leash" onSubmit={submit}>
      <Label>put a leash on it</Label>
      <h3>Copy {shortAccount(target, 20)}</h3>
      <div className="two">
        <Field label="Total cap" hint="Deposited now. The most you can ever spend.">
          <div className="amount">
            <input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />
            <span>NEAR</span>
          </div>
        </Field>
        <Field label="Per trade" hint="The most one copy spends.">
          <div className="amount">
            <input inputMode="decimal" value={perTrade} onChange={(e) => setPerTrade(e.target.value)} />
            <span>NEAR</span>
          </div>
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
      {tot !== null && per !== null ? (
        <ol className="agree small">
          <li>
            You lock <b>{fmtNear(tot)} NEAR</b>. Nothing else in your wallet is reachable.
          </li>
          <li>
            When they buy, you buy the same amount, up to <b>{fmtNear(per)} NEAR</b>, at their price, in their transaction.
          </li>
          <li>
            Copies cost no fee. They get <b>{fee === null ? '…' : `${fee / 100}%`}</b> of what you take out beyond what you put in, and nothing before.
          </li>
          <li>When they sell, your copies sell in the same share. While you hold copies, they can only sell here, with you.</li>
          <li>
            Ends <b>{new Date(expires).toLocaleString()}</b>, when the cap is spent, or when you revoke.
          </li>
        </ol>
      ) : null}
      {problems.length ? (
        <ul className="problems small">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <button className="btn btn-accent btn-lg wide" disabled={problems.length > 0 || !!busy || fee === null}>
        {busy?.startsWith('Follow') ? 'Signing…' : !me ? 'Connect wallet to follow' : `Follow and lock ${tot !== null && cfg ? fmtNear(tot + BigInt(cfg.follow_storage_fee), 3) : '…'} NEAR`}
      </button>
      <p className="small muted">Includes {cfg ? fmtNear(cfg.follow_storage_fee) : '0.01'} NEAR for the record on chain.</p>
    </form>
  );
}

// ---- creators leaderboard ---------------------------------------------------------------------

export function Creators({ creators, me }) {
  return (
    <div className="page">
      <div className="section-head">
        <Label>lead ducks</Label>
        <h1>Who the pond follows.</h1>
        <p className="muted">
          Ranked by followers. A creator's earnings come only from followers' profit, so "earned" is a track record you cannot buy with
          wash trades.
        </p>
      </div>
      <div className="card table-wrap">
        <table className="board">
          <thead>
            <tr>
              <th>#</th>
              <th>Creator</th>
              <th>Followers</th>
              <th>NEAR copied</th>
              <th>Flock out / in</th>
              <th>Earned</th>
              <th>Memes</th>
            </tr>
          </thead>
          <tbody>
            {creators.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  Reading…
                </td>
              </tr>
            ) : null}
            {creators.map((c, i) => (
              <tr key={c.creator} onClick={() => go(`#/c/${c.creator}`)}>
                <td className="rank">{i + 1}</td>
                <td>
                  <span className="row nowrap">
                    <CreatorAvatar id={c.creator} size={30} />
                    <Acct id={c.creator} max={22} />
                    {c.creator === me ? <span className="pill">you</span> : null}
                  </span>
                </td>
                <td>{c.followers}</td>
                <td>{fmtNear(c.copied_volume, 2)}</td>
                <td>
                  {fmtNear(c.flows.takenOut, 2)} / {fmtNear(c.flows.paidIn, 2)}
                </td>
                <td>{fmtNear(c.fees_earned, 4)}</td>
                <td>{c.launched}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- my flock (dashboard) ---------------------------------------------------------------------

export function Me({ chain, mine, me, send, busy }) {
  const now = useNow(1000);
  const { signIn } = useWalletSelector();
  const [newFee, setNewFee] = useState('');
  const cfg = chain.config;
  if (!me) {
    return (
      <div className="page">
        <div className="card empty-card pad">
          <Duck size={84} />
          <h2>Your flock lives here.</h2>
          <p className="muted">Connect a testnet wallet to see your leashes, the people copying you, and what is waiting to be claimed.</p>
          <button className="btn btn-accent btn-lg" onClick={() => signIn()}>
            Connect wallet
          </button>
        </div>
      </div>
    );
  }
  const mineTrades = chain.trades.filter((t) => t.trader === me || t.copies.some((c) => c.follower === me) || t.closed.some((c) => c.follower === me));
  const claimable = BigInt(mine?.claimable ?? 0);
  const feeBps = Number(newFee) * 100;
  const feeOk = newFee !== '' && Number.isFinite(feeBps) && Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= (cfg?.max_fee_bps ?? 2000);
  return (
    <div className="page">
      <header className="tok-head">
        <CreatorAvatar id={me} size={72} />
        <div className="grow">
          <Label>my flock</Label>
          <h1 className="acct-title">{me}</h1>
          {mine?.error ? <p className="warn">Could not read your account: {mine.error}</p> : null}
        </div>
        <div className="claim-box">
          <span className="label">waiting for you</span>
          <b>{fmtNear(claimable, 4)} NEAR</b>
          <button className="btn btn-accent" disabled={claimable === 0n || !!busy} onClick={() => send('Claim', 'claim', {}, 1n)}>
            Claim
          </button>
        </div>
      </header>

      <div className="dash">
        <div className="card">
          <h3>Leashes you hold</h3>
          <p className="small muted">Creators you copy, and how much of each cap is spent.</p>
          {mine && mine.following.length === 0 ? (
            <p className="muted">
              None yet. <a href="#/creators">Find a lead duck</a>.
            </p>
          ) : null}
          <ul className="allowances">
            {mine?.following.map((a) => {
              const ended = a.expires_at_ms <= now;
              return (
                <li key={a.id} className={ended ? 'ended' : ''}>
                  <div className="row between">
                    <span className="row nowrap">
                      <CreatorAvatar id={a.creator} size={28} />
                      <Acct id={a.creator} />
                    </span>
                    <span className={ended ? 'warn small' : 'small muted'}>{ended ? 'ended' : `ends in ${untilText(a.expires_at_ms, now)}`}</span>
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
                      <dt>Their share</dt>
                      <dd>{a.fee_bps / 100}%</dd>
                    </div>
                  </dl>
                  <button className="btn btn-danger wide" disabled={!!busy} onClick={() => send(`Revoke ${shortAccount(a.creator)}`, 'revoke', { creator: a.creator }, 1n)}>
                    Let go: get {fmtNear(a.remaining)} NEAR back
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="card">
          <h3>Your flock</h3>
          <dl className="kv">
            <div>
              <dt>Followers</dt>
              <dd>{mine?.creator?.followers ?? '…'}</dd>
            </div>
            <div>
              <dt>Copied</dt>
              <dd>{mine ? fmtNear(mine.creator.copied_volume, 3) : '…'}</dd>
            </div>
            <div>
              <dt>Earned</dt>
              <dd>{mine ? fmtNear(mine.creator.fees_earned, 4) : '…'}</dd>
            </div>
            <div>
              <dt>Your share</dt>
              <dd>{mine ? `${mine.creator.fee_bps / 100}%` : '…'}</dd>
            </div>
          </dl>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (feeOk) send(`Set share to ${newFee}%`, 'set_fee', { fee_bps: feeBps }, BigInt(cfg.set_fee_deposit));
            }}
          >
            <input className="grow" inputMode="decimal" placeholder="Share of profit in %, e.g. 10" value={newFee} onChange={(e) => setNewFee(e.target.value)} />
            <button className="btn btn-ghost" disabled={!feeOk || !!busy}>
              Set
            </button>
          </form>
          <p className="small muted">Your share of followers' profit, never of their buys. New followers only. Up to {cfg ? cfg.max_fee_bps / 100 : 20}%.</p>
          <ul className="followers">
            {mine?.followers.map((a) => (
              <li key={a.id}>
                <Acct id={a.follower} />
                <Bar value={a.spent} max={a.total_cap} />
                <span className="small muted">
                  {fmtNear(a.remaining)} of {fmtNear(a.total_cap)} left · {fmtNear(a.per_trade_cap)}/trade · {a.expired ? 'ended' : untilText(a.expires_at_ms, now)}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h3>Holdings</h3>
          {mine && mine.holdings.length === 0 ? <p className="muted small">No memes yet.</p> : null}
          <ul className="holdings">
            {mine?.holdings.map((h) => (
              <li key={h.symbol}>
                <a href={`#/t/${h.symbol}`} className="sym">
                  {h.symbol.toUpperCase()}
                </a>
                <span>{fmtTokens(h.balance)}</span>
                <button
                  className="btn btn-ghost small"
                  disabled={!!busy}
                  title="Send these tokens to your wallet as a plain NEP-141 balance"
                  onClick={() => send(`Withdraw ${h.symbol.toUpperCase()}`, 'withdraw_token', { symbol: h.symbol, amount: h.balance }, BigInt(cfg.withdraw_deposit))}
                >
                  To wallet
                </button>
              </li>
            ))}
          </ul>
          <p className="small muted">
            While people copying you hold a meme you bought, you can only sell it here, so they leave with you.
          </p>
        </div>
      </div>

      <div className="card mt">
        <h3>Your trades and copies</h3>
        {mineTrades.length === 0 ? <p className="muted small">Nothing yet.</p> : null}
        <ul className="feed">
          {mineTrades.slice(0, 40).map((t) => (
            <TradeRow key={t.index} trade={t} me={me} />
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---- launch -----------------------------------------------------------------------------------

export function Launch({ chain, me, send, busy }) {
  const [f, setF] = useState({ symbol: '', name: '', description: '', image: '' });
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: k === 'symbol' ? e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '') : e.target.value }));
  const cfg = chain.config;
  const taken = chain.tokens.some((t) => t.symbol === f.symbol);
  const symbolOk = /^[a-z0-9]{2,10}$/.test(f.symbol) && !taken;
  const imageOk = !f.image || (f.image.startsWith('https://') && f.image.length <= 300);
  const ok = symbolOk && f.name.trim().length > 0 && f.name.trim().length <= 40 && f.description.length <= 280 && imageOk && cfg;
  const preview = { symbol: f.symbol || 'meme', name: f.name || 'Your meme', image: imageOk && f.image ? f.image : null };
  async function submit(e) {
    e.preventDefault();
    if (!ok) return;
    const r = await send(
      `Launch ${f.symbol.toUpperCase()}`,
      'launch',
      { symbol: f.symbol, name: f.name.trim(), description: f.description.trim() || null, image: f.image || null },
      BigInt(cfg.launch_cost),
    );
    if (r !== undefined) {
      const s = f.symbol;
      setF({ symbol: '', name: '', description: '', image: '' });
      setTimeout(() => go(`#/t/${s}`), 1500);
    }
  }
  return (
    <div className="page">
      <div className="section-head">
        <Label>lay an egg</Label>
        <h1>Launch a meme.</h1>
        <p className="muted">
          A new NEP-141 contract at <code>{f.symbol || 'symbol'}.{CONTRACT}</code>, one billion tokens, all of them in the curve. No allocation
          for anyone, you included. Buy your own like everyone else.
        </p>
      </div>
      <div className="launch-grid">
        <form className="card" onSubmit={submit}>
          <Field label="Symbol" hint={taken ? 'That symbol is taken.' : '2 to 10 lower-case letters and digits. It becomes an account name.'}>
            <input value={f.symbol} onChange={set('symbol')} maxLength={10} placeholder="quack" aria-invalid={f.symbol !== '' && !symbolOk} />
          </Field>
          <Field label="Name">
            <input value={f.name} onChange={set('name')} maxLength={40} placeholder="Quack Coin" />
          </Field>
          <Field label="Story" hint={`${f.description.length} of 280`}>
            <textarea value={f.description} onChange={set('description')} maxLength={280} rows={3} placeholder="What the meme is about" />
          </Field>
          <Field label="Image (optional)" hint="An https link to a square image">
            <input value={f.image} onChange={set('image')} placeholder="https://…" aria-invalid={!imageOk} />
          </Field>
          <button className="btn btn-accent btn-lg wide" disabled={!ok || !!busy}>
            {busy?.startsWith('Launch') ? 'Launching…' : !me ? 'Connect wallet to launch' : `Launch for ${cfg ? fmtNear(cfg.launch_cost, 3) : '…'} NEAR`}
          </button>
          <p className="small muted">The cost pays for the token contract's storage on chain. Anything extra comes back.</p>
        </form>
        <div className="preview">
          <Label>preview</Label>
          <div className="card token">
            <div className="token-head">
              <TokenAvatar token={preview} />
              <div className="grow">
                <h3>{preview.symbol.toUpperCase()}</h3>
                <p className="muted small">{preview.name}</p>
              </div>
            </div>
            {f.description ? <p className="desc">{f.description}</p> : null}
            <dl className="kv">
              <div>
                <dt>Mkt cap</dt>
                <dd>{cfg ? fmtNear(cfg.virtual_near, 1) : '…'}</dd>
              </div>
              <div>
                <dt>Trades</dt>
                <dd>0</dd>
              </div>
              <div>
                <dt>Copies</dt>
                <dd>0</dd>
              </div>
            </dl>
            <div className="sold">
              <Bar value={0} max={1} />
              <span className="small muted">0% bought from the curve</span>
            </div>
          </div>
          <div className="egg" aria-hidden="true">
            <Duck size={120} crown />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- rules ------------------------------------------------------------------------------------

export function Rules({ chain }) {
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
        ['Supply per meme', `${fmtTokens(c.token_supply)}, minted once to the launchpad, all of it in the curve`],
        ['Curve', `constant product with a virtual reserve of ${fmtNear(c.virtual_near)} NEAR; rounding always favours the curve`],
        ['Smallest buy / copy', `${fmtNear(c.min_trade)} NEAR / ${fmtNear(c.min_copy)} NEAR`],
        ['Record fee', `${fmtNear(c.fill_storage_fee)} NEAR per fill, ${fmtNear(c.follow_storage_fee)} NEAR per follow`],
        ['Creator fee', `${c.default_fee_bps / 100}% of followers' profit unless the creator sets another, at most ${c.max_fee_bps / 100}%; nothing on copied buys, nothing until a follower has taken out more than they put in`],
        ['Withdrawals', 'a creator cannot take a meme out while anyone copying them holds copies of it; they can only sell it here, with their followers'],
        ['Limits', `${c.max_followers} followers per creator, ${c.max_following} creators per follower, leashes up to ${c.max_allowance_days} days`],
        ['Token contract', `${c.token_code_bytes.toLocaleString()} bytes, sha256 ${c.token_code_sha256.slice(0, 16)}…`],
        ['Admin', 'no owner, no admin or upgrade method, no pause; token accounts have no keys'],
        ['Contract account', keyText],
      ]
    : [];
  return (
    <div className="page">
      <div className="section-head">
        <Label>rules of the pond</Label>
        <h1>Every rule is a constant in the contract.</h1>
        <p className="muted">
          Read live from <code>get_config</code> and <code>get_totals</code> on <Explorer id={CONTRACT} />.
        </p>
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
                <dt>In leashes</dt>
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
    </div>
  );
}
