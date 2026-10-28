import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { FunnelRelay } from './relay.js';
import { FunnelTunnel } from './tunnel.js';
import { command, startCloudflare, startTailscale } from './providers.js';
import { FUNNEL_PROTOCOL, funnelRequestUrl, funnelSettings, localTarget } from './protocol.js';

export { FunnelRelay } from './relay.js';
export { nodeManifest, resolveAuthUrl, parseFunnelAdvertisement, funnelSettings, FUNNEL_PROTOCOL } from './protocol.js';

export class Funnel extends EventEmitter {
  constructor(options = {}) {
    super();
    this.settings = funnelSettings(options, { allowInsecure: Boolean(options.allowInsecure) });
    this.secret = options.secret;
    this.pubkey = options.pubkey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.spawn = options.spawn;
    this.tls = Boolean(options.tls);
    this.api = ['relay', 'tailscale', 'cloudflare'].includes(this.settings.provider) ? localTarget(options.apiHost ?? '127.0.0.1', options.apiPort) : null;
    this.stopped = true;
    this.tunnel = null;
    this.handle = null;
    this.backoff = 1000;
    this.state = this.blank('off');
  }

  blank(state, extra = {}) {
    return {
      provider: this.settings.provider, state, publicUrl: null, error: null, verifiedAt: null, requests: this.state?.requests ?? 0,
      relay: this.settings.relay, hasToken: Boolean(this.settings.token), ...extra
    };
  }

  status() {
    return {
      ...this.state,
      configured: { provider: this.settings.provider, relay: this.settings.relay, publicUrl: this.settings.publicUrl, hasToken: Boolean(this.settings.token) }
    };
  }

  advertisement() {
    if (this.state.state !== 'verified' || !this.state.publicUrl) return {};
    return { funnel: { v: 1, provider: this.state.provider, url: this.state.publicUrl } };
  }

  async start() {
    if (this.settings.provider === 'off') return this.status();
    if (!this.pubkey) throw new Error('Funnel requires the node public key');
    this.stopped = false;
    this.state.state = 'starting';
    this.state.error = null;
    try {
      await this.open();
      clearInterval(this.timer);
      this.timer = setInterval(() => { if (!this.stopped && this.state.publicUrl) void this.probe().catch(() => {}); }, 30000);
      this.timer.unref?.();
      return this.status();
    } catch (error) {
      this.state.state = 'error';
      this.state.error = error.message;
      this.emit('change', this.status());
      throw error;
    }
  }

  async open() {
    if (this.settings.provider === 'relay') {
      await this.tunnel?.close?.();
      this.tunnel = new FunnelTunnel({ relay: this.settings.relay, token: this.settings.token, secret: this.secret, apiHost: this.api.host, apiPort: this.api.port, tls: this.tls });
      this.tunnel.on('request', () => { this.state.requests += 1; });
      this.tunnel.on('close', () => this.reconnect());
      this.state.publicUrl = (await this.tunnel.open()).publicUrl;
    } else if (this.settings.provider === 'public') this.state.publicUrl = this.settings.publicUrl;
    else if (this.settings.provider === 'tailscale') {
      await this.handle?.stop?.();
      this.handle = await startTailscale({ apiPort: this.api.port, spawn: this.spawn });
      this.state.publicUrl = this.handle.publicUrl;
    } else {
      await this.handle?.stop?.();
      this.handle = await startCloudflare({ apiPort: this.api.port, spawn: this.spawn, publicUrl: this.settings.publicUrl });
      this.state.publicUrl = this.handle.publicUrl;
    }
    this.state.state = 'pending';
    await this.probe();
  }

  reconnect() {
    if (this.stopped || this.settings.provider !== 'relay' || !this.tunnel) return;
    this.state.state = 'pending';
    this.state.verifiedAt = null;
    this.state.error = 'Funnel tunnel closed';
    const delay = this.backoff;
    this.backoff = Math.min(30000, this.backoff * 2);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.tunnel.open().then(opened => {
        this.backoff = 1000;
        this.state.publicUrl = opened.publicUrl;
        return this.probe();
      }).catch(error => { this.state.error = error.message; this.reconnect(); });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async probe() {
    if (this.stopped) return this.status();
    if (!this.state.publicUrl) throw new Error('Funnel has no public URL');
    const url = funnelRequestUrl(this.state.publicUrl, '/.well-known/llmesh.json');
    try {
      const response = await this.fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
      if (response.status !== 200) throw new Error(`Funnel probe returned HTTP ${response.status}`);
      const body = await response.json();
      if (body?.pubkey !== this.pubkey || body?.v !== 1 || body?.protocol !== FUNNEL_PROTOCOL) throw new Error('Funnel probe did not reach this node');
      this.state.state = 'verified';
      this.state.verifiedAt = new Date().toISOString();
      this.state.error = null;
    } catch (error) {
      if (this.state.state !== 'error') this.state.state = 'pending';
      this.state.verifiedAt = null;
      this.state.error = error.message;
    }
    if (this.stopped) return this.status();
    this.emit('change', this.status());
    return this.status();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.timer);
    await this.tunnel?.close?.();
    await this.handle?.stop?.();
    this.tunnel = null;
    this.handle = null;
    this.state = this.blank('off');
    return this.status();
  }
}

export function createNodeFunnel(options) {
  return new Funnel(options);
}

export async function funnelDoctor(config, { spawn: spawnImpl = spawn, fetch: fetchImpl = globalThis.fetch } = {}) {
  const checks = [{ name: 'funnel-provider', ok: true, detail: config.funnel }];
  if (config.funnel === 'off') {
    checks.push({ name: 'funnel', ok: true, detail: 'Off. The API stays on loopback until a funnel provider is selected.' });
    return checks;
  }
  if (config.funnel === 'tailscale' || config.funnel === 'cloudflare') {
    const file = config.funnel === 'tailscale' ? 'tailscale' : 'cloudflared';
    try {
      const result = await command(spawnImpl, file, config.funnel === 'tailscale' ? ['version'] : ['--version'], 5000);
      checks.push({ name: file, ok: true, detail: (result.stdout || result.stderr).trim().slice(0, 200) });
    } catch (error) { checks.push({ name: file, ok: false, detail: error.message }); }
  }
  if (config.funnel === 'relay') {
    if (config.offline) checks.push({ name: 'funnel-relay', ok: true, detail: 'Skipped while offline' });
    else {
      try {
        const response = await fetchImpl(new URL('/health', config.funnelRelay), { signal: AbortSignal.timeout(5000), redirect: 'manual' });
        checks.push({ name: 'funnel-relay', ok: response.status === 200, detail: config.funnelRelay });
      } catch (error) { checks.push({ name: 'funnel-relay', ok: false, detail: error.message }); }
    }
  }
  if (config.funnel === 'public') checks.push({ name: 'funnel-public-url', ok: Boolean(config.funnelPublicUrl), detail: config.funnelPublicUrl ?? 'Set LLMESH_FUNNEL_PUBLIC_URL' });
  return checks;
}
