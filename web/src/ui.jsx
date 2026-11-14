import { useMemo, useState } from 'react';
import { accountUrl, agoText, fmtNear, fmtTokens, shortAccount, txUrl } from './near.js';

// ---- the mascot -------------------------------------------------------------------------------

/** A duck facing right. The lead duck wears a crown; a sleepy one has its eye closed. */
export function Duck({ size = 48, body = 'var(--duck)', bill = 'var(--bill)', crown = false, sleepy = false, className = '', style }) {
  return (
    <svg viewBox="0 0 66 58" width={size} height={(size * 58) / 66} className={`duck ${className}`} style={style} aria-hidden="true">
      <path d="M9 36c-5-4-6-10-3-15 5 3 8 7 9 12z" fill={body} />
      <ellipse cx="30" cy="39" rx="22" ry="14" fill={body} />
      <circle cx="45" cy="21" r="11.5" fill={body} />
      <path d="M54.5 20c7 0 10.5 2 10.5 4.2 0 2.4-4.6 3.6-11 2.4z" fill={bill} />
      {sleepy ? (
        <path d="M44.2 19.4q2.6 1.8 5.2 0" stroke="var(--night)" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      ) : (
        <>
          <circle cx="47.2" cy="18.6" r="2.5" fill="var(--night)" />
          <circle cx="48" cy="17.8" r=".8" fill="#fff" />
        </>
      )}
      <path d="M21 37c7-8 17-7 21-1-6 8-15 8-21 1z" fill="rgba(0,0,0,.13)" />
      {crown ? <path d="M37 9.5l2.6-6 3.4 4 3-5.5 3 5.5 3.4-4 2.6 6z" fill={bill} /> : null}
    </svg>
  );
}

function hue(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** A creator's avatar: a duck in a colour derived from the account name. */
export function CreatorAvatar({ id, size = 36 }) {
  const h = hue(id || '?');
  return (
    <span className="cavatar" style={{ width: size, height: size, background: `oklch(0.32 0.05 ${h})` }}>
      <Duck size={size * 0.78} body={`oklch(0.86 0.15 ${h})`} />
    </span>
  );
}

export function TokenAvatar({ token, size = 48 }) {
  const [broken, setBroken] = useState(false);
  if (token.image && !broken) {
    return <img className="tavatar" src={token.image} alt="" width={size} height={size} onError={() => setBroken(true)} />;
  }
  const h = hue(token.symbol);
  return (
    <span className="tavatar" style={{ width: size, height: size, background: `oklch(0.84 0.16 ${h})`, fontSize: size * 0.36 }} aria-hidden="true">
      {token.symbol.slice(0, 2).toUpperCase()}
    </span>
  );
}

// ---- the flock scene in the hero --------------------------------------------------------------

export function FlockScene() {
  return (
    <figure className="flock" aria-label="One buy by a creator, copied by two followers; a third follower's allowance has ended">
      <div className="pond" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="flock-row">
        <div className="bird late">
          <Duck size={68} sleepy body="var(--duck-dim)" />
          <span className="tag tag-dim">leash ended</span>
        </div>
        <div className="bird b2">
          <Duck size={82} />
          <span className="tag">copies 1 NEAR</span>
        </div>
        <div className="bird b1">
          <Duck size={82} />
          <span className="tag">copies 0.5 · capped</span>
        </div>
        <div className="bird lead">
          <Duck size={144} crown />
          <span className="tag tag-lead">creator buys 1 NEAR</span>
        </div>
      </div>
      <figcaption>
        <b>One transaction. One price for the whole flock.</b> The creator earns only from the flock's profit.
      </figcaption>
    </figure>
  );
}

// ---- small pieces -----------------------------------------------------------------------------

export function Label({ children }) {
  return <span className="label">{children}</span>;
}

export function Acct({ id, max = 18 }) {
  return (
    <a className="acct" href={`#/c/${id}`} title={id}>
      {shortAccount(id, max)}
    </a>
  );
}

export function Explorer({ id, children }) {
  return (
    <a href={accountUrl(id)} target="_blank" rel="noreferrer" className="ext">
      {children ?? id} ↗
    </a>
  );
}

export function Bar({ value, max, tone = '' }) {
  const v = BigInt(value || 0);
  const m = BigInt(max || 0);
  const pct = m > 0n ? Number((v * 1000n) / m) / 10 : 0;
  return (
    <span className={`bar ${tone}`} role="img" aria-label={`${pct}%`}>
      <span style={{ width: `${Math.min(100, pct)}%` }} />
    </span>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Stat({ k, v, sub }) {
  return (
    <div className="stat">
      <dt>{k}</dt>
      <dd>
        {v}
        {sub ? <small>{sub}</small> : null}
      </dd>
    </div>
  );
}

// ---- charts drawn from the replayed price history ---------------------------------------------

export function Sparkline({ pts, width = 120, height = 36 }) {
  const d = useMemo(() => path(pts, width, height, 2), [pts, width, height]);
  if (!pts || pts.length < 2) return <svg width={width} height={height} className="spark flat" aria-hidden="true" />;
  const up = pts[pts.length - 1].price >= pts[0].price;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={`spark ${up ? 'up' : 'down'}`} aria-hidden="true">
      <path d={d.line} fill="none" strokeWidth="1.8" />
    </svg>
  );
}

export function PriceChart({ pts, exact }) {
  const W = 720;
  const H = 260;
  const d = useMemo(() => path(pts, W, H, 18), [pts]);
  if (!pts || pts.length < 2) return <div className="chart empty">No trades yet: the price is the launch price.</div>;
  const first = pts[0].price;
  const lastP = pts[pts.length - 1].price;
  const change = first > 0 ? ((lastP - first) / first) * 100 : 0;
  const up = change >= 0;
  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-price">{lastP.toFixed(5)}</span> <span className="muted">NEAR per 1M</span>{' '}
        <span className={up ? 'pos' : 'neg'}>
          {up ? '+' : ''}
          {change.toFixed(1)}% since launch
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className={`chart-svg ${up ? 'up' : 'down'}`} preserveAspectRatio="none" role="img" aria-label={`Price after each of ${pts.length - 1} trades`}>
        <defs>
          <linearGradient id="fillg" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity=".28" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={d.area} fill="url(#fillg)" />
        <path d={d.line} fill="none" stroke="currentColor" strokeWidth="2.4" vectorEffect="non-scaling-stroke" />
        {d.dots.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="3.2" className={p.side === 'sell' ? 'dot-sell' : 'dot-buy'} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <p className="small muted">
        Price after each of {pts.length - 1} trades, rebuilt by replaying the contract's trade log
        {exact ? '; the replay ends exactly on the curve the contract reports now.' : '.'}
      </p>
    </figure>
  );
}

function path(pts, W, H, pad) {
  if (!pts || pts.length < 2) return { line: '', area: '', dots: [] };
  const ys = pts.map((p) => p.price);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || hi * 0.02 || 1;
  const x = (i) => pad + (i / (pts.length - 1)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - lo) / span) * (H - pad * 2);
  const xy = pts.map((p, i) => ({ x: x(i), y: y(p.price), side: p.side }));
  const line = xy.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${xy[xy.length - 1].x.toFixed(1)},${H} L${xy[0].x.toFixed(1)},${H} Z`;
  return { line, area, dots: xy.slice(1) };
}

// ---- live ticker ------------------------------------------------------------------------------

export function Ticker({ trades }) {
  const items = trades.slice(0, 18);
  if (!items.length) return null;
  const row = items.map((t) => (
    <a key={t.index} href={`#/t/${t.symbol}`} className={`tick ${t.side}`}>
      <Duck size={18} crown={t.copies.length > 0} />
      <b>{shortAccount(t.trader, 14)}</b> {t.side === 'buy' ? 'bought' : 'sold'} {fmtNear(t.near, 2)} NEAR of <b>{t.symbol.toUpperCase()}</b>
      {t.copies.length ? <em> · {t.copies.length} followed</em> : null}
    </a>
  ));
  return (
    <div className="ticker" aria-label="Latest trades">
      <div className="ticker-track">
        {row}
        <span aria-hidden="true" className="ticker-dup">
          {row}
        </span>
      </div>
    </div>
  );
}

// ---- trade rows -------------------------------------------------------------------------------

export function TradeRow({ trade, me, showSymbol = true }) {
  const t = trade;
  const fee = t.copies.reduce((a, c) => a + BigInt(c.fee), 0n);
  return (
    <li className={`trade ${t.side}`}>
      <div className="trade-main">
        <span className={`side ${t.side}`}>{t.side}</span>
        <Acct id={t.trader} />
        <span>
          {t.side === 'buy' ? `${fmtNear(t.near, 3)} NEAR → ${fmtTokens(t.tokens)}` : `${fmtTokens(t.tokens)} → ${fmtNear(t.near, 3)} NEAR`}
          {showSymbol ? (
            <>
              {' '}
              <a href={`#/t/${t.symbol}`} className="sym">
                {t.symbol.toUpperCase()}
              </a>
            </>
          ) : null}
        </span>
        <span className="muted small right" title={new Date(t.timestamp_ms).toLocaleString()}>
          {agoText(t.timestamp_ms)}
        </span>
      </div>
      {t.copies.length ? (
        <ul className="trade-copies">
          {t.copies.map((c) => (
            <li key={c.follower} className={c.follower === me ? 'me' : ''}>
              <Duck size={14} /> <Acct id={c.follower} />{' '}
              {t.side === 'buy'
                ? `followed with ${fmtNear(c.near, 3)} NEAR → ${fmtTokens(c.tokens)}`
                : `sold ${fmtTokens(c.tokens)} → ${fmtNear(c.near, 3)} NEAR${BigInt(c.fee) > 0n ? ` (${fmtNear(c.fee, 4)} of profit to the creator)` : ''}`}
            </li>
          ))}
          <li className="muted">
            same price for the whole flock{fee > 0n ? ` · creator earned ${fmtNear(fee, 4)} NEAR of the flock's profit` : t.side === 'buy' ? ' · no fee on copies' : ''}
          </li>
        </ul>
      ) : null}
      {t.closed.length ? (
        <ul className="trade-copies">
          {t.closed.map((c) => (
            <li key={c.follower} className="warn-line">
              <Duck size={14} sleepy body="var(--duck-dim)" /> <Acct id={c.follower} /> stayed behind: leash {c.reason}
              {BigInt(c.refunded) > 0n ? `, ${fmtNear(c.refunded, 3)} NEAR back to claim` : ', nothing left in it'}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// ---- feedback ---------------------------------------------------------------------------------

export function Toasts({ toasts }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.kind === 'ok' ? 'Done' : 'Refused'}</span>
          <p>{t.text}</p>
          {t.hash ? (
            <a href={txUrl(t.hash)} target="_blank" rel="noreferrer">
              View transaction ↗
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Shown after the visitor's own buy or sell lands. */
export function Party({ party, onClose }) {
  if (!party) return null;
  const t = party.trade;
  const n = t.copies.length;
  return (
    <div className="party" role="dialog" aria-modal="true" aria-label="Trade landed" onClick={onClose}>
      <div className="party-card" onClick={(e) => e.stopPropagation()}>
        <div className="burst" aria-hidden="true">
          {Array.from({ length: 14 }, (_, i) => (
            <i key={i} style={{ '--a': `${(i / 14) * 360}deg`, '--d': `${60 + (i % 3) * 22}px` }} />
          ))}
        </div>
        <div className="party-flock" aria-hidden="true">
          {Array.from({ length: Math.min(n, 5) }, (_, i) => (
            <Duck key={i} size={34} style={{ animationDelay: `${i * 90}ms` }} className="hop" />
          ))}
          <Duck size={58} crown className="hop" />
        </div>
        <h3>
          {t.side === 'buy' ? 'Bought' : 'Sold'} {fmtTokens(t.tokens)} {t.symbol.toUpperCase()}
        </h3>
        <p>
          {n > 0
            ? `${n} follower${n > 1 ? 's' : ''} ${t.side === 'buy' ? 'bought' : 'sold'} with you in the same transaction, at the same price.`
            : 'Nobody follows you yet, so this trade was not copied.'}
        </p>
        {t.closed.length ? <p className="small muted">{t.closed.length} allowance(s) had ended and were closed.</p> : null}
        <div className="row center">
          {party.hash ? (
            <a className="btn btn-ghost" href={txUrl(party.hash)} target="_blank" rel="noreferrer">
              Transaction ↗
            </a>
          ) : null}
          <button className="btn btn-accent" onClick={onClose}>
            Nice
          </button>
        </div>
      </div>
    </div>
  );
}
