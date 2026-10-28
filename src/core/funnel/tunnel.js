import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import {
  MAX_BODY, localTarget, publicFunnelUrl, funnelRequestPath, funnelRequestUrl,
  filterRequestHeaders, filterResponseHeaders, signFunnelAnnouncement, encodeFrame, createFrameParser
} from './protocol.js';

export class FunnelTunnel extends EventEmitter {
  constructor({ relay, token = null, secret, apiHost = '127.0.0.1', apiPort, tls = false }) {
    super();
    this.relay = new URL(relay);
    this.token = token || null;
    this.secret = secret;
    this.target = localTarget(apiHost, apiPort);
    this.tls = Boolean(tls);
    this.closed = false;
    this.generation = 0;
    this.socket = null;
    this.publicUrl = null;
    const library = tls ? https : http;
    this.agent = new library.Agent({ keepAlive: true, maxSockets: 8 });
  }

  async open() {
    if (this.closed) throw new Error('Funnel tunnel is closed');
    this.generation += 1;
    const generation = this.generation;
    this.socket?.destroy();
    this.socket = null;
    const event = signFunnelAnnouncement(this.secret);
    const response = await fetch(new URL('/v1/funnel/sessions', this.relay), {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ v: 1, event })
    });
    const body = await response.json().catch(() => ({}));
    if (response.status !== 201) throw new Error(body.error?.message ?? `Funnel relay rejected the session (${response.status})`);
    this.publicUrl = publicFunnelUrl(body.publicUrl, { allowInsecure: true });
    await this.connect(body.session, generation);
    return { publicUrl: this.publicUrl, session: body.session };
  }

  connect(session, generation) {
    const library = this.relay.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = library.request({
        protocol: this.relay.protocol, hostname: this.relay.hostname, port: this.relay.port, path: '/v1/funnel/tunnel',
        headers: { Connection: 'Upgrade', Upgrade: 'llmesh-funnel', Authorization: `Funnel ${session}` }, timeout: 15000
      });
      const fail = error => { req.destroy(); reject(error); };
      req.once('upgrade', (_response, socket, head) => {
        if (this.closed || generation !== this.generation) { socket.destroy(); return reject(new Error('Funnel tunnel is closed')); }
        this.socket = socket;
        socket.setNoDelay(true);
        const parser = createFrameParser(frame => { void this.onFrame(frame); }, () => socket.destroy());
        if (head?.length) parser(head);
        socket.on('data', parser);
        socket.on('error', () => {});
        socket.on('close', () => {
          if (this.socket === socket) this.socket = null;
          if (!this.closed && generation === this.generation) this.emit('close');
        });
        resolve();
      });
      req.once('response', response => { response.resume(); fail(new Error(`Funnel tunnel upgrade failed (${response.statusCode})`)); });
      req.once('error', fail);
      req.once('timeout', () => fail(new Error('Funnel tunnel upgrade timed out')));
      req.end();
    });
  }

  send(frame) {
    if (!this.socket || this.socket.destroyed) return false;
    return this.socket.write(encodeFrame(frame));
  }

  async onFrame(frame) {
    if (frame?.type !== 'request' || typeof frame.id !== 'string' || frame.id.length > 80) return;
    this.emit('request');
    const fail = (status, message) => this.send({ type: 'error', id: frame.id, status, message: String(message).slice(0, 300) });
    try {
      const path = funnelRequestPath(frame.path);
      const body = frame.body ? Buffer.from(String(frame.body), 'base64') : Buffer.alloc(0);
      if (body.length > MAX_BODY) return fail(413, 'Request body exceeds 512 KiB');
      if (!['GET', 'POST', 'HEAD'].includes(frame.method)) return fail(405, 'Method not allowed');
      const headers = filterRequestHeaders(frame.headers);
      headers['x-llmesh-funnel-url'] = funnelRequestUrl(this.publicUrl, path);
      headers.host = `${this.target.host}:${this.target.port}`;
      if (body.length) headers['content-length'] = String(body.length);
      const library = this.tls ? https : http;
      const req = library.request({
        host: this.target.host, port: this.target.port, method: frame.method, path, headers, agent: this.agent,
        rejectUnauthorized: false, timeout: 190000
      }, response => {
        const write = next => {
          if (this.send(next) === false && !response.paused) {
            response.pause();
            this.socket?.once('drain', () => response.resume());
          }
        };
        write({ type: 'response', id: frame.id, status: response.statusCode, headers: filterResponseHeaders(response.headers) });
        response.on('data', chunk => {
          for (let offset = 0; offset < chunk.length; offset += 32768) write({ type: 'chunk', id: frame.id, body: chunk.subarray(offset, offset + 32768).toString('base64') });
        });
        response.on('end', () => this.send({ type: 'end', id: frame.id }));
        response.on('error', () => fail(502, 'Local API failed'));
      });
      req.once('error', error => fail(502, error.message));
      req.once('timeout', () => { req.destroy(); fail(504, 'Local API timed out'); });
      req.end(body.length ? body : undefined);
    } catch (error) { fail(error.status ?? 400, error.message); }
  }

  async close() {
    this.closed = true;
    this.generation += 1;
    this.socket?.destroy();
    this.socket = null;
    this.agent.destroy();
  }
}
