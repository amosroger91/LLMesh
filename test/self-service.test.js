import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Service } from '../src/service.js';
import { generateSecretKey } from '../src/identity.js';

test('self-service debits then credits the same account without Base, and refunds failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-self-'));
  let service, fail = false, starts = 0;
  const ollama = { close() {}, async *chat() {
    starts++; assert.equal(service.ledger.account(service.pubkey).balance, 200000 - 4096 - 12);
    if (fail) throw new Error('generation failed');
    yield { type: 'delta', text: 'local response' }; yield { type: 'done', tokens: 2 };
  } };
  service = new Service({ directory, secret: generateSecretKey(), network: false, ollama });
  service.ready = ['qwen3.5:0.8b'];
  const job = { model: 'llmesh-auto', messages: [{ role: 'user', content: 'Hello' }], maxTokens: 12 };
  try {
    let text = '';
    const receipt = await service.chat(service.pubkey, job, delta => { text += delta; });
    assert.equal(text, 'local response'); assert.equal(receipt.credits, 1);
    assert.equal(receipt.route.settlement, 'local-self'); assert.equal(receipt.transaction, null);
    assert.equal(service.ledger.account(service.pubkey).balance, 200000);
    assert.equal(service.ledger.db.prepare('SELECT state FROM jobs WHERE id=?').get(receipt.id).state, 'settled');
    fail = true; await assert.rejects(service.chat(service.pubkey, job, () => {}), /generation failed/);
    assert.equal(service.ledger.account(service.pubkey).balance, 200000);
    const other = 'c'.repeat(64); service.ledger.register(other);
    await assert.rejects(service.chat(other, job, () => {}), /Configure Base/);
    assert.equal(starts, 2); assert.equal(service.ledger.account(other).balance, 200000);
    service.mesh = { workers: () => [{ pubkey: other, models: ['qwen3.5:0.8b'], busy: 0, seen: Date.now(), wallet: '0x' + '1'.repeat(40) }], async close() {} };
    await assert.rejects(service.chat(service.pubkey, { ...job, workerKey: other }, () => {}), /No idle trusted node/);
    assert.equal(starts, 2);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});
