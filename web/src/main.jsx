import './polyfill.js';
import '@near-wallet-selector/modal-ui/styles.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WalletSelectorProvider } from '@near-wallet-selector/react-hook';
import { setupHereWallet } from '@near-wallet-selector/here-wallet';
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import App from './App.jsx';
import { CONTRACT, NETWORK } from './near.js';

const config = {
  network: NETWORK,
  // Every CopyLaunch call attaches a deposit, so each one is confirmed in the wallet.
  createAccessKeyFor: CONTRACT,
  modules: [setupMeteorWallet(), setupMyNearWallet(), setupIntearWallet(), setupHereWallet()],
};

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <WalletSelectorProvider config={config}>
      <App />
    </WalletSelectorProvider>
  </StrictMode>,
);
