import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcProvider, ContractFactory, parseEther, MaxUint256 } from 'ethers';
import { localChain } from '../scripts/local-chain.js';
import { compile } from '../scripts/compile-contracts.js';
import { Payments } from '../src/payments.js';
import { Service } from '../src/service.js';
import { generateSecretKey } from '../src/identity.js';
import { startApi } from '../src/api.js';

test('paid API funds ERC-20 escrow before dispatch, pays worker, refunds failures and supports JSON clients', { timeout: 60000 }, async () => {
  const chain = await localChain(); await new Promise(resolve => chain.server.listen(0, '127.0.0.1', resolve));
  const rpc = `http://127.0.0.1:${chain.server.address().port}`, provider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: 0 });
  let service, workerService, api, payments;
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-paid-'));
  try {
    const signer = chain.accounts[0].connect(provider), compiled = compile();
    const token = await new ContractFactory(compiled.LLMeshToken.abi, '0x' + compiled.LLMeshToken.evm.bytecode.object, signer).deploy(signer.address); await token.waitForDeployment();
    const escrow = await new ContractFactory(compiled.LLMeshEscrow.abi, '0x' + compiled.LLMeshEscrow.evm.bytecode.object, signer).deploy(await token.getAddress(), signer.address); await escrow.waitForDeployment();
    const config = { rpc, chainId: 31337, token: await token.getAddress(), escrow: await escrow.getAddress() };
    payments = new Payments(signer.privateKey, config); await payments.connect();
    service = new Service({ directory, secret: generateSecretKey(), payments, network: false, ollama: { installed: async () => [], close() {} } });
    await payments.register(service.pubkey); await payments.register(service.pubkey);
    assert.equal((await payments.refresh()).balance, '100000.0');
    const workerKey = 'b'.repeat(64), worker = chain.accounts[2].address; let fail = false, dispatched = 0, contribution = 'low';
    const workerPayments = new Payments(chain.accounts[2].privateKey, config); await workerPayments.connect();
    workerService = new Service({ directory: join(directory, 'worker'), secret: generateSecretKey(), payments: workerPayments, network: false, ollama: { close() {} } });
    service.mesh = {
      workers: () => [{ pubkey: workerKey, contribution, wallet: worker, chainId: 31337, escrow: config.escrow, models: ['qwen3.5:0.8b'], busy: 0, seen: Date.now(), latencyMs: 1 }],
      async execute(job, onDelta) {
        assert.equal(job.model, 'qwen3.5:0.8b');
        dispatched++; const locked = await escrow.jobs(job.payment.id);
        assert.equal(locked.state, 1n); assert.equal(locked.worker.toLowerCase(), worker.toLowerCase());
        assert.equal(locked.amount, parseEther(String(job.payment.priceUnits)) / 2n);
        if (job.maxTokens < 1024) await assert.rejects(workerService.acceptWorkerPayment({ ...job, maxTokens: 2048 }), /underpriced/);
        await workerService.acceptWorkerPayment(job);
        await assert.rejects(workerService.acceptWorkerPayment(job), /reused payment/);
        await assert.rejects(payments.verify(job.payment.id, service.pubkey, worker, 99), /underpriced/);
        if (fail) throw Object.assign(new Error('worker failed'), { refundAuthorization: await workerPayments.signRefund(job.payment) }); onDelta('paid response'); return { worker: workerKey, tokens: 2, promptTokens: 3 };
      }, async close() {}
    };
    api = await startApi(service, { port: 0 });
    async function request(extra = {}) { const response = await fetch(service.apiUrl + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + service.apiKey },
      body: JSON.stringify({ model: 'llmesh-auto', messages: [{ role: 'user', content: 'implement and optimize a sort function' }], max_tokens: 12, stream: false, ...extra }) });
      if (response.ok) { const body = await response.clone().json(); await service.settlements.retryNow(body.llmesh_receipt.id); }
      return response; }
    let response = await request(); const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.object, 'chat.completion');
    assert.equal(result.model, 'qwen3.5:0.8b'); assert.equal(result.llmesh_receipt.route.degraded, true); assert.equal(result.llmesh_receipt.route.automatic, true);
    assert.equal(result.choices[0].message.content, 'paid response'); assert.equal(result.llmesh_receipt.settlement, 'settle-pending'); assert.match(service.receipt(result.llmesh_receipt.id, service.pubkey).transaction, /^0x/);
    assert.equal(await token.balanceOf(worker), parseEther('2.5')); assert.equal((await payments.refresh()).balance, '99997.5');
    contribution = 'medium'; response = await request(); assert.equal(response.status, 200); assert.equal((await response.json()).llmesh_receipt.credits, 2.5);
    contribution = 'high'; response = await request(); assert.equal(response.status, 200); assert.equal((await response.json()).llmesh_receipt.credits, 2.5);
    assert.equal(await token.balanceOf(worker), parseEther('7.5')); assert.equal((await payments.refresh()).balance, '99992.5');
    response = await request({ allow_degraded: false }); assert.equal(response.status, 400); assert.equal(dispatched, 3);
    response = await request({ max_tokens: 2048 }); assert.equal(response.status, 200); assert.equal((await response.json()).llmesh_receipt.credits, 2.5);
    fail = true; response = await request(); assert.equal(response.status, 400); assert.equal((await payments.refresh()).balance, '99990.0');
    const models = await (await fetch(service.apiUrl + '/v1/models', { headers: { Authorization: 'Bearer ' + service.apiKey } })).json();
    assert.equal(models.object, 'list'); assert.ok(models.data.some(model => model.id === 'llmesh-auto')); assert.ok(models.data.some(model => model.id === 'qwen3.5:0.8b'));
    assert.equal(dispatched, 5);
    const fundingNonce = await provider.getTransactionCount(signer.address, 'latest');
    const funded = await Promise.all(Array.from({ length: 5 }, () => payments.begin(service.pubkey, worker, null, service.pubkey)));
    assert.equal(await provider.getTransactionCount(signer.address, 'latest'), fundingNonce + 5);
    assert.equal(await token.allowance(signer.address, config.escrow), MaxUint256);
    assert.equal(new Set(funded.map(payment => payment.id)).size, 5);
    await Promise.all(funded.map(payment => payments.settle({...payment,credits:1})));
    assert.equal((await payments.refresh()).balance, '99987.5');
    payments.state.configured = false; response = await request(); assert.equal(response.status, 400); assert.equal(dispatched, 5);
  } finally {
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
    if (service) await service.close(); else payments?.close();
    await workerService?.close();
    provider.destroy(); chain.server.closeAllConnections(); await new Promise(resolve => chain.server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
