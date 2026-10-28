import test from 'node:test';
import assert from 'node:assert/strict';
import { assessComplexity, planRoute } from '../src/router.js';
import { quoteWork } from '../src/pricing.js';
import { validateJob } from '../src/service.js';
const small = 'qwen3.5:0.8b', medium = 'qwen3.5:4b', large = 'qwen3.8:27b';
const message = content => [{ role: 'user', content }];
const node = (pubkey, models, firstTokenMs = 100) => ({ pubkey, models, busy: 0, seen: Date.now(), latencyMs: 1,
  metrics: Object.fromEntries(models.map(model => [model, { firstTokenMs, tokensPerSecond: 30 }])) });
test('complexity assessment distinguishes short tasks, programming and multi-step design', () => {
  assert.equal(assessComplexity(message('Hello')).level, 'simple');
  assert.equal(assessComplexity(message('Write a JavaScript function to sort records')).level, 'standard');
  assert.equal(assessComplexity(message('implement and optimize a sort function')).level, 'standard');
  assert.equal(assessComplexity(message('Implement a distributed architecture and analyze its security trade-offs')).level, 'complex');
  assert.equal(assessComplexity(message('Hello'), 'complex').source, 'user');
});
test('automatic routing sends complex requests to capable nodes even if a small model is faster', () => {
  const workers = [node('tiny', [small], 1), node('balanced', [medium], 5), node('big', [large], 100)];
  const complex = planRoute({ model: 'llmesh-auto', messages: message('Prove this theorem rigorously'), maxTokens: 512 }, workers);
  assert.equal(complex.worker, 'big'); assert.equal(complex.model, large);
  const basic = planRoute({ model: 'llmesh-auto', messages: message('Hello'), maxTokens: 50 }, workers);
  assert.equal(basic.worker, 'tiny');
});
test('routing falls back by default, flags the result, and supports strict capability', () => {
  const job = { model: 'llmesh-auto', messages: message('Prove this theorem'), maxTokens: 512 };
  const route = planRoute(validateJob(job), [node('tiny', [small]), node('mid', [medium])]);
  assert.equal(route.model, medium); assert.equal(route.degraded, true);
  assert.match(route.reason, /below the recommended/);
  assert.throws(() => planRoute(validateJob({ ...job, allow_degraded: false }), [node('tiny', [small])]), /No idle trusted node meets complex/);
  assert.throws(() => planRoute(job, []), /No idle trusted node/);
  assert.equal(planRoute({ ...job, model: small }, [node('tiny', [small])]).degraded, true);
});
test('routing uses per-model measurements, excludes busy/stale/memory-incompatible nodes, and ignores contribution for pricing', () => {
  const cold = node('cold', [medium], 2000), warm = { ...node('warm', [medium], 20), contribution: 'high' };
  const busy = { ...node('busy', [medium], 1), busy: 1 }, stale = { ...node('stale', [medium], 1), seen: 0 };
  const unsafe = { ...node('unsafe', [medium], 1), hardware: { maxModelRank: 1 } };
  const route = planRoute({ model: 'llmesh-auto', messages: message('Write a function for filtering records'), maxTokens: 512 }, [cold, warm, busy, stale, unsafe]);
  assert.equal(route.worker, 'warm'); assert.equal(route.priceUnits, 2); assert.match(route.estimate.basis, /observed/);
});

test('price-aware routing chooses cheaper near-ties but still rewards substantial speed gains', () => {
  const job = { messages: message('Hello'), maxTokens: 512 };
  const cheap = { ...node('cheap', [small], 200), contribution: 'high' };
  const costly = { ...node('costly', [medium], 100), contribution: 'low' };
  assert.equal(planRoute(job, [cheap, costly]).worker, 'cheap');
  cheap.metrics[small].firstTokenMs = 1000;
  assert.equal(planRoute(job, [cheap, costly]).worker, 'costly');
  const tinyHigh = planRoute(job, [{ ...node('high', [small]), contribution: 'high' }]);
  assert.equal(tinyHigh.priceUnits, 1);
  assert.equal(planRoute(job, [{ ...node('low', ['qwen3.5:9b']), contribution: 'low' }]).priceUnits, 2);
});

test('fixed quotes reflect model size and bounded request work, not wording or labels', () => {
  const model = { parametersB: 0.8 };
  assert.equal(quoteWork(model, message('Hello'), 512).priceUnits, 1);
  assert.equal(quoteWork(model, message('Hello'), 2048).priceUnits, 2);
  assert.equal(quoteWork(model, message('x'.repeat(6001)), 2048).priceUnits, 3);
  assert.equal(quoteWork({ parametersB: 27 }, message('Hello'), 12).priceUnits, 3);
  assert.throws(() => quoteWork({}, [], 512), /unknown model/);
});
