import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Service } from '../src/service.js';
import { generateSecretKey } from '../src/identity.js';
import { startApi } from '../src/api.js';
import { DatabaseSync } from 'node:sqlite';
import { SettlementQueue } from '../src/settlement.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-settle-'));
  let attempts = 0, refunds = 0;
  const payments = { wallet: { address: '0x' + '1'.repeat(40) }, state: { configured: true, chainId: 31337 }, settings: { escrow: '0x' + '2'.repeat(40) },
    status() { return this.state; }, async begin() { return { id: '0x' + 'a'.repeat(64), worker: this.wallet.address, chainId: 31337, escrow: this.settings.escrow }; },
    async settle() { if (++attempts === 1) throw new Error('RPC timeout'); return '0xsettled'; }, async refund() { refunds++; }, close() {} };
  const service = new Service({ directory, secret: generateSecretKey(), network: false, payments, ollama: { close() {} } });
  const worker = 'b'.repeat(64);
  service.mesh = { workers: () => [{ pubkey: worker, models: ['qwen3.5:0.8b'], wallet: payments.wallet.address, chainId: 31337, escrow: payments.settings.escrow, busy: 0, seen: Date.now() }],
    async execute(_job, delta) { delta('Delivered answer'); return { worker, tokens: 2 }; }, async close() {} };
  return { service, payments, directory, get attempts() { return attempts; }, get refunds() { return refunds; },
    async close() { await service.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const job = { model: 'llmesh-auto', messages: [{ role: 'user', content: 'Hello' }], maxTokens: 32 };
test('delivered requests return immediately, never refund settlement failures, and retry durably', async () => {
  const f = await fixture();
  try {
    const receipt = await f.service.chat(f.service.pubkey, job, () => {});
    assert.equal(receipt.settlement, 'settle-pending');
    await pause(30);
    assert.equal(f.refunds, 0);
    assert.equal(f.service.receipt(receipt.id, f.service.pubkey).settlement, 'settle-pending');
    assert.equal(f.service.ledger.db.prepare('SELECT state FROM onchain_jobs WHERE id=?').get(receipt.id).state, 'settle-pending');
    await f.service.settlements.retryNow(receipt.id);
    assert.equal(f.attempts, 2); assert.equal(f.refunds, 0);
    assert.equal(f.service.receipt(receipt.id, f.service.pubkey).settlement, 'settled');
    assert.equal(f.service.receipt(receipt.id, 'c'.repeat(64)), null);
  } finally { await f.close(); }
});
test('paid SSE ends promptly after generation even while settlement is unresolved', async () => {
  const f = await fixture(); let release;
  f.payments.settle = () => new Promise(resolve => { release = resolve; });
  const api = await startApi(f.service, { port: 0 });
  try {
    const started = performance.now();
    const response = await fetch(f.service.apiUrl + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + f.service.apiKey }, body: JSON.stringify({ ...job, max_tokens: 32, stream: true }) });
    const text = await Promise.race([response.text(), pause(1500).then(() => { throw new Error('SSE waited for settlement'); })]);
    assert.match(text, /\[DONE\]/); assert.ok(performance.now() - started < 500);
    release('0xsettled'); await pause(20);
    const receipt = await (await fetch(f.service.apiUrl + '/v1/receipts/0x' + 'a'.repeat(64), { headers: { Authorization: 'Bearer ' + f.service.apiKey } })).json();
    assert.equal(receipt.settlement, 'settled');
  } finally { release?.('0xsettled'); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await f.close(); }
});
test('cancellation after worker done does not refund delivered work', async () => {
  const f = await fixture(), controller = new AbortController();
  f.service.mesh.execute = async (_job, delta) => { delta('Complete'); controller.abort(); return { worker: 'b'.repeat(64), tokens: 1 }; };
  try {
    const receipt = await f.service.chat(f.service.pubkey, job, () => {}, controller.signal);
    assert.equal(receipt.settlement, 'settle-pending'); await pause(20); assert.equal(f.refunds, 0);
  } finally { await f.close(); }
});
test('settlement retries survive process restart without refunding or losing receipts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-settle-restart-')), path = join(directory, 'jobs.sqlite');
  const payment = { id: 'job', chainId: 31337, escrow: '0x' + '2'.repeat(40) };
  const payments = { state: { configured: true, chainId: 31337 }, settings: { escrow: payment.escrow }, settle: async () => { throw new Error('RPC down'); } };
  let db = new DatabaseSync(path), queue = new SettlementQueue(db, payments);
  try {
    queue.save({ id: 'job', settlement: 'settle-pending' }, 'payer'); queue.enqueue(payment); await pause(20);
    queue.close(); db.close();
    db = new DatabaseSync(path); payments.settle = async () => '0xrecovered'; queue = new SettlementQueue(db, payments);
    await queue.retryNow('job');
    assert.equal(queue.receipt('job', 'payer').transaction, '0xrecovered');
    assert.equal(queue.receipt('job', 'payer').settlement, 'settled');
  } finally { queue.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
