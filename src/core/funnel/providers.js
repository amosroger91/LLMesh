import { spawn } from 'node:child_process';
import { publicFunnelUrl } from './protocol.js';

export function command(spawnImpl, file, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    if (!child?.stdout || !child.stderr) { reject(new Error(`${file} could not be started`)); return; }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => { child.kill?.(); finish(new Error(`${file} timed out`)); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once?.('error', error => finish(new Error(`${file} failed to start: ${error.message}`)));
    child.once?.('exit', code => finish(code === 0 ? null : new Error((stderr || stdout).trim().slice(0, 500) || `${file} exited ${code}`), { stdout, stderr }));
  });
}

export function tailscalePublicUrl(output, port) {
  const text = String(output ?? '');
  const needle = `:${port}`;
  try {
    const json = JSON.parse(text);
    const web = json.Web ?? {};
    for (const [key, enabled] of Object.entries(json.AllowFunnel ?? {})) {
      if (!enabled) continue;
      const proxies = Object.values(web[key]?.Handlers ?? {}).map(handler => String(handler?.Proxy ?? ''));
      if (!proxies.some(proxy => proxy.includes(needle))) continue;
      const host = key.replace(/:(443|8443|10000)$/, '');
      if (!/^[a-zA-Z0-9.-]+$/.test(host) || !host.toLowerCase().endsWith('.ts.net')) continue;
      return `https://${host}`;
    }
  } catch { /* Tailscale also prints a human-readable status. */ }
  const match = text.match(/https:\/\/[a-zA-Z0-9.-]+\.ts\.net/i);
  if (!match) throw new Error('Tailscale Funnel did not report a public HTTPS URL for this port');
  return match[0].replace(/\/$/, '');
}

export function cloudflareUrl(text) {
  return String(text).match(/https:\/\/[a-z0-9-]{8,80}\.trycloudflare\.com/)?.[0] ?? null;
}

function kill(child) {
  if (!child || child.killed || child.exitCode != null) return;
  child.kill?.();
}

export async function startTailscale({ apiPort, spawn: spawnImpl = spawn }) {
  const target = `http://127.0.0.1:${apiPort}`;
  await command(spawnImpl, 'tailscale', ['funnel', '--bg', target]);
  const status = await command(spawnImpl, 'tailscale', ['funnel', 'status', '--json']);
  return {
    publicUrl: tailscalePublicUrl(`${status.stdout}\n${status.stderr}`, apiPort),
    stop: async () => { await command(spawnImpl, 'tailscale', ['funnel', '--bg', target, 'off']).catch(() => {}); }
  };
}

export function startCloudflare({ apiPort, spawn: spawnImpl = spawn, publicUrl = null }) {
  const child = spawnImpl('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${apiPort}`, '--no-autoupdate'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const discovered = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
    const timer = setTimeout(() => { kill(child); finish(new Error('cloudflared did not publish a URL')); }, 30000);
    let text = '';
    const onData = chunk => {
      text += chunk.toString();
      if (text.length > 200000) text = text.slice(-100000);
      const url = cloudflareUrl(text);
      if (url) finish(null, url);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once?.('error', error => finish(new Error(`cloudflared failed to start: ${error.message}`)));
    child.once?.('exit', code => finish(new Error(`cloudflared exited ${code ?? 'unknown'} before publishing a URL`)));
  });
  return discovered.then(url => ({ publicUrl: publicUrl ? publicFunnelUrl(publicUrl) : url, stop: async () => { kill(child); } }));
}
