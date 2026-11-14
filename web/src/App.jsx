import { useCallback, useEffect, useState } from 'react';
import { useWalletSelector } from '@near-wallet-selector/react-hook';
import { CONTRACT, accountUrl, shortAccount } from './near.js';
import { setSound, soundOn, useChain, useCreators, useMine, useSend, useTokenStats } from './data.js';
import { Duck, Party, Ticker, Toasts } from './ui.jsx';
import { CreatorPage, Creators, Explore, Home, Launch, Me, Rules, TokenPage } from './pages.jsx';

const REPO = import.meta.env.VITE_REPO || '';

/** Reads the hash route. Old token links (#t/<symbol>) still open the token. */
function parseRoute(hash) {
  const h = hash.replace(/^#/, '');
  const legacy = h.match(/^t\/([a-z0-9]{2,10})$/);
  if (legacy) return { page: 'token', arg: legacy[1] };
  const parts = h.replace(/^\//, '').split('/');
  switch (parts[0]) {
    case 't':
      return parts[1] ? { page: 'token', arg: parts[1].toLowerCase() } : { page: 'explore' };
    case 'c':
      return parts[1] ? { page: 'creator', arg: decodeURIComponent(parts[1]) } : { page: 'creators' };
    case 'explore':
    case 'creators':
    case 'me':
    case 'launch':
    case 'rules':
      return { page: parts[0] };
    default:
      return { page: 'home' };
  }
}

function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function Header({ route }) {
  const { signedAccountId, signIn, signOut } = useWalletSelector();
  const [snd, setSnd] = useState(soundOn());
  const [open, setOpen] = useState(false);
  const link = (page, href, text) => (
    <a href={href} className={route.page === page ? 'on' : ''} onClick={() => setOpen(false)}>
      {text}
    </a>
  );
  return (
    <header className="top">
      <a className="brand" href="#/">
        <Duck size={34} crown />
        <span>copylaunch</span>
      </a>
      <nav className={`nav ${open ? 'open' : ''}`}>
        {link('explore', '#/explore', 'Explore')}
        {link('creators', '#/creators', 'Lead ducks')}
        {link('launch', '#/launch', 'Launch')}
        {link('me', '#/me', 'My flock')}
        {link('rules', '#/rules', 'Rules')}
      </nav>
      <div className="top-right">
        <button
          className="snd"
          onClick={() => {
            setSound(!snd);
            setSnd(!snd);
          }}
          aria-pressed={snd}
          title="Sound"
        >
          [ sound {snd ? 'on' : 'off'} ]
        </button>
        <span className="net">
          <i /> testnet
        </span>
        {signedAccountId ? (
          <button className="btn btn-ghost" onClick={() => signOut()} title="Sign out">
            {shortAccount(signedAccountId, 18)}
          </button>
        ) : (
          <button className="btn btn-accent" onClick={() => signIn()}>
            Connect
          </button>
        )}
        <button className="burger" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span />
          <span />
        </button>
      </div>
    </header>
  );
}

export default function App() {
  const { signedAccountId: me } = useWalletSelector();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const chain = useChain(tick);
  const stats = useTokenStats(chain);
  const creators = useCreators(chain);
  const mine = useMine(me, tick);
  const { send, busy, toasts, party, clearParty } = useSend(refresh);
  const route = useRoute();
  const props = { chain, stats, creators, mine, me, send, busy };

  let page;
  switch (route.page) {
    case 'token':
      page = <TokenPage symbol={route.arg} {...props} />;
      break;
    case 'creator':
      page = <CreatorPage id={route.arg} {...props} />;
      break;
    case 'explore':
      page = (
        <div className="page">
          <Explore {...props} />
        </div>
      );
      break;
    case 'creators':
      page = <Creators {...props} />;
      break;
    case 'me':
      page = <Me {...props} />;
      break;
    case 'launch':
      page = <Launch {...props} />;
      break;
    case 'rules':
      page = <Rules {...props} />;
      break;
    default:
      page = <Home {...props} />;
  }

  return (
    <>
      <div className="grain" aria-hidden="true" />
      <Header route={route} />
      <Ticker trades={chain.trades} />
      <main key={route.page + (route.arg || '')} className="view">
        {page}
      </main>
      <footer className="foot">
        <div className="foot-brand">
          <Duck size={44} crown />
          <p>
            <b>copylaunch</b>
            <br />
            Ducks in a row, on NEAR testnet. Built at NEAR HACKATHON 2026.
          </p>
        </div>
        <div className="foot-links">
          <a href={accountUrl(CONTRACT)} target="_blank" rel="noreferrer">
            {CONTRACT} ↗
          </a>
          {REPO ? (
            <a href={REPO} target="_blank" rel="noreferrer">
              Source ↗
            </a>
          ) : null}
          <a href="#/rules">Rules and the books</a>
          <span className="muted">Testnet only. Testnet NEAR has no value. Not audited.</span>
        </div>
      </footer>
      <Party party={party} onClose={clearParty} />
      <Toasts toasts={toasts} />
    </>
  );
}
