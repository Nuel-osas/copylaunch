// Compares the code deployed on testnet with the wasm in build/. NEAR reports a contract's code
// hash as base58(sha256(wasm)). Exits non-zero on a mismatch.
//   make build && node scripts/check-deployed.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONTRACT, accountInfo, root, view } from './lib.mjs';

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf) {
  let n = BigInt('0x' + buf.toString('hex'));
  let s = '';
  while (n > 0n) {
    s = A[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}
const hashOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest();

let bad = 0;
const pad = hashOf('build/copylaunch.wasm');
const onChain = (await accountInfo(CONTRACT))?.code_hash;
console.log(`${CONTRACT}: on chain ${onChain}, build/copylaunch.wasm ${base58(pad)}`);
if (onChain !== base58(pad)) bad++;

const token = hashOf('build/copylaunch_token.wasm');
const cfg = await view(CONTRACT, 'get_config');
console.log(`token code embedded in the launchpad: sha256 ${cfg.token_code_sha256}, build/copylaunch_token.wasm ${token.toString('hex')}`);
if (cfg.token_code_sha256 !== token.toString('hex')) bad++;

const tokens = await view(CONTRACT, 'get_tokens', { from_index: 0, limit: 100 });
for (const t of tokens) {
  const h = (await accountInfo(t.account_id))?.code_hash;
  const ok = h === base58(token);
  if (!ok) bad++;
  console.log(`${t.account_id}: ${ok ? 'same code' : `DIFFERENT code ${h}`}`);
}
console.log(bad ? `${bad} mismatch(es)` : 'all deployed code matches build/');
process.exit(bad ? 1 : 0);
