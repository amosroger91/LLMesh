import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { generateSecretKey, getPublicKey, signAuth, authenticate } from '../src/identity.js';
import { recommend, parseNvidiaMemory } from '../src/hardware.js';
import { rankWorkers } from '../src/mesh.js';
import { Service } from '../src/service.js';
import { startApi } from '../src/api.js';
import { ndjson } from '../src/ollama.js';

const payer = 'a'.repeat(64), worker = 'b'.repeat(64);
test('NVIDIA driver memory is parsed independently of the general Windows hardware probe', () => {
  const devices = parseNvidiaMemory('0, NVIDIA GeForce RTX 3050, 6144, 2761\n');
  assert.equal(devices[0].name, 'NVIDIA GeForce RTX 3050'); assert.equal(devices[0].vramGB, 6);
  assert.equal(devices[0].freeGB, 2761 / 1024); assert.deepEqual(parseNvidiaMemory('driver unavailable'), []);
});
test('hardware: GPU tiers, CPU fallback, unified memory, no fit', () => {
  const hardware = { ramGB: 64, freeRamGB: 40, gpus: [{ vramGB: 24, freeGB: 23 }], unifiedMemory: false };
  assert.equal(recommend(hardware).model.id, 'qwen3.8:27b');
  assert.equal(recommend({ ...hardware, gpus: [{ vramGB: 24, freeGB: 6 }] }).model.id, 'qwen3.5:4b');
  assert.equal(recommend({ ...hardware, gpus: [] }).mode, 'cpu');
  assert.equal(recommend({ ...hardware, gpus: [], unifiedMemory: true }).model.id, 'qwen3.8:27b');
  assert.equal(recommend({ ...hardware, freeRamGB: 2, gpus: [] }).model, null);
});
test('ledger grants once, reserves atomically, settles once and refunds on restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-ledger-')); const path = join(directory, 'ledger.sqlite');
  let ledger = new Ledger(path, 2);
  try {
    ledger.register(payer); ledger.register(payer); assert.equal(ledger.account(payer).balance, 2);
    const first = ledger.reserve(payer); const second = ledger.reserve(payer);
    assert.throws(() => ledger.reserve(payer));
    assert.equal(ledger.settle(first, worker), true); assert.equal(ledger.settle(first, worker), false);
    assert.equal(ledger.account(worker).balance, 1);
    ledger.register(worker); ledger.register(worker); assert.equal(ledger.account(worker).balance, 3);
    ledger.close(); ledger = new Ledger(path, 2);
    assert.equal(ledger.account(payer).balance, 1); ledger.cancel(second); assert.equal(ledger.account(payer).balance, 1);
  } finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('NIP-98 binds signatures to method, URL, exact payload and rejects replays', () => {
  const secret = generateSecretKey(), url = 'http://127.0.0.1:7337/v1/accounts', body = '{}';
  const ledger = new Ledger(':memory:');
  try {
    const token = signAuth(secret, url, 'POST', body);
    assert.throws(() => authenticate(token, url, 'GET', body, ledger));
    assert.throws(() => authenticate(token, url + '?x', 'POST', body, ledger));
    assert.throws(() => authenticate(token, url, 'POST', '{"a":1}', ledger));
    assert.equal(authenticate(token, url, 'POST', body, ledger), getPublicKey(secret));
    assert.throws(() => authenticate(token, url, 'POST', body, ledger), /replay/);
  } finally { ledger.close(); }
});
test('scheduler excludes stale, busy and incompatible workers', () => {
  const base = { models: ['m'], seen: Date.now(), busy: 0 };
  const nodes = [{ ...base, pubkey: 'slow', latencyMs: 30 }, { ...base, pubkey: 'fast', latencyMs: 10 },
    { ...base, busy: 1 }, { ...base, models: ['other'] }, { ...base, seen: 0 }];
  assert.deepEqual(rankWorkers(nodes, 'm').map(n => n.pubkey), ['fast', 'slow']);
});
test('scheduler minimizes RTT plus observed time to first token', () => {
  const base = { models: ['m'], seen: Date.now(), busy: 0 };
  const nodes = [{ ...base, pubkey: 'near-but-cold', latencyMs: 2, firstTokenMs: 2000 },
    { ...base, pubkey: 'warm', latencyMs: 40, firstTokenMs: 50 },
    { ...base, pubkey: 'far', latencyMs: 400, firstTokenMs: 10 }];
  assert.deepEqual(rankWorkers(nodes, 'm').map(n => n.pubkey), ['warm', 'far', 'near-but-cold']);
});
test('NDJSON handles split unicode, split frames, and trailing frame', async () => {
  const bytes = Buffer.from('{"text":"🌎"}\n{"done":true}');
  async function* chunks() { for (const byte of bytes) yield Uint8Array.of(byte); }
  const result = []; for await (const item of ndjson(chunks())) result.push(item);
  assert.deepEqual(result, [{ text: '🌎' }, { done: true }]);
});
test('signed API streams inference, settles credits and refunds failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-api-')); const secret = generateSecretKey();
  let fail = false;
  const ollama = { installed: async () => ['qwen3.5:0.8b'], close() {},
    async *chat() { yield { type: 'delta', text: 'hello' }; if (fail) throw new Error('inference failed'); yield { type: 'done', tokens: 2, promptTokens: 3 }; } };
  const service = new Service({ directory, secret, network: false, ollama, requirePayments: false }); await service.refresh();
  const server = await startApi(service, { port: 0 });
  const client = generateSecretKey(), pubkey = getPublicKey(client);
  async function request(path, body, method = 'POST') {
    const raw = body == null ? '' : JSON.stringify(body), url = service.apiUrl + path;
    return fetch(url, { method, body: method === 'GET' ? undefined : raw, headers: { Authorization: signAuth(client, url, method, raw) } });
  }
  try {
    assert.equal((await request('/v1/accounts', {})).status, 200);
    assert.equal(service.ledger.account(pubkey).balance, 100000);
    const job = { model: 'qwen3.5:0.8b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 12, stream: true };
    let response = await request('/v1/chat/completions', job); let text = await response.text();
    assert.match(text, /hello/); assert.match(text, /\[DONE\]/); assert.equal(service.ledger.account(pubkey).balance, 99995);
    assert.equal(service.ledger.account(service.pubkey).balance, 100005);
    fail = true; response = await request('/v1/chat/completions', job); text = await response.text();
    assert.match(text, /inference failed/); assert.equal(service.ledger.account(pubkey).balance, 99995);
    response = await request('/v1/chat/completions', { ...job, max_tokens: -1 });
    assert.equal(response.status, 400); assert.equal(service.ledger.account(pubkey).balance, 99995);
    assert.equal((await fetch(service.apiUrl + '/v1/account')).status, 401);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await service.close(); rmSync(directory, { recursive: true, force: true }); }
});
