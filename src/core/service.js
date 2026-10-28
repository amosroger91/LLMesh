import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { EnergyMeter } from './energy.js';
import { detectHardware, recommend, catalog, MODEL_MEMORY_FACTOR } from './hardware.js';
import { getPublicKey } from './identity.js';
import { Ledger } from './ledger.js';
import { Mesh } from './mesh.js';
import { planRoute } from './router.js';
import { OllamaPool } from './runtime/pool.js';
import { chooseContribution, CONTRIBUTION } from './contribution.js';
import { quoteWork } from './pricing.js';
import { SettlementQueue } from './settlement.js';
import { GrantAdmission } from './admission.js';

import { validateJob } from './chat-request.js';
export { validateJob } from './chat-request.js';

export class Service extends EventEmitter {
  constructor({ directory, secret, apiKey = randomBytes(32).toString('hex'), topic, allowedWorkers = [], trustedCoordinators = [], network = true, ollama, runtime = {}, placement = {}, payments, requirePayments = true }) {
    super(); mkdirSync(directory, { recursive: true });
    this.pubkey = getPublicKey(secret); this.apiKey = apiKey; this.ollama = ollama ?? new OllamaPool(runtime); this.pool = this.ollama instanceof OllamaPool; this.placementOptions = placement; this.instanceMetrics = {}; this.busy = 0; this.ready = []; this.installing = false;
    this.ledger = new Ledger(join(directory, 'ledger.sqlite'));
    this.energy = new EnergyMeter(join(directory, 'energy.sqlite')); this.payments = payments; this.requirePayments = requirePayments;
    this.paymentJobs = new Set();
    this.reservations = new Map(); this.modelMetrics = {};
    this.ledger.db.exec('CREATE TABLE IF NOT EXISTS worker_payments (id TEXT PRIMARY KEY)');
    this.ledger.db.exec('CREATE TABLE IF NOT EXISTS account_wallets (pubkey TEXT PRIMARY KEY, wallet TEXT NOT NULL)');
    this.ledger.db.exec('CREATE TABLE IF NOT EXISTS onchain_jobs (id TEXT PRIMARY KEY, worker TEXT, state TEXT, tx TEXT, updated INTEGER, network TEXT)');
    if (!this.ledger.db.prepare('PRAGMA table_info(onchain_jobs)').all().some(column => column.name === 'settlement_tx')) this.ledger.db.exec('ALTER TABLE onchain_jobs ADD COLUMN settlement_tx TEXT');
    if (payments) {
      payments.record = job => this.ledger.db.prepare(`INSERT INTO onchain_jobs(id,worker,state,tx,updated,network) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET worker=COALESCE(excluded.worker,worker),state=excluded.state,tx=COALESCE(excluded.tx,tx),updated=excluded.updated`)
        .run(job.id, job.worker ?? null, job.state, job.transaction ?? null, Date.now(), `${payments.state.chainId}:${payments.settings.escrow}`);
      const record = payments.record;
      payments.record = job => { record(job); if (job.state === 'settle-broadcast') this.ledger.db.prepare('UPDATE onchain_jobs SET settlement_tx=? WHERE id=?').run(job.transaction, job.id); };
      payments.lookup = id => this.ledger.db.prepare('SELECT * FROM onchain_jobs WHERE id=?').get(id);
      payments.history = () => this.ledger.db.prepare('SELECT * FROM onchain_jobs ORDER BY updated DESC LIMIT 20').all();
    }
    this.grants = new GrantAdmission(this.ledger.db, { owner: this.pubkey,
      allowed: (process.env.LLMESH_GRANT_ALLOWLIST ?? '').split(',').filter(Boolean), policy: process.env.LLMESH_GRANT_POLICY ?? 'allowlist' });
    this.settlements = new SettlementQueue(this.ledger.db, payments);
    this.ledger.register(this.pubkey);
    this.ledger.db.exec('CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    this.placementOptions={...JSON.parse(this.ledger.db.prepare("SELECT value FROM preferences WHERE key='placement'").get()?.value??'{}'),...placement};
    this.contributionLevel = this.ledger.db.prepare("SELECT value FROM preferences WHERE key='contribution'").get()?.value ?? 'medium';
    if (!CONTRIBUTION[this.contributionLevel]) this.contributionLevel = 'medium';
    this.setup = { state: 'waiting', message: 'Automatic hardware setup will start shortly.' };
    if (network) this.mesh = new Mesh({ secret, topic, allowedWorkers, trustedCoordinators,
      describe: () => ({ models: this.servingModels(), busy: Number(this.draining || this.installing || !this.localSlots().some(slot=>slot.free>0)), slots: this.localSlots(),
        contribution: this.profile?.level ?? this.contributionLevel,
        loadedModel: this.loadedModel, hardware: this.hardwareSummary(),
        wallet: this.payments?.wallet.address, chainId: this.payments?.state.chainId, escrow: this.payments?.settings.escrow }),
      onDelivery: async payment => {
        await this.payments.acceptDelivery(payment);
        this.settlements.save({ id: payment.id, worker: this.pubkey, settlement: 'settle-pending', proof: payment }, this.pubkey);
        this.settlements.enqueue(payment);
      },
      run: async function* (job, signal) {
        await this.acceptWorkerPayment(job);
        try { yield* this.runLocal(job, signal); }
        catch (error) {
          if (job.payment && this.payments) yield { type: 'error', error: error.message, refundAuthorization: await this.payments.signRefund(job.payment) };
          else throw error;
        }
      }.bind(this) });
    if (this.pool) { this.ollama.on('warning', message => this.emit('progress', {status:message})); this.ollama.on('log', entry => this.emit('log', entry)); }
    this.mesh?.on('warning', message => this.emit('progress', { status: message }));
  }
  async acceptWorkerPayment(job) {
    const checked = validateJob(job);
    if (!this.requirePayments) return;
    if (job.payment?.chainId !== this.payments?.state.chainId || job.payment?.escrow?.toLowerCase() !== this.payments?.settings.escrow?.toLowerCase()) throw new Error('Incompatible payment network');
    const pricing = quoteWork(catalog.models.find(model => model.id === checked.model), checked.messages, checked.maxTokens, checked.tools);
    await this.payments.verify(job.payment.id, job.payer, this.payments.wallet.address, pricing.priceUnits);
    try { this.ledger.db.prepare('INSERT INTO worker_payments VALUES (?)').run(job.payment.id); } catch { throw new Error('Worker rejected reused payment'); }
  }
  async initialize() {
    await this.scanHardware();
    await this.refresh(); await this.energy.scan();
    return this.status();
  }
  async scanHardware(level = this.contributionLevel) {
    this.hardware = await detectHardware(); this.recommendation = recommend(this.hardware);
    this.proposedProfile = chooseContribution(this.hardware, level, this.placementOptions); return this.proposedProfile;
  }
  localSlots() {
    if (this.pool) return this.ollama.snapshot().map(instance=>({id:instance.id,model:instance.model,total:instance.slots,free:this.draining||this.installing?0:instance.free,firstTokenMs:instance.metrics.firstTokenMs,tokensPerSecond:instance.metrics.tokensPerSecond}));
    return this.servingModels().map(model=>({id:'legacy',model,total:1,free:this.busy||this.installing||this.draining?0:1,...this.modelMetrics[model]}));
  }
  servingModels() { if(this.pool) return [...new Set(this.ollama.instances.filter(instance=>instance.state==='ready').map(instance=>instance.model.id))]; return this.assignedModel ? this.ready.filter(model => model === this.assignedModel) : this.profile ? [] : this.ready; }
  async configureContribution(level = this.contributionLevel) {
    if (!CONTRIBUTION[level]) { this.setup = { state: 'error', message: 'Choose low, medium, or high contribution' }; return this.status(); }
    this.ledger.db.prepare("INSERT OR REPLACE INTO preferences VALUES ('contribution', ?)").run(level);
    if (this.busy || this.installing || this.reservations.size) {
      this.pendingContribution = level; this.setup = { state: 'queued', message: `${level} contribution will apply after current work finishes.` };
      if (this.installing) this.ollama.cancelInstall?.(); return this.status();
    }
    this.contributionLevel = level; this.pendingContribution = null; this.installing = true;
    this.setup = { state: 'scanning', message: 'Scanning hardware and selecting your model…' };
    try {
      if(this.pool) {
        await this.ollama.stopInstances(); await this.scanHardware(level); this.profile=this.proposedProfile; this.assignedModel=null;
        this.setup={state:'installing',message:this.profile.reason};
        await this.ollama.configure(this.profile.placement,this.hardware,item=>{this.setup={...this.setup,message:item.status,completed:item.completed,total:item.total};this.emit('progress',item);});
        this.ready=this.servingModels(); if(!this.ready.length)throw new Error(this.ollama.instances.map(instance=>instance.error).filter(Boolean).join('; ')||this.profile.reason);
        this.assignedModel=this.loadedModel=this.ready[0];this.profile={...this.profile,model:catalog.models.find(model=>model.id===this.ready[0])};
        this.setup={state:'ready',message:`${this.ready.join(', ')} ready across ${this.ollama.instances.filter(instance=>instance.state==='ready').length} instances.`}; return this.status();
      }
      if (this.loadedModel) await this.ollama.unload?.(this.loadedModel);
      this.loadedModel = null; this.assignedModel = null; await this.scanHardware(level); this.profile = this.proposedProfile;
      if (!this.profile.model) throw new Error(this.profile.reason);
      const selected = this.profile.model;
      const candidates = this.profile.candidates?.length ? this.profile.candidates : catalog.models.filter(model => model.rank <= selected.rank && model.minRamGB <= this.hardware.ramGB && model.memoryGB * MODEL_MEMORY_FACTOR <= this.profile.availableMemoryGB).reverse();
      for (let index = 0; index < candidates.length; index++) {
        this.profile = { ...this.profile, model: candidates[index], reward: quoteWork(candidates[index]).priceUnits };
        if (index) this.profile.reason = `${level.toUpperCase()} contribution: ${this.profile.model.id} selected automatically after the larger model exceeded available memory. From ${this.profile.reward} LLMESH per completion, quoted by model and request budget.`;
        this.ollama.profile = this.profile;
        this.setup = { state: 'installing', model: this.profile.model.id, message: `Automatically preparing ${this.profile.model.id} for ${level} contribution…` };
        try {
          await this.ollama.install(this.profile.model.id, item => {
            this.setup = { ...this.setup, message: item.status, completed: item.completed, total: item.total };
            if (item.status === 'Loading model into memory') this.energy.start(this.profile.model.id + ' / load');
            this.emit('progress', item);
          });
          break;
        } catch (error) {
          if (this.pendingContribution || index === candidates.length - 1 || !/out.of.memory|not enough.*memory|allocate.*memory|insufficient.*memory/i.test(error.message)) throw error;
          await this.ollama.unload?.(this.profile.model.id).catch(() => {});
          if (!this.energy.closed) this.energy.stop();
        }
      }
      this.assignedModel = this.loadedModel = this.profile.model.id; await this.refresh();
      this.setup = { state: 'ready', model: this.assignedModel, message: `${this.assignedModel} ready. From ${this.profile.reward} LLMESH per completion, quoted by model and request budget.` };
    } catch (error) {
      this.setup = this.pendingContribution ? { state: 'queued', message: 'Switching to the new contribution level…' } : { state: 'error', message: error.message };
      if (!this.closed && !this.pendingContribution) this.emit('progress', { status: error.message });
    }
    finally { this.installing = false; if (!this.energy.closed) this.energy.stop(); this.applyPending(); }
    return this.closed ? undefined : this.status();
  }
  applyPending() { if (this.pendingContribution && !this.busy && !this.installing && !this.reservations.size && !this.closed) void this.configureContribution(this.pendingContribution); }
  startContributionManagement(level = this.contributionLevel) {
    void this.configureContribution(level).catch(error => { this.setup = { state: 'error', message: error.message }; });
    clearInterval(this.contributionTimer);
    this.contributionTimer = setInterval(() => {
      if (this.setup.state === 'error' && /memory/i.test(this.setup.message) && !this.busy && !this.installing && !this.reservations.size)
        void this.configureContribution(this.contributionLevel).catch(error => { this.setup = { state: 'error', message: error.message }; });
    }, 30000);
    this.contributionTimer.unref();
  }
  hardwareSummary() {
    if (!this.hardware) return undefined;
    return { mode: this.profile?.mode ?? this.recommendation?.mode, ramGB: this.hardware.ramGB, cores: this.hardware.cores,
      maxModelRank: this.pool ? Math.max(0,...this.ollama.instances.map(instance=>instance.model.rank)) : this.profile?.model?.rank ?? this.recommendation?.capacityModel?.rank ?? 0,
      vramGB: this.hardware.gpus.reduce((sum,gpu)=>sum+(gpu.vramGB??0),0) };
  }
  async refresh() {
    this.ready = (await this.ollama.installed().catch(() => [])).filter(id => catalog.models.some(m => m.id === id));
  }
  status() {
    return { draining: Boolean(this.draining), instances: this.pool ? this.ollama.snapshot() : this.localSlots(), placement: this.profile?.placement ?? this.proposedProfile?.placement, placementOptions:this.placementOptions, pubkey: this.pubkey, hardware: this.hardware, recommendation: this.recommendation, models: catalog.models,
      installed: this.ready, serving: this.servingModels(), assignedModel: this.assignedModel, contribution: this.profile ?? this.proposedProfile,
      contributionLevel: this.contributionLevel, pendingContribution: this.pendingContribution, setup: this.setup,
      currentModel: this.currentModel, lastRoute: this.lastRoute, installing: this.installing, busy: this.busy, workers: this.mesh?.workers() ?? [],
      account: this.ledger.account(this.pubkey), energy: this.energy.status(), payments: this.payments?.status() ?? { configured: false },
      api: this.apiUrl, activeRequests: this.requests ?? 0 };
  }
  async install(id) {
    if (this.busy || this.installing) throw new Error('Node is busy');
    if (!catalog.models.some(m => m.id === id)) throw new Error('Unknown model');
    this.installing = true;
    try { await this.ollama.install(id, item => { if (item.status === 'Loading model into memory') this.energy.start(id + ' / load'); this.emit('progress', item); }); this.loadedModel = id; await this.refresh(); }
    finally { this.installing = false; this.energy.stop(); }
    return this.status();
  }
  async *runLocal(input, signal) {
    const job = validateJob(input);
    if ((!this.pool && this.busy) || this.draining || this.installing || !this.servingModels().includes(job.model)) throw new Error('Local worker unavailable');
    this.busy++;
    this.currentModel = job.model; this.energy.start(job.model);
    const started = performance.now(); let firstAt;
    try {
      for await (const part of this.ollama.chat(job, signal)) {
        if (['delta', 'tool_calls'].includes(part.type) && !firstAt) {
          firstAt = performance.now();
          const metric = this.modelMetrics[job.model] ??= {};
          metric.firstTokenMs = metric.firstTokenMs == null ? firstAt - started : metric.firstTokenMs * 0.7 + (firstAt - started) * 0.3;
        }
        if (part.type === 'done') {
          this.loadedModel = job.model;
          if (firstAt && part.tokens > 0) (this.modelMetrics[job.model] ??= {}).tokensPerSecond = part.tokens / Math.max(0.001, (performance.now() - firstAt) / 1000);
        }
        yield part;
      }
    } finally { this.busy = Math.max(0,this.busy-1); if(!this.busy){this.currentModel = null;this.energy.stop();} this.applyPending(); }
  }
  route(input, _payer = this.pubkey) {
    const job = validateJob(input);
    const candidates = [...(this.mesh?.workers() ?? [])].filter(worker => !this.requirePayments ||
      (this.payments?.state.configured && worker.wallet && worker.chainId === this.payments?.state.chainId && worker.escrow?.toLowerCase() === this.payments?.settings.escrow?.toLowerCase()));
    if(this.pool)for(const instance of this.ollama.snapshot())candidates.push({pubkey:this.pubkey,instanceId:instance.id,models:[instance.model],busy:this.draining||this.installing||instance.free<=0?1:0,free:instance.free,total:instance.slots,
      seen:Date.now(),latencyMs:0,metrics:{[instance.model]:instance.metrics},loadedModel:instance.state==='ready'?instance.model:null,hardware:this.hardwareSummary(),local:true,wallet:this.payments?.wallet.address,contribution:this.contributionLevel});
    else candidates.push({ pubkey: this.pubkey, models: this.servingModels(), contribution: this.profile?.level ?? 'low', busy: Number(Boolean(this.busy || this.installing || this.draining)), seen: Date.now(),
      latencyMs: 0, metrics: this.modelMetrics, loadedModel: this.loadedModel, hardware: this.hardwareSummary(), local: true, wallet: this.payments?.wallet.address });
    for(const candidate of candidates) {
      const key=candidate.pubkey+':'+(candidate.instanceId??'legacy');const reserved=this.reservations.get(key)??0;
      candidate.free=Math.max(0,(candidate.free??1)-reserved);if(!candidate.free)candidate.busy=1;
    }
    try { return planRoute(job, candidates); }
    catch (error) {
      if (!candidates.some(worker => worker.models.length && worker.busy === 0)) {
        throw new Error(`No inference worker is ready. Your node: ${this.setup.message} Other workers may be offline or busy.`, {cause:error});
      }
      throw error;
    }
  }
  async chat(payer, input, onDelta, signal = AbortSignal.timeout(180000), onRoute) {
    let job = validateJob(input);
    if(this.draining)throw Object.assign(new Error('Node is draining'),{retryable:true});
    if (this.requests >= 16) throw new Error('Coordinator at capacity');
    this.requests = (this.requests ?? 0) + 1;
    let id, payment, settled = false, delivered = false, ownsPayment = false, route, reservationHeld = false;
    try {
      let worker, outputTokens = 0, promptTokens = 0, finishReason = 'stop';
      const output = createHash('sha256');
      const forward = delta => { output.update(typeof delta === 'string' ? delta : JSON.stringify(delta)); onDelta(delta); };
      route = this.route(input, payer); const reservation=route.worker+':'+(route.instanceId??'legacy'); this.reservations.set(reservation,(this.reservations.get(reservation)??0)+1); reservationHeld=true; this.lastRoute = route; this.emit('route', route);
      onRoute?.(route);
      const selfServed = payer === this.pubkey && route.worker === this.pubkey && !input.payment;
      const localSettlement = !this.requirePayments || selfServed;
      route.settlement = selfServed ? 'local-self' : this.requirePayments ? 'base-escrow' : 'test-ledger';
      if (localSettlement) id = this.ledger.reserve(payer, route.priceUnits);
      job = { ...job, model: route.model, instanceId:route.instanceId };
      if (!localSettlement) {
        payment = await this.payments?.begin(payer, route.wallet, input.payment, this.pubkey, route.priceUnits);
        if (!payment) throw new Error('Configure Base payments before making requests');
        if (this.paymentJobs.has(payment.id) || this.ledger.db.prepare('SELECT id FROM settlements WHERE id=?').get(payment.id)) throw new Error('Payment already in use or delivered');
        this.paymentJobs.add(payment.id); ownsPayment = true; id = payment.id;
      }
      this.releaseReservation(route); reservationHeld=false;
      if (route.worker === this.pubkey) {
        let completed = false;
        for await (const part of this.runLocal(job, signal)) {
          if (part.type === 'delta') forward(part.text);
          if (part.type === 'tool_calls') forward(part);
          if (part.type === 'done') { delivered = completed = true; outputTokens = part.tokens ?? 0; promptTokens = part.promptTokens ?? 0; finishReason = part.finishReason ?? 'stop'; }
        }
        if (!completed) throw new Error('Incomplete worker response');
        worker = this.pubkey;
      } else { const result = await this.mesh.execute({ ...job, payment, payer, workerKey: route.worker }, forward, signal);
        delivered = true; worker = result.worker; outputTokens = result.tokens ?? 0; promptTokens = result.promptTokens ?? 0; finishReason = result.finishReason ?? 'stop'; }
      // Once done is received, client cancellation must not erase the worker's pay.
      if (!delivered && signal.aborted) throw new Error('Cancelled');
      if (!payment) { this.ledger.settle(id, worker); settled = true; }
      if (payment && this.payments.signDelivery) {
        const outputHash = '0x' + output.digest('hex');
        payment = { ...payment, outputHash, attestation: await this.payments.signDelivery(payment, outputHash) };
        if (worker !== this.pubkey) this.mesh.acknowledge?.(worker, payment);
      }
      const receipt = { id, worker, model: job.model, route, outputTokens, promptTokens, finishReason, credits: route.priceUnits,
        requestedMaxTokens: job.requestedMaxTokens, maxTokens: job.maxTokens, contextTokens: job.contextTokens,
        settlement: payment ? 'settle-pending' : 'settled', ...(payment?.attestation ? { proof: payment } : {}), transaction: null, chainId: payment?.chainId, account: this.ledger.account(payer) };
      this.settlements.save(receipt, payer);
      if (payment) this.settlements.enqueue(payment);
      return receipt;
    } catch (error) {
      if (payment && !delivered && !settled && ownsPayment) {
        try {
          if (error.refundAuthorization) payment.refundAuthorization = error.refundAuthorization;
          else if (route.worker === this.pubkey && this.payments.signRefund) payment.refundAuthorization = await this.payments.signRefund(payment);
          await this.payments.refund(payment);
        } catch (refundError) { error.message += `; escrow refund pending: ${refundError.message}. Payer can refund after the expiry/dispute window.`; }
      } else if (id && !payment && !delivered) this.ledger.cancel(id);
      throw error;
    }
    finally { if(route&&reservationHeld)this.releaseReservation(route); if (ownsPayment) this.paymentJobs.delete(payment.id); this.requests--; this.applyPending(); }
  }
  releaseReservation(route){const key=route.worker+':'+(route.instanceId??'legacy');const count=(this.reservations.get(key)??1)-1;if(count)this.reservations.set(key,count);else this.reservations.delete(key);}
  async configurePlacement(options) {
    this.placementOptions={...this.placementOptions,...options};
    this.ledger.db.prepare("INSERT OR REPLACE INTO preferences VALUES ('placement',?)").run(JSON.stringify(this.placementOptions));
    return this.configureContribution(this.contributionLevel);
  }
  async drain(timeoutMs=30000){this.draining=true;const until=Date.now()+timeoutMs;while((this.busy||this.requests)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));return !(this.busy||this.requests);}
  receipt(id, payer) { return this.settlements.receipt(id, payer); }
  async close() { await this.drain(this.drainTimeoutMs??30000); this.closed = true; this.settlements.close(); clearInterval(this.contributionTimer); await this.mesh?.close(); await this.ollama.close(); this.payments?.close(); this.energy.close(); this.ledger.close(); }
}
