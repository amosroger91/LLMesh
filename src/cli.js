import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { generateSecretKey } from './identity.js';
import { Service } from './service.js';
import { startApi } from './api.js';
import { Payments } from './payments.js';
import { Wallet } from 'ethers';
import { loadKey } from './key-store.js';

const levelIndex = process.argv.indexOf('--level');
if (levelIndex >= 0 && !['low', 'medium', 'high'].includes(process.argv[levelIndex + 1])) { console.error('Usage: npm run headless -- --level low|medium|high'); process.exit(1); }
if (process.platform === 'win32' && !process.env.LLMESH_KEY_PASSPHRASE) console.warn('Headless keys require OS ACL protection on Windows; file mode 0600 alone does not restrict access.');
const directory = resolve(process.env.LLMESH_HOME ?? '.llmesh');
mkdirSync(directory, { recursive: true });
const passphrase = process.env.LLMESH_KEY_PASSPHRASE;
const identity = loadKey(join(directory, 'identity.key'), () => Buffer.from(generateSecretKey()).toString('hex'), passphrase);
const list = value => (value ?? '').split(',').filter(Boolean);
const walletKey = loadKey(join(directory, 'wallet.key'), () => Wallet.createRandom().privateKey, passphrase);
const apiKey = loadKey(join(directory, 'api.key'), () => Buffer.from(generateSecretKey()).toString('hex'), passphrase);
const payments = new Payments(walletKey, {
  rpc: process.env.LLMESH_RPC, chainId: Number(process.env.LLMESH_CHAIN_ID ?? 84532), token: process.env.LLMESH_TOKEN, escrow: process.env.LLMESH_ESCROW });
await payments.startConnection();
const service = new Service({ directory, secret: Buffer.from(identity, 'hex'),
  payments, apiKey: apiKey,
  topic: process.env.LLMESH_TOPIC, allowedWorkers: list(process.env.LLMESH_WORKERS), trustedCoordinators: list(process.env.LLMESH_COORDINATORS) });
const api = await startApi(service, { port: Number(process.env.LLMESH_PORT ?? 7337) });
service.on('progress', item => console.log(JSON.stringify(item)));
await service.initialize();
console.log(JSON.stringify(service.status(), null, 2));
service.startContributionManagement(levelIndex >= 0 ? process.argv[levelIndex + 1] : service.contributionLevel);
let closing = false;
async function close() { if (closing) return; closing = true; api.closeAllConnections(); await new Promise(r => api.close(r)); await service.close(); }
process.on('SIGINT', () => close().then(() => process.exit(0)));
process.on('SIGTERM', () => close().then(() => process.exit(0)));
