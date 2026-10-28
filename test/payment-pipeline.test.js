import test from 'node:test';
import assert from 'node:assert/strict';
import { Payments } from '../src/payments.js';
import { Wallet, MaxUint256 } from 'ethers';

test('funding pipelines lock confirmations and approves only once across concurrent requests', async () => {
  const payments = new Payments(Wallet.createRandom().privateKey, { escrow: '0x' + '2'.repeat(40) });
  payments.state = { configured: true, isCoordinator: true, chainId: 31337 };
  let approvals = 0, submitted = 0, allowance = 0n, nonce = 0; const releases = [];
  payments.provider = { getTransactionCount: async () => 0, destroy() {} };
  payments.token = { allowance: async () => allowance, approve: async (_address, amount, overrides) => {
    assert.equal(overrides.nonce, nonce++); approvals++; allowance = amount;
    return { wait: async () => ({ hash: 'approve' }) };
  } };
  payments.escrow = { lock: async (_id, _nostr, _worker, _level, overrides) => {
    assert.equal(overrides.nonce, nonce++); submitted++;
    return { hash: 'lock', wait: () => new Promise(resolve => releases.push(resolve)) };
  } };
  payments.verify = async () => {};
  const tasks = Array.from({ length: 5 }, () => payments.begin('a'.repeat(64), payments.wallet.address, null, 'a'.repeat(64)));
  for (let i = 0; i < 50 && submitted < 5; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(submitted, 5, 'All locks must be broadcast before any confirmation resolves');
  assert.equal(approvals, 1); assert.equal(allowance, MaxUint256);
  releases.forEach(resolve => resolve({})); await Promise.all(tasks); payments.close();
});
test('settlement is idempotent when a previous confirmation timed out but mined', async () => {
  const payments = new Payments(Wallet.createRandom().privateKey);
  payments.escrow = { jobs: async () => ({ state: 2n }), settle: async () => { throw new Error('Must not resend'); } };
  payments.history = () => [{ id: 'job', settlement_tx: '0xmined' }];
  payments.provider = { getTransactionReceipt: async () => ({ status: 1, hash: '0xmined' }) };
  assert.equal(await payments.settle({ id: 'job' }), '0xmined');
});
