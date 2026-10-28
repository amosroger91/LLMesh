import {recordInference} from '../shared/inference-metrics.js';
import {nodeProfile} from '../shared/node-profile.js';
import Hyperswarm from 'hyperswarm';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { hash } from './identity.js';
import { validateMessage } from './mesh-protocol.js';
import { parseFunnelAdvertisement } from './funnel/protocol.js';

export function rankWorkers(workers, model) {
  return workers.filter(w => w.models.includes(model) && w.busy === 0 && Date.now() - w.seen < 35000)
    .sort((a, b) => ((a.latencyMs ?? 100) + (a.firstTokenMs ?? 1500)) -
      ((b.latencyMs ?? 100) + (b.firstTokenMs ?? 1500)) || (b.tokensPerSecond ?? 0) - (a.tokensPerSecond ?? 0));
}

export class Mesh extends EventEmitter {
  constructor({ secret, topic, describe, run, onDelivery, allowedWorkers = [], trustedCoordinators = [], handshakeTimeoutMs = 10000, swarm }) {
    super(); Object.assign(this, { secret, describe, run, onDelivery, allowedWorkers, trustedCoordinators, handshakeTimeoutMs });
    this.swarm = swarm ?? new Hyperswarm({ maxPeers: 32 });
    this.byIdentity = new Map(); this.peers = new Map(); this.pending = new Map(); this.active = new Map();
    this.swarm.on('error', error => this.emit('warning', error.message));
    this.swarm.on('connection', socket => this.connect(socket));
    this.discovery = this.swarm.join(Buffer.from(hash('llmesh/v2/' + (topic ?? hash(Buffer.from(secret).toString('hex')))), 'hex'), { server: true, client: true });
    this.timer = setInterval(() => { for (const peer of this.peers.values()) { this.announce(peer); if (peer.pubkey) this.ping(peer); } }, 5000);
    this.timer.unref();
  }
  async send(peer, message) {
    if (peer.socket.destroyed) throw new Error('Worker disconnected');
    if (!peer.socket.write(JSON.stringify(message) + '\n')) await once(peer.socket, 'drain');
  }
  announce(peer, identityOnly = false) {
    const description = this.describe();
    const { acceptFrom: _privateTrustList, ...capabilities } = description;
    const content = { v: peer.version ?? 3, phase: !peer.pubkey || identityOnly ? 'identity' : 'capabilities',
      connection: peer.socket.publicKey.toString('hex'), handshake: peer.socket.handshakeHash.toString('hex') };
    if (content.phase === 'capabilities') Object.assign(content, capabilities);
    const event = finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'llmesh-worker-v2']], content: JSON.stringify(content) }, this.secret);
    this.send(peer, { type: 'hello', event }).catch(() => peer.socket.destroy());
  }
  ping(peer) {
    const id = randomUUID(); peer.ping = { id, started: performance.now() };
    this.send(peer, { type: 'ping', id }).catch(() => peer.socket.destroy());
  }
  connect(socket) {
    const key = socket.remotePublicKey.toString('hex');
    const peer = { socket, models: [], busy: 1, inFlight: 0, seen: 0, latencyMs: 100 };
    this.peers.set(key, peer);
    peer.helloTimer=setTimeout(()=>{if(!peer.pubkey)this.announce(peer);},50);peer.helloTimer.unref();
    peer.handshakeTimer = setTimeout(() => socket.destroy(), this.handshakeTimeoutMs); peer.handshakeTimer.unref();
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', data => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 1024 * 1024) return socket.destroy();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { this.handle(peer, JSON.parse(line)).catch(() => socket.destroy()); } catch { socket.destroy(); }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(peer.handshakeTimer); clearTimeout(peer.helloTimer);
      if (this.byIdentity.get(peer.pubkey) === peer) this.byIdentity.delete(peer.pubkey);
      if (this.peers.get(key) === peer) this.peers.delete(key);
      for (const [id, pending] of this.pending) if (pending.peer === peer) { pending.reject(new Error('Worker disconnected')); this.pending.delete(id); }
      for (const task of this.active.values()) if (task.peer === peer) task.controller.abort();
    });
  }
  async handle(peer, msg) {
    validateMessage(msg);
    if (msg.type !== 'hello' && !peer.pubkey) throw new Error('Authenticate before sending mesh messages');
    if (msg.type === 'ping') {
      if (typeof msg.id !== 'string' || msg.id.length > 64) throw new Error('Bad ping');
      return this.send(peer, { type: 'pong', id: msg.id });
    } else if (msg.type === 'pong') {
      if (peer.ping?.id === msg.id) {
        const sample = performance.now() - peer.ping.started;
        peer.latencyMs = peer.measuredRtt ? peer.latencyMs * 0.75 + sample * 0.25 : sample;
        peer.measuredRtt = true; peer.ping = null;
      }
    } else if (msg.type === 'hello') {
      if (!verifyEvent(msg.event) || msg.event.kind !== 30078 || Math.abs(Date.now() / 1000 - msg.event.created_at) > 60) throw new Error('Bad advertisement');
      const info = JSON.parse(msg.event.content);
      if (![1,2,3].includes(info.v ?? 1)) { this.emit('warning', 'Unsupported mesh protocol; all peers must use a supported protocol version'); throw new Error('Unsupported mesh protocol'); }
      info.phase ??= 'capabilities';
      peer.version=info.v??1;
      if (info.connection !== peer.socket.remotePublicKey.toString('hex') || info.handshake !== peer.socket.handshakeHash.toString('hex') ||
          !['identity', 'capabilities'].includes(info.phase)) throw new Error('Bad handshake binding');
      if (![...this.allowedWorkers, ...this.trustedCoordinators].includes(msg.event.pubkey)) throw new Error('Untrusted mesh identity');
      if (peer.pubkey && peer.pubkey !== msg.event.pubkey) throw new Error('Peer identity changed');
      const newlyAuthenticated = !peer.pubkey;
      const previous = this.byIdentity.get(msg.event.pubkey);
      if (previous && previous !== peer) previous.socket.destroy();
      peer.pubkey = msg.event.pubkey; this.byIdentity.set(peer.pubkey, peer); clearTimeout(peer.handshakeTimer);
      if (newlyAuthenticated) { this.announce(peer); this.ping(peer); }
      if (info.phase === 'identity') return;
      if (!Array.isArray(info.models) || info.models.length > 20 || !info.models.every(model => typeof model === 'string' && model.length < 100) || ![0, 1].includes(info.busy)) throw new Error('Bad capabilities');
      if(info.slots!=null&&(!Array.isArray(info.slots)||info.slots.length>64||!info.slots.every(slot=>typeof slot.id==='string'&&slot.id.length<=100&&typeof slot.model==='string'&&Number.isInteger(slot.total)&&slot.total>=1&&slot.total<=4&&Number.isInteger(slot.free)&&slot.free>=0&&slot.free<=slot.total)))throw new Error('Invalid runtime slots');
      if(info.devices!=null&&(!Array.isArray(info.devices)||info.devices.length>16||!info.devices.every(device=>/^web-[a-f0-9]{64}$/.test(device.id)&&typeof device.name==='string'&&device.name.length<=60&&typeof device.model==='string'&&device.model.length<=100&&typeof device.busy==='boolean')))throw new Error('Invalid linked devices');
      for(const device of info.devices??[])if(device.profile)device.profile=nodeProfile(device.profile);
      peer.devices=info.devices??[];
      for(const slot of info.slots??[]){
        if(slot.source!=null&&!['third-party','community'].includes(slot.source))throw new Error('Invalid worker source');
        if(slot.requestTokenLimit!=null&&(!Number.isSafeInteger(slot.requestTokenLimit)||slot.requestTokenLimit<256||slot.requestTokenLimit>1000000))throw new Error('Invalid provider request limit');
        if(slot.maxContextTokens!=null&&(!Number.isInteger(slot.maxContextTokens)||slot.maxContextTokens<512||slot.maxContextTokens>32768))throw new Error('Invalid context capability');
        if(slot.source==='third-party'){
          const model=slot.modelInfo;
          if(!model||model.id!==slot.model||!/^donated:[a-z0-9-]{1,80}$/.test(model.id)||!Number.isInteger(model.rank)||model.rank<1||model.rank>5||!Number.isFinite(model.parametersB)||model.parametersB<=0||model.parametersB>10000||typeof model.provider!=='string'||model.provider.length>40||typeof model.upstreamModel!=='string'||model.upstreamModel.length>200||!Number.isSafeInteger(slot.creditBudget)||slot.creditBudget<0||slot.creditBudget>10000000)throw new Error('Invalid donated API capability');
        }else if(slot.model.startsWith('donated:'))throw new Error('Unclassified third-party capability');
      }
      peer.funnel = parseFunnelAdvertisement(info.funnel);
      peer.memoryBlocked=info.memoryBlocked===true;peer.working=info.working===true;
      peer.profile=info.profile?nodeProfile(info.profile):undefined;
      peer.slots=info.slots;
      Object.assign(peer, { models: info.models, busy: info.busy, seen: Date.now() });
      peer.wallet = typeof info.wallet === 'string' && /^0x[0-9a-fA-F]{40}$/.test(info.wallet) ? info.wallet : null;
      peer.chainId = info.chainId; peer.escrow = info.escrow;
      peer.contribution = ['low', 'medium', 'high'].includes(info.contribution) ? info.contribution : 'low';
      peer.loadedModel = typeof info.loadedModel === 'string' && peer.models.includes(info.loadedModel) ? info.loadedModel : null;
      const hw = info.hardware;
      if (hw && ['cpu', 'gpu', 'unified'].includes(hw.mode)) peer.hardware = {
        mode: hw.mode, ramGB: Number.isFinite(hw.ramGB) ? Math.max(0, Math.min(4096, hw.ramGB)) : 0,
        vramGB: Number.isFinite(hw.vramGB) ? Math.max(0, Math.min(4096, hw.vramGB)) : 0,
        maxModelRank: Number.isInteger(hw.maxModelRank) && hw.maxModelRank >= 0 && hw.maxModelRank <= 5 ? hw.maxModelRank : 0 };
    } else if (msg.type === 'job') {
      if (typeof msg.id !== 'string' || !msg.id.length || msg.id.length > 64) throw new Error('Bad job ID');
      const slots=this.describe().slots;const total=Array.isArray(slots)?slots.reduce((sum,slot)=>sum+slot.total,0):4;
      const requestedSlot=slots?.find(slot=>slot.id===msg.job.instanceId&&slot.model===msg.job.model);
      const used=Array.from(this.active.values()).filter(task=>task.instanceId===msg.job.instanceId).length;
      if (this.active.has(msg.id) || this.active.size >= total || (Array.isArray(slots)&&(!requestedSlot||used>=requestedSlot.total))) return this.send(peer, { type: 'error', id: msg.id, error: 'Worker busy or duplicate job', retryable: true });
      if (!peer.pubkey || !this.trustedCoordinators.includes(peer.pubkey)) return this.send(peer, { type: 'error', id: msg.id, error: 'Coordinator is not trusted by worker' });
      const controller = new AbortController();
      this.active.set(msg.id, { controller, peer, instanceId:msg.job.instanceId });
      const timeout = setTimeout(() => controller.abort(), 180000);
      try {
        for await (const part of this.run(msg.job, controller.signal)) await this.send(peer, { ...part, id: msg.id });
      } catch (e) { await this.send(peer, { type: 'error', id: msg.id, error: e.message }).catch(() => {}); }
      finally { clearTimeout(timeout); this.active.delete(msg.id); }
    } else if (msg.type === 'delivered') {
      if (!this.trustedCoordinators.includes(peer.pubkey)) throw new Error('Untrusted delivery acknowledgement');
      if (!msg.payment || typeof msg.payment.attestation !== 'string' || msg.payment.attestation.length !== 132 || !/^0x[a-f0-9]{64}$/i.test(msg.payment.outputHash)) throw new Error('Invalid delivery proof');
      try { await this.onDelivery?.(msg.payment); }
      catch (error) { this.emit('warning', `Delivery claim pending: ${error.message}`); }
    } else if (msg.type === 'cancel') {
      const task = this.active.get(msg.id); if (task?.peer === peer) task.controller.abort();
    } else {
      const task = this.pending.get(msg.id);
      if (!task || task.peer !== peer) return;
      if (msg.type === 'delta') {
        if (typeof msg.text !== 'string' || (task.bytes += Buffer.byteLength(msg.text)) > 262144) throw new Error('Response limit exceeded');
        if (!task.firstAt) {
          task.firstAt = performance.now();
          const sample = Math.max(0, task.firstAt - task.started - peer.latencyMs);
          peer.firstTokenMs = peer.firstTokenMs == null ? sample : peer.firstTokenMs * 0.7 + sample * 0.3;
          const metric = (peer.metrics ??= {})[task.model] ??= {};
          metric.firstTokenMs = metric.firstTokenMs == null ? sample : metric.firstTokenMs * 0.7 + sample * 0.3;
        }
        task.onDelta(msg.text);
      } else if (msg.type === 'tool_calls') {
        if (!Array.isArray(msg.calls) || msg.calls.length > 128 ||
            msg.calls.some(call => !Number.isInteger(call.index) || call.index < 0 || call.index >= 128 || typeof call.id !== 'string' || call.id.length > 200 ||
              call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') ||
            (task.bytes += Buffer.byteLength(JSON.stringify(msg.calls))) > 262144) throw new Error('Invalid worker tool calls');
        if(!task.firstAt){task.firstAt=performance.now();task.buffered=true;}task.onDelta({ type: 'tool_calls', calls: msg.calls });
      } else if (msg.type === 'done') {
        if (!Number.isSafeInteger(msg.tokens) || msg.tokens < 0 || msg.tokens > task.maxTokens ||
            !Number.isSafeInteger(msg.promptTokens ?? 0) || (msg.promptTokens ?? 0) < 0 || (msg.promptTokens ?? 0) > 32768) throw new Error('Invalid worker token usage');
        if(task.firstAt){const metric=(peer.instanceMetrics??={})[task.instanceId??task.model]??={};recordInference(metric,{firstTokenMs:Math.max(0,task.firstAt-task.started-(peer.latencyMs??0)),tokens:msg.tokens,durationMs:Math.max(0,performance.now()-task.started-(peer.latencyMs??0)),buffered:task.buffered});peer.tokensPerSecond=metric.tokensPerSecond;}
        peer.loadedModel = task.model;
        this.pending.delete(msg.id); task.resolve({ worker: peer.pubkey, tokens: msg.tokens,
          promptTokens: msg.promptTokens ?? 0, finishReason: ['length', 'tool_calls'].includes(msg.finishReason) ? msg.finishReason : 'stop' });
      }
      else if (msg.type === 'error') {
        this.pending.delete(msg.id);
        task.reject(Object.assign(new Error(String(msg.error).slice(0, 300)), {
          retryable: msg.retryable === true,
          refundAuthorization: typeof msg.refundAuthorization === 'string' && /^0x[0-9a-f]{130}$/i.test(msg.refundAuthorization) ? msg.refundAuthorization : undefined
        }));
      }
    }
  }
  workers() {
    return [...this.byIdentity.values()].filter(peer=>this.allowedWorkers.includes(peer.pubkey)).flatMap(peer=>{
      const base={devices:peer.devices,pubkey:peer.pubkey,funnel:peer.funnel,models:peer.models,busy:Math.max(peer.busy,peer.inFlight),seen:peer.seen,latencyMs:peer.latencyMs,
        firstTokenMs:peer.firstTokenMs,tokensPerSecond:peer.tokensPerSecond,hardware:peer.hardware,loadedModel:peer.loadedModel,metrics:{...peer.metrics,...peer.instanceMetrics},
        working:peer.working,memoryBlocked:peer.memoryBlocked,profile:peer.profile,supportsTools:peer.supportsTools,contribution:peer.contribution,wallet:peer.wallet,chainId:peer.chainId,escrow:peer.escrow};
      if(!peer.slots)return [base];
      return peer.slots.map(slot=>({...base,instanceId:slot.id,models:[slot.model],total:slot.total,
          requestTokenLimit:slot.requestTokenLimit,maxContextTokens:slot.maxContextTokens,source:slot.source,creditBudget:slot.creditBudget,modelCatalog:slot.source==='third-party'?[slot.modelInfo]:[],supportsTools:slot.supportsTools,free:Math.max(0,slot.free-(peer.instanceInFlight?.get(slot.id)??0)),busy:slot.free>(peer.instanceInFlight?.get(slot.id)??0)?0:1,
        metrics:{[slot.model]:{firstTokenMs:slot.firstTokenMs,tokensPerSecond:slot.tokensPerSecond,...peer.instanceMetrics?.[slot.id]}}}));
    });
  }
  acknowledge(worker, payment) {
    const peer = this.byIdentity.get(worker);
    if (peer) this.send(peer, { type: 'delivered', payment }).catch(error => this.emit('warning', error.message));
  }
  async execute(job, onDelta, signal) {
    const candidate = job.workerKey ? this.workers().find(worker => worker.pubkey === job.workerKey && (!job.instanceId||worker.instanceId===job.instanceId) && worker.models.includes(job.model) && worker.busy === 0) : rankWorkers(this.workers(), job.model)[0];
    if (!candidate) throw new Error('No trusted worker available for this model');
    const peer = this.byIdentity.get(candidate.pubkey);
    if (!peer || peer.socket.destroyed) throw new Error('Worker disconnected');
    const id = randomUUID(); peer.inFlight++;
    if(candidate.instanceId){peer.instanceInFlight??=new Map();peer.instanceInFlight.set(candidate.instanceId,(peer.instanceInFlight.get(candidate.instanceId)??0)+1);job={...job,instanceId:candidate.instanceId};}
    try {
      return await new Promise((resolve, reject) => {
        const abort = () => { this.pending.delete(id); this.send(peer, { type: 'cancel', id }).catch(() => {}); reject(new Error('Request cancelled or timed out')); };
        this.pending.set(id, { peer, onDelta, bytes: 0, resolve, reject, instanceId:job.instanceId,started: performance.now(), maxTokens: job.maxTokens, model: job.model });
        signal.addEventListener('abort', abort, { once: true });
        // Remove the listener when this request settles, including disconnects.
        const pending = this.pending.get(id);
        pending.resolve = value => { signal.removeEventListener('abort', abort); resolve(value); };
        pending.reject = error => { signal.removeEventListener('abort', abort); reject(error); };
        if (signal.aborted) return abort();
        this.send(peer, { type: 'job', id, job }).catch(error => { this.pending.delete(id); pending.reject(error); });
      });
    } finally { peer.inFlight--; if(candidate.instanceId)peer.instanceInFlight.set(candidate.instanceId,Math.max(0,(peer.instanceInFlight.get(candidate.instanceId)??1)-1)); }
  }
  async close() { clearInterval(this.timer); for (const peer of this.peers.values()) { clearTimeout(peer.handshakeTimer); peer.socket.destroy(); } for (const task of this.active.values()) task.controller.abort(); await this.swarm.destroy(); }
}
