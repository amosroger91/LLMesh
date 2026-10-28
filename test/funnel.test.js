import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Service } from '../src/service.js';
import { startApi } from '../src/api.js';
import { generateSecretKey, getPublicKey, signAuth } from '../src/identity.js';
import { Mesh } from '../src/mesh.js';
import { loadConfig } from '../src/cli/config.js';
import { finalizeEvent } from 'nostr-tools/pure';
import { FunnelRelay } from '../src/core/funnel/relay.js';
import { FunnelTunnel } from '../src/core/funnel/tunnel.js';
import { createNodeFunnel } from '../src/core/funnel/index.js';
import { tailscalePublicUrl } from '../src/core/funnel/providers.js';
import { FUNNEL_PROTOCOL, funnelRequestPath, funnelRequestUrl, parseFunnelAdvertisement, splitPublicPath } from '../src/core/funnel/protocol.js';

const TOKEN = 'funnel-test-token';
const envFor = directory => ({ LLMESH_CONFIG: join(directory, 'missing.json'), APPDATA: directory, HOME: directory, XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, USERPROFILE: directory });

function listen(server) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
}

test('funnel paths stay inside the published prefix', () => {
  assert.equal(funnelRequestUrl('http://127.0.0.1:9/f/abc', '/v1/models?refresh=true'), 'http://127.0.0.1:9/f/abc/v1/models?refresh=true');
  assert.equal(splitPublicPath('/f/' + 'a'.repeat(43) + '/health?x=1').path, '/health?x=1');
  assert.equal(splitPublicPath('/health'), null);
  assert.throws(() => funnelRequestPath('/../admin'), /invalid/i);
  assert.throws(() => funnelRequestPath('/%2e%2e/admin'), /invalid/i);
  assert.throws(() => parseFunnelAdvertisement({ v: 1, provider: 'relay', url: 'http://203.0.113.8/node' }), /HTTPS/);
  assert.equal(parseFunnelAdvertisement(null), null);
  assert.throws(() => tailscalePublicUrl(JSON.stringify({ AllowFunnel: {}, Web: {} }), 7337), /public HTTPS URL/);
  assert.equal(tailscalePublicUrl(JSON.stringify({
    AllowFunnel: { 'node.tailnet.ts.net:443': true },
    Web: { 'node.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7337' } } } }
  }), 7337), 'https://node.tailnet.ts.net');
});

test('funnel config keeps a public relay closed until TLS and a token are set', () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-funnel-config-'));
  const env = envFor(directory);
  try {
    const off = loadConfig(['doctor', '--offline'], env);
    assert.equal(off.funnel, 'off');
    assert.throws(() => loadConfig(['funnel', 'relay', '--listen', '0.0.0.0:7443'], { ...env, LLMESH_FUNNEL_PUBLIC_BASE: 'https://funnel.example' }), /insecure-listen/);
    assert.throws(() => loadConfig(['funnel', 'relay', '--listen', '0.0.0.0:7443', '--insecure-listen'], { ...env, LLMESH_FUNNEL_PUBLIC_BASE: 'https://funnel.example' }), /token or a node allowlist/);
    const relay = loadConfig(['funnel', 'relay', '--listen', '0.0.0.0:7443', '--tls-cert', 'cert.pem', '--tls-key', 'key.pem'], { ...env, LLMESH_FUNNEL_PUBLIC_BASE: 'https://funnel.example', LLMESH_FUNNEL_TOKEN: TOKEN });
    assert.equal(relay.port, 7443);
    assert.equal(relay.funnelToken, TOKEN);
    assert.equal(relay.funnelOpen, false);
    const loopback = loadConfig(['funnel', 'relay', '--listen', '127.0.0.1:7443'], env);
    assert.equal(loopback.host, '127.0.0.1');
    assert.equal(loopback.funnelToken, null);
    assert.throws(() => loadConfig(['serve'], { ...env, LLMESH_FUNNEL: 'relay' }), /relay URL/);
    assert.throws(() => loadConfig(['serve', '--listen', '0.0.0.0:7337'], env), /insecure-listen/);
    assert.throws(() => loadConfig(['serve'], { ...env, LLMESH_FUNNEL: 'cloudflare', LLMESH_FUNNEL_PUBLIC_URL: 'https://node.example' }), /tunnel token/);
    const named = loadConfig(['serve'], { ...env, LLMESH_FUNNEL: 'cloudflare', LLMESH_FUNNEL_PUBLIC_URL: 'https://node.example', LLMESH_FUNNEL_CLOUDFLARE_TOKEN: 'cloudflare-tunnel-token' });
    assert.equal(named.funnelCloudflareToken, 'cloudflare-tunnel-token');
    assert.equal(named.funnelPublicUrl, 'https://node.example');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('relay funnel reaches loopback, keeps the API key, and accepts the public URL for NIP-98', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-funnel-'));
  const secret = generateSecretKey();
  const service = new Service({ directory, secret, network: false, ollama: { close() {} } });
  const api = await startApi(service, { port: 0 });
  const relay = new FunnelRelay({ token: TOKEN });
  await relay.listen(0, '127.0.0.1');
  const funnel = createNodeFunnel({ provider: 'relay', relay: relay.origin, token: TOKEN, secret, pubkey: service.pubkey, apiPort: api.address().port });
  service.funnel = funnel;
  try {
    assert.equal(service.status().funnel.provider, 'relay');
    await assert.rejects(new FunnelTunnel({ relay: relay.origin, secret, apiPort: api.address().port }).open(), /token/i);
    const status = await funnel.start();
    assert.equal(status.state, 'verified');
    assert.equal(status.hasToken, true);
    assert.equal(JSON.stringify(status).includes(TOKEN), false);
    const manifest = await fetch(funnelRequestUrl(status.publicUrl, '/.well-known/llmesh.json'));
    const described = await manifest.json();
    assert.equal(described.pubkey, service.pubkey);
    assert.equal(described.protocol, FUNNEL_PROTOCOL);
    assert.equal(described.apiKey, undefined);
    assert.equal(manifest.headers.get('cache-control'), 'no-store');
    const open = await fetch(status.publicUrl + '/openapi.json');
    assert.equal((await open.json()).servers.at(-1).url, status.publicUrl);
    const denied = await fetch(status.publicUrl + '/v1/models');
    assert.equal(denied.status, 401);
    const models = await fetch(status.publicUrl + '/v1/models', { headers: { authorization: 'Bearer ' + service.apiKey } });
    assert.equal(models.status, 200);
    const signedUrl = funnelRequestUrl(status.publicUrl, '/v1/models');
    const nip = await fetch(signedUrl, { headers: { authorization: signAuth(secret, signedUrl, 'GET', '') } });
    assert.equal(nip.status, 200);
    const forged = funnelRequestUrl(status.publicUrl, '/v1/models');
    const wrong = await fetch(forged, { headers: { authorization: signAuth(secret, 'https://evil.example/v1/models', 'GET', ''), 'x-llmesh-funnel-url': 'https://evil.example/v1/models' } });
    assert.equal(wrong.status, 401);
    assert.deepEqual(funnel.advertisement().funnel, { v: 1, provider: 'relay', url: status.publicUrl });
    funnel.stopped = true;
    const replacement = new FunnelTunnel({ relay: relay.origin, token: TOKEN, secret, apiPort: api.address().port });
    const replaced = await replacement.open();
    assert.notEqual(replaced.publicUrl, status.publicUrl);
    assert.equal((await fetch(status.publicUrl + '/health')).status, 503);
    await replacement.close();
  } finally {
    await funnel.stop();
    await relay.close();
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('relay streams responses and rejects escaped paths', async () => {
  const secret = generateSecretKey();
  const local = http.createServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write('data: one\n\n');
      setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 20);
      return;
    }
    res.writeHead(404); res.end();
  });
  const relay = new FunnelRelay({ token: TOKEN, allow: [getPublicKey(secret)] });
  await listen(local);
  await relay.listen(0, '127.0.0.1');
  const tunnel = new FunnelTunnel({ relay: relay.origin, token: TOKEN, secret, apiPort: local.address().port });
  try {
    const stranger = new FunnelTunnel({ relay: relay.origin, token: TOKEN, secret: generateSecretKey(), apiPort: local.address().port });
    await assert.rejects(stranger.open(), /not allowed/i);
    const opened = await tunnel.open();
    const response = await fetch(opened.publicUrl + '/stream');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data: one[\s\S]*data: two/);
    const session = opened.publicUrl.split('/').at(-1);
    const escaped = await new Promise((resolve, reject) => {
      const target = new URL(relay.origin);
      const req = http.request({ hostname: target.hostname, port: target.port, path: `/f/${session}/%2e%2e/secret`, method: 'GET' }, response => { response.resume(); resolve(response.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(escaped, 400);
    const replay = finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'llmesh-funnel-v1']], content: JSON.stringify({ v: 1, role: 'node', protocol: FUNNEL_PROTOCOL }) }, secret);
    const first = await fetch(relay.origin + '/v1/funnel/sessions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ v: 1, event: replay }) });
    assert.equal(first.status, 201);
    const second = await fetch(relay.origin + '/v1/funnel/sessions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ v: 1, event: replay }) });
    assert.equal(second.status, 401);
  } finally {
    await tunnel.close();
    await relay.close();
    await new Promise(resolve => local.close(resolve));
  }
});

test('process funnel providers publish a verified URL without inheriting the API key', async () => {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; setTimeout(() => child.emit('exit', 0), 0); };
    setTimeout(() => {
      if (file === 'cloudflared') child.stderr.emit('data', '2026-10-28 INF https://example-node.trycloudflare.com\n');
      if (file === 'tailscale' && args.includes('status')) child.stdout.emit('data', JSON.stringify({ AllowFunnel: { 'desktop.tailnet.ts.net:443': true }, Web: { 'desktop.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7337' } } } } }));
      if (file === 'tailscale') child.emit('exit', 0);
    }, 5);
    return child;
  };
  const fetchImpl = async () => ({ status: 200, json: async () => ({ v: 1, protocol: FUNNEL_PROTOCOL, pubkey }) });
  const tailscale = createNodeFunnel({ provider: 'tailscale', secret, pubkey, apiPort: 7337, spawn, fetch: fetchImpl });
  const cloudflare = createNodeFunnel({ provider: 'cloudflare', secret, pubkey, apiPort: 7337, spawn, fetch: fetchImpl });
  try {
    assert.equal((await tailscale.start()).publicUrl, 'https://desktop.tailnet.ts.net');
    assert.equal((await cloudflare.start()).state, 'verified');
    assert.equal(cloudflare.status().publicUrl, 'https://example-node.trycloudflare.com');
    assert.equal(cloudflare.status().ephemeral, true);
    assert.equal(JSON.stringify(cloudflare.status()).includes('apiKey'), false);
  } finally { await tailscale.stop(); await cloudflare.stop(); }
});

test('a named Cloudflare tunnel keeps its hostname and leaves the token out of the process arguments', async () => {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const token = 'cloudflare-tunnel-token';
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, token: options?.env?.TUNNEL_TOKEN });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    return child;
  };
  const fetchImpl = async () => ({ status: 200, json: async () => ({ v: 1, protocol: FUNNEL_PROTOCOL, pubkey }) });
  const funnel = createNodeFunnel({ provider: 'cloudflare', publicUrl: 'https://llm.example', cloudflareToken: token, secret, pubkey, apiPort: 7337, spawn, fetch: fetchImpl });
  try {
    const status = await funnel.start();
    assert.equal(status.publicUrl, 'https://llm.example');
    assert.equal(status.ephemeral, false);
    assert.equal(status.hasCloudflareToken, true);
    assert.equal(JSON.stringify(status).includes(token), false);
    assert.deepEqual(calls[0].args, ['tunnel', '--no-autoupdate', 'run']);
    assert.equal(calls[0].token, token);
  } finally { await funnel.stop(); }
});

test('a relay sheds a session flood and an idle session', async () => {
  const secret = generateSecretKey();
  const relay = new FunnelRelay({ token: TOKEN });
  await relay.listen(0, '127.0.0.1');
  try {
    const event = finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'llmesh-funnel-v1']], content: JSON.stringify({ v: 1, role: 'node', protocol: FUNNEL_PROTOCOL, nonce: 'ab'.repeat(16) }) }, secret);
    const created = await fetch(relay.origin + '/v1/funnel/sessions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ v: 1, event }) });
    assert.equal(created.status, 201);
    const { publicUrl } = await created.json();
    assert.equal((await fetch(publicUrl + '/health')).status, 503);
    const broken = await fetch(relay.origin + '/v1/funnel/sessions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: '{' });
    assert.equal(broken.status, 400);
    let limited = 0;
    for (let i = 0; i < 40; i += 1) {
      const response = await fetch(relay.origin + '/v1/funnel/sessions', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{}' });
      if (response.status === 429) limited += 1;
      await response.arrayBuffer();
    }
    assert.equal(limited > 0, true);
  } finally { await relay.close(); }
});

test('mesh capabilities carry a verified funnel and reject a public HTTP address', async () => {
  class Swarm extends EventEmitter { join() { return {}; } async destroy() {} }
  class Socket extends EventEmitter {
    constructor() { super(); this.publicKey = Buffer.alloc(32, 1); this.remotePublicKey = Buffer.alloc(32, 2); this.handshakeHash = Buffer.alloc(32, 3); this.sent = []; }
    setEncoding() {}
    write(text) { this.sent.push(JSON.parse(text)); return true; }
    destroy() { this.destroyed = true; this.emit('close'); }
  }
  const secret = generateSecretKey();
  const key = getPublicKey(secret);
  const url = 'https://node.example/llm';
  const mesh = new Mesh({ secret: generateSecretKey(), swarm: new Swarm(), allowedWorkers: [key], describe: () => ({ models: ['qwen3.5:0.8b'], busy: 0, funnel: { v: 1, provider: 'public', url } }), run: async function* () {} });
  const signed = (socket, funnel) => ({ type: 'hello', event: finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'llmesh-worker-v2']], content: JSON.stringify({
    v: 3, phase: 'capabilities', connection: socket.remotePublicKey.toString('hex'), handshake: socket.handshakeHash.toString('hex'), models: ['qwen3.5:0.8b'], busy: 0, funnel
  }) }, secret) });
  const bad = new Socket();
  const good = new Socket();
  try {
    mesh.connect(bad);
    await assert.rejects(mesh.handle([...mesh.peers.values()][0], signed(bad, { v: 1, provider: 'public', url: 'http://203.0.113.5/node' })), /HTTPS|funnel/i);
    bad.destroy();
    mesh.connect(good);
    await mesh.handle([...mesh.peers.values()][0], signed(good, { v: 1, provider: 'public', url }));
    assert.equal(mesh.workers()[0].funnel.url, url);
    mesh.announce(mesh.byIdentity.get(key));
    assert.equal(good.sent.at(-1).event.content.includes(url), true);
  } finally { bad.destroy(); good.destroy(); await mesh.close(); }
});
