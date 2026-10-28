import test from 'node:test';
import assert from 'node:assert/strict';
import { Service } from '../src/service.js';
import { Payments } from '../src/payments.js';
import { generateSecretKey } from '../src/identity.js';
import { Wallet } from 'ethers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('invalid contribution level becomes a visible setup error without a rejected background promise', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-start-'));
  const service = new Service({ directory, secret: generateSecretKey(), network: false, ollama: { close() {} } });
  try {
    service.startContributionManagement('bogus');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(service.setup.state, 'error'); assert.match(service.setup.message, /low, medium, or high/);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('payment startup survives RPC failure and retries', async () => {
  const payments = new Payments(Wallet.createRandom().privateKey); let attempts = 0;
  payments.connect = async () => { if (++attempts === 1) throw new Error('RPC unavailable'); payments.state.configured = true; };
  await payments.startConnection(10);
  assert.match(payments.state.error, /RPC unavailable/);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(attempts, 2); assert.equal(payments.state.configured, true); payments.close();
});
