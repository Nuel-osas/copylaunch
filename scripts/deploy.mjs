// Deploys build/copylaunch.wasm to the contract account and initialises it once.
//   node scripts/deploy.mjs            (contract account: copylaunch.testnet, or $COPYLAUNCH)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { actions } from 'near-api-js';
import { CONTRACT, EXPLORER, account, accountInfo, call, near, root, send, view } from './lib.mjs';

const wasmPath = path.join(root, 'build/copylaunch.wasm');
if (!fs.existsSync(wasmPath)) throw new Error('build/copylaunch.wasm is missing: run `make build` first');
const wasm = fs.readFileSync(wasmPath);
const sha = crypto.createHash('sha256').update(wasm).digest('hex');

const before = await accountInfo(CONTRACT);
if (!before) throw new Error(`${CONTRACT} does not exist on testnet`);
console.log(`contract account  ${CONTRACT}  balance ${near(before.amount)} NEAR`);
console.log(`wasm              ${wasm.length} bytes  sha256 ${sha}`);

const signer = account(CONTRACT);
const deployed = await send(signer, CONTRACT, [actions.deployContract(wasm)]);
if (!deployed.ok) throw new Error(`deploy failed: ${deployed.error}`);
console.log(`deployed          ${EXPLORER}${deployed.hash}`);

let initialised = true;
try {
  await view(CONTRACT, 'get_token_count');
} catch {
  initialised = false;
}
if (!initialised) {
  const init = await call(signer, CONTRACT, 'new', {});
  if (!init.ok) throw new Error(`init failed: ${init.error}`);
  console.log(`initialised       ${EXPLORER}${init.hash}`);
} else {
  console.log('already initialised: state kept');
}

const cfg = await view(CONTRACT, 'get_config');
const after = await accountInfo(CONTRACT);
console.log(`launch cost       ${near(cfg.launch_cost)} NEAR (token contract: ${cfg.token_code_bytes} bytes, sha256 ${cfg.token_code_sha256})`);
console.log(`storage locked    ${near(BigInt(after.storage_usage) * 10n ** 19n)} NEAR of ${near(after.amount)} NEAR`);
