import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import SecretStream from '@hyperswarm/secret-stream';
import { Service } from '../src/core/service.js';
import { Mesh } from '../src/core/mesh.js';
import { CreditReceipts } from '../src/core/credit-receipts.js';
import { catalog } from '../src/core/catalog.js';
import { creditAtomsPerToken, STARTER_CREDITS, CREDIT_SCALE } from '../src/core/pricing.js';
import { generateSecretKey, getPublicKey } from '../src/core/identity.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 10));
const grant = STARTER_CREDITS * CREDIT_SCALE;
class TestSwarm extends EventEmitter { join() { return {}; } async destroy() {} }
const rate = id => creditAtomsPerToken(catalog.models.find(model => model.id === id));
const atomsFor = (id, prompt, output) => (prompt + output) * rate(id);
const runtime = (text = 'hello') => ({ close() {}, async *chat() { yield { type: 'delta', text }; yield { type: 'done', promptTokens: 2, tokens: 3 }; } });

function openService(directory, secret, text) {
  const service = new Service({ desktop: true, directory, secret, network: false, ollama: runtime(text) });
  service.drainTimeoutMs = 0;
  return service;
}
async function link(leftMesh, rightMesh) {
  const initiator = new SecretStream(true), responder = new SecretStream(false);
  const opened = Promise.all([once(initiator, 'connect'), once(responder, 'connect')]);
  initiator.rawStream.pipe(responder.rawStream).pipe(initiator.rawStream);
  await opened;
  leftMesh.connect(initiator);
  rightMesh.connect(responder);
  return { initiator, responder };
}
async function until(check) { for (let i = 0; i < 100 && !check(); i++) await pause(); assert.equal(check(), true); }

test('a token claim without output is refused and the peer stays usable', { timeout: 10000 }, async () => {
  const coordinatorSecret = generateSecretKey(), workerSecret = generateSecretKey();
  const workerKey = getPublicKey(workerSecret);
  let mode = 'empty';
  const coordinator = new Mesh({ secret: coordinatorSecret, swarm: new TestSwarm(), allowedWorkers: [workerKey], describe: () => ({ models: [], busy: 0, settlementMode: 'credits' }), run: async function* () {} });
  const worker = new Mesh({ secret: workerSecret, swarm: new TestSwarm(), trustedCoordinators: [getPublicKey(coordinatorSecret)], describe: () => ({ models: ['qwen3.5:0.8b'], busy: 0, settlementMode: 'credits' }),
    run: async function* (job) {
      if (mode === 'empty') { yield { type: 'done', promptTokens: 2, tokens: 3 }; return; }
      if (mode === 'blank') { yield { type: 'delta', text: ' \n' }; yield { type: 'done', promptTokens: 2, tokens: 3 }; return; }
      if (mode === 'context') { yield { type: 'done', promptTokens: (job.contextTokens ?? 0) + 1, tokens: 0 }; return; }
      if (mode === 'tools') {
        yield { type: 'tool_calls', calls: [{ index: 0, id: 'call_test', type: 'function', function: { name: 'read_file', arguments: '{}' } }] };
        yield { type: 'done', promptTokens: 2, tokens: 2, finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'delta', text: 'from peer' };
      yield { type: 'done', promptTokens: 2, tokens: 2 };
    } });
  const streams = await link(coordinator, worker);
  const job = { model: 'qwen3.5:0.8b', messages: [{ role: 'user', content: 'hi' }], maxTokens: 12, contextTokens: 4096 };
  try {
    await until(() => coordinator.workers().length === 1);
    await assert.rejects(coordinator.execute(job, () => {}, AbortSignal.timeout(3000)), /without returning output/);
    assert.equal(coordinator.workers()[0].pubkey, workerKey);
    mode = 'blank';
    await assert.rejects(coordinator.execute(job, () => {}, AbortSignal.timeout(3000)), /without returning output/);
    mode = 'context';
    await assert.rejects(coordinator.execute(job, () => {}, AbortSignal.timeout(3000)), /reserved context/);
    mode = 'over';
    await assert.rejects(coordinator.execute({ ...job, maxTokens: 1 }, () => {}, AbortSignal.timeout(3000)), /Invalid worker token usage/);
    mode = 'tools';
    const calls = [];
    const tool = await coordinator.execute(job, chunk => calls.push(chunk), AbortSignal.timeout(3000));
    assert.equal(tool.finishReason, 'tool_calls');
    assert.equal(calls[0].calls[0].function.name, 'read_file');
    mode = 'text';
    let text = '';
    const done = await coordinator.execute(job, delta => { text += delta; }, AbortSignal.timeout(3000));
    assert.equal(text, 'from peer');
    assert.equal(done.worker, workerKey);
    assert.equal(coordinator.workers().length, 1);
  } finally { streams.initiator.destroy(); streams.responder.destroy(); await coordinator.close(); await worker.close(); }
});

test('three credit nodes pay one worker, then route the next model after disconnect', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-chain-'));
  const consumerSecret = generateSecretKey(), aSecret = generateSecretKey(), bSecret = generateSecretKey();
  const consumerKey = getPublicKey(consumerSecret), aKey = getPublicKey(aSecret), bKey = getPublicKey(bSecret);
  const consumer = openService(join(directory, 'c'), consumerSecret);
  const nodeA = openService(join(directory, 'a'), aSecret, 'from-a');
  const nodeB = openService(join(directory, 'b'), bSecret, 'from-b');
  nodeA.ready = ['qwen3.5:0.8b'];
  nodeB.ready = ['qwen3.5:4b'];
  consumer.mesh = new Mesh({ secret: consumerSecret, swarm: new TestSwarm(), allowedWorkers: [aKey, bKey], describe: () => ({ models: [], busy: 0, settlementMode: 'credits' }), onCreditAck: (key, id) => consumer.credits.acknowledge(key, id), run: async function* () {} });
  const serve = (service, secret) => { service.mesh = new Mesh({ secret, swarm: new TestSwarm(), trustedCoordinators: [consumerKey], describe: () => ({ models: service.ready, busy: 0, settlementMode: 'credits' }), onCredits: (issuer, event) => service.credits.receive(issuer, event),
    run: async function* (job, signal, peer) { for await (const part of service.runLocal(job, signal)) { if (part.type === 'done' && job.creditJobId) service.credits.expect(peer.pubkey, job.creditJobId, job.model, part, atomsFor(job.model, part.promptTokens, part.tokens)); yield part; } } }); };
  serve(nodeA, aSecret); serve(nodeB, bSecret);
  const linkA = await link(consumer.mesh, nodeA.mesh), linkB = await link(consumer.mesh, nodeB.mesh);
  const small = atomsFor('qwen3.5:0.8b', 2, 3), medium = atomsFor('qwen3.5:4b', 2, 3);
  const balances = () => consumer.ledger.db.prepare('SELECT balance, redeemable, earned_total FROM accounts').all();
  const sum = column => balances().reduce((total, row) => total + row[column], 0);
  try {
    await until(() => consumer.mesh.workers().length === 2);
    assert.deepEqual(consumer.mesh.workers().map(worker => worker.models[0]).sort(), ['qwen3.5:0.8b', 'qwen3.5:4b']);
    let text = '';
    const first = await consumer.chat(consumerKey, { model: 'qwen3.5:0.8b', messages: [{ role: 'user', content: 'hello' }], maxTokens: 16 }, delta => { if (typeof delta === 'string') text += delta; });
    assert.equal(text, 'from-a');
    assert.equal(first.worker, aKey);
    assert.equal(first.credits * CREDIT_SCALE, small);
    assert.equal(consumer.ledger.account(consumerKey).balance, grant - small);
    assert.equal(consumer.ledger.account(consumerKey).redeemable, 0);
    assert.equal(consumer.ledger.account(aKey).balance, small);
    assert.equal(consumer.ledger.account(aKey).redeemable, 0);
    assert.equal(consumer.ledger.account(aKey).earned_total, small);
    assert.equal(consumer.ledger.settle(first.id, aKey, small), false);
    assert.equal(nodeA.ledger.account(aKey).balance, grant);
    assert.equal(sum('balance'), grant);
    assert.equal(sum('redeemable'), 0);
    await until(() => nodeA.credits.summary().length === 1);
    assert.equal(nodeA.credits.summary()[0].earned, small);
    linkA.initiator.destroy(); linkA.responder.destroy();
    await until(() => consumer.mesh.workers().every(worker => worker.pubkey !== aKey));
    const before = consumer.ledger.account(consumerKey).balance;
    await assert.rejects(consumer.chat(consumerKey, { model: 'qwen3.5:0.8b', messages: [{ role: 'user', content: 'hello' }], maxTokens: 16 }, () => {}), /No idle trusted node|No inference worker/);
    assert.equal(consumer.ledger.account(consumerKey).balance, before);
    text = '';
    const second = await consumer.chat(consumerKey, { model: 'qwen3.5:4b', messages: [{ role: 'user', content: 'hello' }], maxTokens: 16 }, delta => { if (typeof delta === 'string') text += delta; });
    assert.equal(text, 'from-b');
    assert.equal(second.worker, bKey);
    assert.equal(consumer.ledger.account(consumerKey).balance, grant - small - medium);
    assert.equal(consumer.ledger.account(bKey).balance, medium);
    assert.equal(consumer.ledger.account(bKey).redeemable, 0);
    assert.equal(consumer.ledger.account(bKey).earned_total, medium);
    assert.equal(sum('balance'), grant);
    assert.equal(sum('earned_total'), small + medium);
    assert.equal(consumer.ledger.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='settled'").get().n, 2);
    assert.throws(() => consumer.ledger.reserve(consumerKey, consumer.ledger.account(consumerKey).balance + 1), /available credits/);
    await until(() => nodeB.credits.summary().length === 1);
    assert.equal(nodeB.credits.summary()[0].earned, medium);
  } finally {
    linkB.initiator.destroy(); linkB.responder.destroy();
    await consumer.close(); await nodeA.close(); await nodeB.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an interrupted worker refunds the reservation and does not earn', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-interrupt-'));
  const consumerSecret = generateSecretKey(), workerSecret = generateSecretKey();
  const consumerKey = getPublicKey(consumerSecret), workerKey = getPublicKey(workerSecret);
  const consumer = openService(join(directory, 'c'), consumerSecret);
  const worker = new Service({ desktop: true, directory: join(directory, 'w'), secret: workerSecret, network: false, ollama: { close() {}, async *chat(_job, signal) { yield { type: 'delta', text: 'partial' }; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw new Error('aborted'); } } });
  worker.drainTimeoutMs = 0; consumer.drainTimeoutMs = 0; worker.ready = ['qwen3.5:0.8b'];
  consumer.mesh = new Mesh({ secret: consumerSecret, swarm: new TestSwarm(), allowedWorkers: [workerKey], describe: () => ({ models: [], busy: 0, settlementMode: 'credits' }), run: async function* () {} });
  worker.mesh = new Mesh({ secret: workerSecret, swarm: new TestSwarm(), trustedCoordinators: [consumerKey], describe: () => ({ models: worker.ready, busy: 0, settlementMode: 'credits' }), run: async function* (job, signal) { yield* worker.runLocal(job, signal); } });
  const streams = await link(consumer.mesh, worker.mesh);
  try {
    await until(() => consumer.mesh.workers().length === 1);
    const pending = consumer.chat(consumerKey, { model: 'qwen3.5:0.8b', messages: [{ role: 'user', content: 'hello' }], maxTokens: 16 }, () => {});
    await until(() => consumer.ledger.account(consumerKey).balance < grant);
    streams.responder.destroy();
    await assert.rejects(pending, /disconnected|aborted|Cancelled|Worker/);
    assert.equal(consumer.ledger.account(consumerKey).balance, grant);
    assert.equal(consumer.ledger.account(workerKey)?.earned_total ?? 0, 0);
    assert.equal(consumer.ledger.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='settled'").get().n, 0);
  } finally { streams.initiator.destroy(); await consumer.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('fabricated credit receipts are rejected', () => {
  const issuerSecret = generateSecretKey(), issuer = getPublicKey(issuerSecret), worker = getPublicKey(generateSecretKey());
  const sender = new CreditReceipts(new DatabaseSync(':memory:'), issuerSecret, issuer);
  const recipient = new CreditReceipts(new DatabaseSync(':memory:'), generateSecretKey(), worker);
  const id = '44444444-4444-4444-4444-444444444444';
  const usage = { promptTokens: 2, tokens: 3 };
  const event = sender.issue(worker, id, 'qwen3.5:0.8b', usage, 5, 5);
  assert.throws(() => recipient.receive(issuer, event), /completed work/);
  recipient.expect(issuer, id, 'qwen3.5:0.8b', usage, 5);
  assert.equal(recipient.receive(issuer, event), event.id);
  const forged = { ...event, content: JSON.stringify({ ...JSON.parse(event.content), atoms: 9 }) };
  assert.throws(() => recipient.receive(issuer, forged), /Invalid signed|Conflicting|completed work/);
  assert.throws(() => recipient.receive(worker, event), /Invalid signed/);
  assert.equal(recipient.summary()[0].earned, 5);
});
