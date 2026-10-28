import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Mesh } from '../src/mesh.js';
import { generateSecretKey, getPublicKey } from '../src/identity.js';
import { finalizeEvent } from 'nostr-tools/pure';
class Swarm extends EventEmitter { join() { return {}; } async destroy() {} }
class Socket extends EventEmitter {
  constructor() { super(); this.publicKey = Buffer.alloc(32, 1); this.remotePublicKey = Buffer.alloc(32, 2); this.handshakeHash = Buffer.alloc(32, 3); this.sent = []; }
  setEncoding() {} write(text) { this.sent.push(JSON.parse(text)); return true; }
  destroy() { this.destroyed = true; this.emit('close'); }
}
test('busy and duplicate jobs return retryable errors without killing in-flight work', async () => {
  const key = getPublicKey(generateSecretKey()); const releases = []; const frames = [];
  const mesh = new Mesh({ secret: generateSecretKey(), swarm: new Swarm(), trustedCoordinators: [key],
    describe: () => ({ models: [], busy: 0, acceptFrom: [key] }),
    run: async function* () { await new Promise(resolve => releases.push(resolve)); yield { type: 'done', tokens: 1 }; } });
  mesh.send = async (_peer, frame) => frames.push(frame);
  const peer = { pubkey: key }, pending = [];
  try {
    for (let i = 0; i < 4; i++) pending.push(mesh.handle(peer, { type: 'job', id: String(i), job: {} }));
    await mesh.handle(peer, { type: 'job', id: 'fifth', job: {} });
    await mesh.handle(peer, { type: 'job', id: '0', job: {} });
    assert.equal(mesh.active.size, 4); assert.equal(frames.filter(frame => frame.retryable).length, 2);
    releases.forEach(resolve => resolve()); await Promise.all(pending);
    assert.equal(frames.filter(frame => frame.type === 'done').length, 4);
  } finally { releases.forEach(resolve => resolve()); await Promise.allSettled(pending); await mesh.close(); }
});
test('minimal hello withholds wallet and trust list, rejects strangers and times out silent peers', async () => {
  const allowed = generateSecretKey(); const wallet = '0x' + '1'.repeat(40);
  const mesh = new Mesh({ secret: generateSecretKey(), swarm: new Swarm(), allowedWorkers: [getPublicKey(allowed)], handshakeTimeoutMs: 20,
    describe: () => ({ models: [], busy: 0, wallet, acceptFrom: ['secret'] }), run: async function* () {} });
  const socket = new Socket(); mesh.connect(socket); mesh.announce([...mesh.peers.values()][0]);
  try {
    const content = JSON.parse(socket.sent[0].event.content);
    assert.equal(content.v, 3); assert.equal(content.wallet, undefined); assert.equal(content.acceptFrom, undefined);
    await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(socket.destroyed, true);
    const other = new Socket(); mesh.connect(other);
    const event = finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify({ v: 2, phase: 'identity', connection: other.remotePublicKey.toString('hex'), handshake: other.handshakeHash.toString('hex') }) }, generateSecretKey());
    await assert.rejects(mesh.handle([...mesh.peers.values()][0], { type: 'hello', event }), /Untrusted/);
    other.destroy();
  } finally { socket.destroy(); await mesh.close(); }
});
test('signed hello rejects replay, wrong handshake and unsupported protocol; reconnect replaces old socket', async () => {
  const secret = generateSecretKey(), key = getPublicKey(secret);
  const mesh = new Mesh({ secret: generateSecretKey(), swarm: new Swarm(), allowedWorkers: [key],
    describe: () => ({ models: [], busy: 0 }), run: async function* () {} });
  const signed = (socket, extra = {}, created = Math.floor(Date.now() / 1000)) => ({ type: 'hello', event: finalizeEvent({ kind: 30078, created_at: created, tags: [], content: JSON.stringify({
    v: 2, phase: 'identity', connection: socket.remotePublicKey.toString('hex'), handshake: socket.handshakeHash.toString('hex'), ...extra
  }) }, secret) });
  try {
    for (const [extra, created, pattern] of [[{}, Math.floor(Date.now() / 1000) - 120, /advertisement/], [{ handshake: 'wrong' }, undefined, /handshake/], [{ v: 99 }, undefined, /protocol/]]) {
      const socket = new Socket(); mesh.connect(socket); const peer = [...mesh.peers.values()][0];
      await assert.rejects(mesh.handle(peer, signed(socket, extra, created)), pattern); socket.destroy();
    }
    const first = new Socket(); mesh.connect(first); await mesh.handle([...mesh.peers.values()][0], signed(first));
    const second = new Socket(); mesh.connect(second); await mesh.handle([...mesh.peers.values()][0], signed(second));
    assert.equal(first.destroyed, true); assert.equal(mesh.byIdentity.get(key).socket, second);
    await assert.rejects(mesh.handle(mesh.byIdentity.get(key), { type: 'unknown' }), /Malformed/);
    second.emit('data', 'x'.repeat(1024 * 1024 + 1)); assert.equal(second.destroyed, true);
  } finally { await mesh.close(); }
});
