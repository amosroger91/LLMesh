// Example NIP-98 client. Set LLMESH_SECRET to a hex Nostr private key you control.
import { generateSecretKey, getPublicKey, signAuth } from '../src/identity.js';
const secret = process.env.LLMESH_SECRET ? Buffer.from(process.env.LLMESH_SECRET, 'hex') : generateSecretKey();
const base = process.env.LLMESH_API ?? 'http://127.0.0.1:7337';
async function post(path, value) {
  const body = JSON.stringify(value), url = base + path;
  const response = await fetch(url, { method: 'POST', headers: { Authorization: process.env.LLMESH_API_KEY ? 'Bearer ' + process.env.LLMESH_API_KEY : signAuth(secret, url, 'POST', body), 'Content-Type': 'application/json' }, body });
  if (!response.ok) throw new Error(await response.text());
  return response;
}
console.log('Account:', getPublicKey(secret));
if (process.env.LLMESH_ACCOUNT_WALLET) console.log('Grant voucher:', await (await post('/v1/accounts', { wallet: process.env.LLMESH_ACCOUNT_WALLET })).json());
const response = await post('/v1/chat/completions', { model: process.env.LLMESH_MODEL ?? 'qwen3.5:0.8b',
  messages: [{ role: 'user', content: process.argv.slice(2).join(' ') || 'Say hello in one sentence.' }], max_tokens: 256, stream: true,
  payment: process.env.LLMESH_PAYMENT_ID ? { id: process.env.LLMESH_PAYMENT_ID } : undefined, workerKey: process.env.LLMESH_WORKER });
for await (const chunk of response.body) process.stdout.write(Buffer.from(chunk));
