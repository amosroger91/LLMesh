import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import SecretStream from '@hyperswarm/secret-stream';
import { Mesh } from '../src/mesh.js';
import { generateSecretKey, getPublicKey } from '../src/identity.js';

class TestSwarm extends EventEmitter {
  join() { return {}; }
  async destroy() {}
}
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
test('encrypted peers authenticate, stream jobs, reject untrusted coordinators and handle disconnects', { timeout: 10000 }, async () => {
  const coordinatorSecret = generateSecretKey(), workerSecret = generateSecretKey();
  const coordinatorKey = getPublicKey(coordinatorSecret), workerKey = getPublicKey(workerSecret);
  let trusted = [coordinatorKey], hang = false, useTool = false;
  const coordinator = new Mesh({ secret: coordinatorSecret, swarm: new TestSwarm(), allowedWorkers: [workerKey],
    describe: () => ({ models: [], busy: 0, acceptFrom: [] }), run: async function* () {} });
  const worker = new Mesh({ secret: workerSecret, swarm: new TestSwarm(), trustedCoordinators: trusted,
    describe: () => ({ models: ['qwen3.5:0.8b'], busy: 0, acceptFrom: trusted }),
    run: async function* (_job, signal) {
      if (useTool) {
        yield { type: 'tool_calls', calls: [{ index: 0, id: 'call_test', type: 'function', function: { name: 'read_file', arguments: '{}' } }] };
        yield { type: 'done', tokens: 2, finishReason: 'tool_calls' }; return;
      }
      yield { type: 'delta', text: 'from peer' };
      if (hang) { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw new Error('aborted'); }
      yield { type: 'done', tokens: 2 };
    } });
  const a = new SecretStream(true), b = new SecretStream(false);
  const opened = Promise.all([once(a, 'open'), once(b, 'open')]);
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream);
  try {
    await opened; coordinator.connect(a); worker.connect(b);
    for (let i = 0; i < 100 && !coordinator.workers().length; i++) await pause();
    assert.equal(coordinator.workers()[0].pubkey, workerKey);
    const job = { model: 'qwen3.5:0.8b', messages: [{ role: 'user', content: 'hi' }], maxTokens: 12 };
    let text = ''; const result = await coordinator.execute(job, delta => { text += delta; }, AbortSignal.timeout(3000));
    assert.equal(text, 'from peer'); assert.equal(result.worker, workerKey);
    useTool = true; const chunks = [];
    const toolResult = await coordinator.execute(job, chunk => chunks.push(chunk), AbortSignal.timeout(3000));
    assert.equal(toolResult.finishReason, 'tool_calls'); assert.equal(chunks[0].calls[0].function.name, 'read_file');
    useTool = false;
    trusted = []; worker.trustedCoordinators = trusted;
    await assert.rejects(coordinator.execute(job, () => {}, AbortSignal.timeout(3000)), /not trusted/);
    trusted = [coordinatorKey]; worker.trustedCoordinators = trusted; hang = true;
    const pending = coordinator.execute(job, () => {}, AbortSignal.timeout(3000));
    await pause(); b.destroy();
    await assert.rejects(pending, /disconnected/);
  } finally { a.destroy(); b.destroy(); await coordinator.close(); await worker.close(); }
});
