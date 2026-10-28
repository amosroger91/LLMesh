import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  MAX_BODY, sessionId, safeTokenEqual, verifyFunnelAnnouncement, bearerToken,
  filterRequestHeaders, filterResponseHeaders, encodeFrame, createFrameParser, splitPublicPath, publicBaseUrl
} from './protocol.js';

const METHODS = new Set(['GET', 'POST', 'HEAD']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body exceeds 512 KiB'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export class FunnelRelay extends EventEmitter {
  constructor({ token = null, allow = [], publicBase = null, tls = null, maxSessions = 128, maxConcurrent = 8 } = {}) {
    super();
    this.token = token || null;
    this.allow = allow;
    this.publicBase = publicBase ? publicBaseUrl(publicBase, { allowInsecure: true }) : null;
    this.tls = tls;
    this.maxSessions = maxSessions;
    this.maxConcurrent = maxConcurrent;
    this.sessions = new Map();
    this.byEvent = new Map();
    this.byAddress = new Map();
    this.requests = 0;
    const handler = (req, res) => { void this.request(req, res); };
    this.server = tls ? https.createServer(tls, handler) : http.createServer(handler);
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server.requestTimeout = 0;
    this.server.timeout = 0;
    this.server.headersTimeout = 20000;
    this.sweep = setInterval(() => {
      const now = Date.now();
      for (const [id, expires] of this.byEvent) if (expires <= now) this.byEvent.delete(id);
    }, 30000);
    this.sweep.unref?.();
  }

  async listen(port = 0, host = '127.0.0.1') {
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, host, resolve); });
    const address = this.server.address();
    this.port = address.port;
    this.host = host;
    this.origin = this.publicBase ?? `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${address.port}`;
    if ((host === '0.0.0.0' || host === '::') && !this.publicBase) this.warning = 'No public base is set. Published funnel URLs use loopback and are only reachable on this machine.';
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && !this.tls) this.warning = this.warning ?? 'Funnel relay is listening without TLS. Terminate TLS here or at a proxy.';
    return this;
  }

  status() {
    return { role: 'relay', protocol: 'llmesh-funnel/1', sessions: this.sessions.size, requests: this.requests, origin: this.origin, token: Boolean(this.token), allow: this.allow.length, warning: this.warning ?? null };
  }

  json(res, code, value) {
    const body = JSON.stringify(value);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  admit(remote) {
    const now = Date.now();
    const recent = (this.byAddress.get(remote) ?? []).filter(stamp => now - stamp < 60000);
    if (recent.length >= 30) return false;
    recent.push(now);
    this.byAddress.set(remote, recent);
    return true;
  }

  async request(req, res) {
    try {
      const pathOnly = String(req.url ?? '/').split('?')[0];
      let decodedPath;
      try { decodedPath = decodeURIComponent(pathOnly); }
      catch { return this.json(res, 400, { error: { message: 'Funnel path is invalid' } }); }
      if (decodedPath.includes('..') || decodedPath.includes('\\') || decodedPath.includes('\0')) return this.json(res, 400, { error: { message: 'Funnel path is invalid' } });
      const url = new URL(req.url, this.origin ?? 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') return this.json(res, 200, { ok: true, ...this.status() });
      if (req.method === 'GET' && url.pathname === '/v1/funnel') return this.json(res, 200, { v: 1, protocol: 'llmesh-funnel/1', role: 'relay' });
      if (req.method === 'POST' && url.pathname === '/v1/funnel/sessions') return await this.openSession(req, res);
      if (req.method === 'GET' && url.pathname === '/v1/funnel/tunnel') return this.json(res, 426, { error: { message: 'Upgrade to llmesh-funnel' } });
      const routed = splitPublicPath(url.pathname + url.search);
      if (!routed || !METHODS.has(req.method)) return this.json(res, routed ? 405 : 404, { error: { message: routed ? 'Method not allowed' : 'Not found' } });
      await this.proxy(req, res, routed);
    } catch (error) {
      if (!res.headersSent) this.json(res, error.status ?? 400, { error: { message: String(error.message ?? 'Bad funnel request').slice(0, 300) } });
      else res.end();
    }
  }

  async openSession(req, res) {
    const remote = req.socket.remoteAddress ?? 'unknown';
    if (!this.admit(remote)) return this.json(res, 429, { error: { message: 'Too many funnel sessions' } });
    if (!safeTokenEqual(this.token, bearerToken(req.headers.authorization))) return this.json(res, 401, { error: { message: 'Funnel token rejected' } });
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const pubkey = verifyFunnelAnnouncement(body.event, { allow: this.allow });
    if (this.byEvent.has(body.event.id)) return this.json(res, 401, { error: { message: 'Funnel announcement was already used' } });
    const previous = [...this.sessions.values()].find(session => session.pubkey === pubkey);
    if (!previous && this.sessions.size >= this.maxSessions) return this.json(res, 503, { error: { message: 'Funnel relay is full' } });
    this.byEvent.set(body.event.id, Date.now() + 120000);
    if (previous) this.drop(previous);
    const id = sessionId();
    const session = { id, pubkey, socket: null, pending: new Map(), parser: null };
    this.sessions.set(id, session);
    this.json(res, 201, { v: 1, session: id, publicUrl: `${this.origin}/f/${id}`, tunnel: '/v1/funnel/tunnel', pubkey });
  }

  drop(session) {
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      if (!pending.res.headersSent) this.json(pending.res, 502, { error: { message: 'Funnel node disconnected' } });
      else pending.res.end();
    }
    session.socket?.destroy();
    this.sessions.delete(session.id);
  }

  upgrade(req, socket, head) {
    const fail = (code, message) => {
      const body = JSON.stringify({ error: { message } });
      socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      socket.destroy();
    };
    if (req.headers.upgrade?.toLowerCase() !== 'llmesh-funnel') return fail(426, 'Upgrade required');
    const id = req.headers.authorization?.startsWith('Funnel ') ? req.headers.authorization.slice(7) : '';
    const session = this.sessions.get(id);
    if (!session || session.socket) return fail(401, 'Unknown funnel session');
    session.socket = socket;
    socket.setNoDelay(true);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: llmesh-funnel\r\nConnection: Upgrade\r\n\r\n');
    const parser = createFrameParser(frame => this.onFrame(session, frame), () => this.drop(session));
    session.parser = parser;
    if (head?.length) parser(head);
    socket.on('data', parser);
    socket.on('error', () => {});
    socket.on('close', () => { if (this.sessions.get(id) === session) this.drop(session); });
  }

  async proxy(req, res, routed) {
    const session = this.sessions.get(routed.session);
    if (!session?.socket || session.socket.destroyed) return this.json(res, 503, { error: { message: 'Funnel node is offline' } });
    if (session.pending.size >= this.maxConcurrent) return this.json(res, 429, { error: { message: 'Funnel node is busy' } });
    const body = await readBody(req);
    const id = randomUUID();
    const pending = { res, timer: setTimeout(() => this.finish(session, id, 504, 'Funnel request timed out'), 190000) };
    session.pending.set(id, pending);
    this.requests += 1;
    const written = session.socket.write(encodeFrame({
      type: 'request', id, method: req.method, path: routed.path, headers: filterRequestHeaders(req.headers), body: body.length ? body.toString('base64') : ''
    }));
    if (!written) session.socket.once('drain', () => {});
  }

  onFrame(session, frame) {
    const pending = session.pending.get(frame?.id);
    if (!pending || typeof frame?.type !== 'string') return;
    if (frame.type === 'response') {
      if (pending.res.headersSent) return this.drop(session);
      const status = Number.isInteger(frame.status) && frame.status >= 100 && frame.status <= 599 ? frame.status : 502;
      pending.res.writeHead(status, filterResponseHeaders(frame.headers));
      pending.headed = true;
      return;
    }
    if (frame.type === 'chunk') {
      if (!pending.headed || typeof frame.body !== 'string') return this.drop(session);
      const data = Buffer.from(frame.body, 'base64');
      if (!pending.res.write(data) && !pending.paused) {
        pending.paused = true;
        session.socket.pause();
        pending.res.once('drain', () => { pending.paused = false; session.socket?.resume(); });
      }
      return;
    }
    if (frame.type === 'end') {
      clearTimeout(pending.timer);
      session.pending.delete(frame.id);
      if (!pending.headed) this.json(pending.res, 502, { error: { message: 'Funnel node sent an empty response' } });
      else pending.res.end();
      return;
    }
    if (frame.type === 'error') {
      clearTimeout(pending.timer);
      session.pending.delete(frame.id);
      const message = String(frame.message ?? 'Funnel node failed').slice(0, 300);
      const status = Number.isInteger(frame.status) ? frame.status : 502;
      if (!pending.res.headersSent) this.json(pending.res, status, { error: { message } });
      else pending.res.end();
    }
  }

  finish(session, id, status, message) {
    const pending = session.pending.get(id);
    if (!pending) return;
    session.pending.delete(id);
    if (!pending.res.headersSent) this.json(pending.res, status, { error: { message } });
    else pending.res.destroy();
  }

  async close() {
    clearInterval(this.sweep);
    for (const session of [...this.sessions.values()]) this.drop(session);
    this.server.closeAllConnections?.();
    await new Promise(resolve => this.server.close(resolve));
  }
}
