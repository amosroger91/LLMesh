// LLMesh Funnel v1. A funnel publishes an existing node API. It is not a second trust domain.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';

export const FUNNEL_PROVIDERS = Object.freeze(['off', 'relay', 'tailscale', 'cloudflare', 'public']);
export const FUNNEL_TAG = 'llmesh-funnel-v1';
export const FUNNEL_PROTOCOL = 'llmesh-funnel/1';
export const MAX_BODY = 524288;
export const MAX_FRAME = 900000;
const ACTIVE = new Set(['relay', 'tailscale', 'cloudflare', 'public']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function sessionId() {
  return randomBytes(32).toString('base64url');
}

export function safeTokenEqual(expected, actual) {
  if (expected == null || expected === '') return true;
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(actual ?? ''));
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export function assertFunnelProvider(value) {
  if (!FUNNEL_PROVIDERS.includes(value)) throw new Error('Funnel provider must be off, relay, tailscale, cloudflare, or public');
  return value;
}

function originOf(value, { allowInsecure = false, allowPath = false } = {}) {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error('Funnel URL cannot contain credentials or a fragment');
  if (!allowPath && (url.pathname !== '/' || url.search)) throw new Error('Funnel base URL must be an origin without a path or query');
  if (allowPath && url.pathname.includes('..')) throw new Error('Funnel URL path is invalid');
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && (loopback || allowInsecure))) {
    if (url.href.length > 300) throw new Error('Funnel URL is too long');
    return url;
  }
  throw new Error('Funnel URL must be HTTPS, or HTTP on loopback');
}

export function publicBaseUrl(value, options) {
  return originOf(value, options).origin;
}

export function publicFunnelUrl(value, options) {
  return originOf(value, { ...options, allowPath: true }).href.replace(/\/$/, '');
}

export function localTarget(host, port) {
  const normalized = String(host ?? '127.0.0.1').replace(/^\[|\]$/g, '');
  if (!LOOPBACK.has(normalized)) throw new Error('Funnel only proxies to a loopback API');
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error('Funnel API port is invalid');
  return { host: normalized === 'localhost' ? '127.0.0.1' : normalized, port: parsed };
}

export function funnelRequestPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) throw new Error('Funnel path is invalid');
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('\0')) throw new Error('Funnel path is invalid');
  let decoded;
  try { decoded = decodeURIComponent(value.split('?')[0]); }
  catch { throw new Error('Funnel path is invalid'); }
  if (decoded.includes('..') || decoded.includes('\\') || decoded.includes('\0')) throw new Error('Funnel path is invalid');
  const url = new URL(value, 'http://127.0.0.1');
  if (url.username || url.password || url.hash) throw new Error('Funnel path is invalid');
  return `${url.pathname}${url.search}`;
}

export function funnelRequestUrl(publicUrl, reqUrl) {
  const base = publicFunnelUrl(publicUrl, { allowInsecure: true });
  const path = funnelRequestPath(reqUrl.startsWith('/') ? reqUrl : `/${reqUrl}`);
  const url = new URL(base + path);
  const prefix = new URL(base);
  const prefixPath = prefix.pathname.endsWith('/') ? prefix.pathname : `${prefix.pathname}/`;
  const samePage = url.pathname === prefix.pathname || url.pathname === prefixPath.slice(0, -1);
  if (url.origin !== prefix.origin || (!samePage && !url.pathname.startsWith(prefixPath))) throw new Error('Funnel path escaped its public prefix');
  return url.origin + url.pathname + url.search;
}

export function splitPublicPath(urlPath) {
  const [pathname, ...query] = String(urlPath ?? '').split('?');
  const match = /^\/f\/([A-Za-z0-9_-]{43})(\/[^]*|\/?)$/.exec(pathname);
  if (!match) return null;
  const search = query.length ? `?${query.join('?')}` : '';
  const suffix = !match[2] || match[2] === '/' ? `/${search}` : `${match[2]}${search}`;
  return { session: match[1], path: funnelRequestPath(suffix) };
}

const REQUEST_HEADERS = new Set(['authorization', 'content-type', 'accept']);
const RESPONSE_HEADERS = new Set(['content-type', 'cache-control', 'x-accel-buffering']);

export function filterHeaders(headers, allowed) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase();
    if (!allowed.has(key) || Array.isArray(value) || typeof value !== 'string' || value.length === 0 || value.length > 8192) continue;
    out[key] = value;
  }
  return out;
}
export const filterRequestHeaders = headers => filterHeaders(headers, REQUEST_HEADERS);
export const filterResponseHeaders = headers => filterHeaders(headers, RESPONSE_HEADERS);

export function encodeFrame(frame) {
  const line = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(line) > MAX_FRAME) throw new Error('Funnel frame is too large');
  return line;
}

export function createFrameParser(onFrame, onError) {
  let buffer = Buffer.alloc(0);
  let failed = false;
  return chunk => {
    if (failed) return;
    buffer = Buffer.concat([buffer, chunk]);
    let newline;
    while ((newline = buffer.indexOf(0x0a)) >= 0) {
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (line.length > MAX_FRAME) { failed = true; onError(new Error('Funnel frame is too large')); return; }
      if (!line.length) continue;
      try { onFrame(JSON.parse(line.toString('utf8'))); }
      catch (error) { failed = true; onError(error); return; }
    }
    if (buffer.length > MAX_FRAME) { failed = true; onError(new Error('Funnel frame is too large')); }
  };
}

export function signFunnelAnnouncement(secret, createdAt = Math.floor(Date.now() / 1000)) {
  return finalizeEvent({
    kind: 30078,
    created_at: createdAt,
    tags: [['d', FUNNEL_TAG]],
    content: JSON.stringify({ v: 1, role: 'node', protocol: FUNNEL_PROTOCOL, nonce: randomBytes(16).toString('hex') })
  }, secret);
}

export function verifyFunnelAnnouncement(event, { now = Date.now(), allow = [] } = {}) {
  if (!event || typeof event !== 'object' || !verifyEvent(event) || event.kind !== 30078) throw new Error('Invalid funnel announcement');
  if (!Number.isFinite(event.created_at) || Math.abs(now / 1000 - event.created_at) > 60) throw new Error('Expired funnel announcement');
  const tag = event.tags?.find(item => item[0] === 'd');
  if (!tag || tag[1] !== FUNNEL_TAG) throw new Error('Invalid funnel announcement');
  const content = JSON.parse(event.content ?? '');
  if (content?.v !== 1 || content.role !== 'node' || content.protocol !== FUNNEL_PROTOCOL) throw new Error('Invalid funnel announcement');
  if (content.nonce != null && (typeof content.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(content.nonce))) throw new Error('Invalid funnel announcement');
  if (!/^[a-f0-9]{64}$/.test(event.pubkey)) throw new Error('Invalid funnel announcement');
  if (allow.length && !allow.includes(event.pubkey)) throw new Error('Funnel node is not allowed on this relay');
  return event.pubkey;
}

export function parseFunnelAdvertisement(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || value.v !== 1 || !ACTIVE.has(value.provider)) throw new Error('Invalid funnel advertisement');
  return { v: 1, provider: value.provider, url: publicFunnelUrl(value.url) };
}

export function bearerToken(header) {
  return header?.startsWith('Bearer ') ? header.slice(7) : '';
}

function loopbackUrl(value) {
  try { return LOOPBACK.has(new URL(value).hostname); }
  catch { return false; }
}

export function funnelSettings(input = {}, { allowInsecure = false } = {}) {
  const provider = assertFunnelProvider(input.provider ?? 'off');
  const relay = input.relay ? publicBaseUrl(input.relay, { allowInsecure: allowInsecure || loopbackUrl(input.relay) }) : null;
  const publicUrl = input.publicUrl ? publicFunnelUrl(input.publicUrl, { allowInsecure }) : null;
  const publicBase = input.publicBase ? publicBaseUrl(input.publicBase, { allowInsecure: true }) : null;
  if (provider === 'relay' && !relay) throw new Error('Relay funnel requires a relay URL');
  if (provider === 'public' && !publicUrl) throw new Error('Public funnel requires a public URL');
  const token = input.token == null || input.token === '' ? null : String(input.token);
  if (token && (token.length < 16 || token.length > 256 || /[\r\n]/.test(token))) throw new Error('Funnel token must be 16–256 characters without line breaks');
  const cloudflareToken = input.cloudflareToken == null || input.cloudflareToken === '' ? null : String(input.cloudflareToken);
  if (cloudflareToken && (cloudflareToken.length < 16 || cloudflareToken.length > 4096 || /[\r\n]/.test(cloudflareToken))) throw new Error('Cloudflare tunnel token must be 16–4096 characters without line breaks');
  if (provider === 'cloudflare' && publicUrl && !cloudflareToken) throw new Error('A stable Cloudflare hostname requires a tunnel token');
  if (provider === 'cloudflare' && cloudflareToken && !publicUrl) throw new Error('A Cloudflare tunnel token requires a public URL');
  return { provider, relay, publicUrl, publicBase, token, cloudflareToken, allowInsecure: Boolean(allowInsecure) };
}

export function nodeManifest(service) {
  const funnel = service.funnel?.status?.() ?? { provider: 'off', state: 'off' };
  return {
    v: 1,
    product: 'llmesh',
    protocol: FUNNEL_PROTOCOL,
    pubkey: service.pubkey,
    auth: ['bearer', 'nip98'],
    endpoints: { health: '/health', ready: '/ready', openai: '/v1', openapi: '/openapi.json' },
    funnel: { provider: funnel.provider ?? 'off', state: funnel.state ?? 'off', verified: funnel.state === 'verified' }
  };
}

export function resolveAuthUrl(service, req) {
  const header = req.headers?.['x-llmesh-funnel-url'];
  if (!header) return service.apiUrl + req.url;
  const remote = req.socket?.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) throw new Error('Funnel URL header is only accepted from loopback');
  const expected = service.funnel?.status?.()?.publicUrl;
  if (typeof header !== 'string' || !expected || header !== funnelRequestUrl(expected, req.url)) throw new Error('Funnel URL does not match this node');
  return header;
}
