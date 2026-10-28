import {recordInference} from '../shared/inference-metrics.js';
import {memoryFailure} from '../shared/memory-status.js';
import {nodeProfile} from '../shared/node-profile.js';
import {ProviderPool} from './providers.js';
import { BrowserWorkers } from './browser-workers.js';
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
import { quoteWork, usageCredits } from './pricing.js';
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
    this.providers = new ProviderPool(this.ledger.db); this.browserWorkers = new BrowserWorkers(); this.paymentJobs = new Set();
    this.reservations = new Map(); this.modelMetrics = {};
    this.ledger.db.exec('CREATE TABLE IF NOT EXISTS worker_payments (id TEXT PRIMARY KEY)');
    if (!this.ledger.db.prepare('PRAGMA table_info(worker_payments)').all().some(column => column.name === 'credits')) this.ledger.db.exec('ALTER TABLE worker_payments ADD COLUMN credits INTEGER');
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
    this.nodeProfile=nodeProfile(JSON.parse(this.ledger.db.prepare("SELECT value FROM preferences WHERE key='node_profile'").get()?.value??'{}'),'Desktop node');
    const savedPrivacy=this.ledger.db.prepare("SELECT value FROM preferences WHERE key='inference_privacy'").get()?.value;
    this.inferencePrivacy=['mesh-only','allow-third-party'].includes(savedPrivacy)?savedPrivacy:'mesh-only';
    this.contributionLevel = this.ledger.db.prepare("SELECT value FROM preferences WHERE key='contribution'").get()?.value ?? 'medium';
    if (!CONTRIBUTION[this.contributionLevel]) this.contributionLevel = 'medium';
    this.setup = { state: 'waiting', message: 'Automatic hardware setup will start shortly.' };
    if (network) this.mesh = new Mesh({ secret, topic, allowedWorkers, trustedCoordinators,
      describe: () => ({ working:Boolean(this.busy), memoryBlocked:this.setup.state==='error'&&memoryFailure(this.setup.message), profile:this.nodeProfile, models: this.servingModels(), busy: Number(this.draining || !this.localSlots().some(slot=>slot.free>0)), slots: this.localSlots(), devices: this.browserWorkers.snapshot().map(device=>({id:device.id,name:device.name,profile:device.profile,model:device.engineModel||device.model,ready:device.state==='ready',disabled:device.state==='paused',memoryBlocked:device.memoryBlocked===true,busy:Boolean(device.busy)})),
        contribution: this.profile?.level ?? this.contributionLevel,
        loadedModel: this.loadedModel, hardware: this.hardwareSummary(),
        wallet: this.payments?.wallet.address, chainId: this.payments?.state.chainId, escrow: this.payments?.settings.escrow }),
      onDelivery: async payment => {
        await this.payments.acceptDelivery(payment);
        const usage = this.ledger.db.prepare('SELECT credits FROM worker_payments WHERE id=?').get(payment.id);
        if (!usage || usage.credits !== payment.credits) throw new Error('Delivery usage does not match worker accounting');
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
    const pricing = quoteWork(catalog.models.find(model => model.id === checked.model)??this.providers.model(checked.model), checked.messages, checked.maxTokens, checked.tools, checked.contextTokens);
    await this.payments.verify(job.payment.id, job.payer, this.payments.wallet.address, pricing.priceUnits);
    try { this.ledger.db.prepare('INSERT INTO worker_payments(id) VALUES (?)').run(job.payment.id); } catch { throw new Error('Worker rejected reused payment'); }
  }
  configureNodeProfile(value){this.nodeProfile=nodeProfile(value,'Desktop node');this.ledger.db.prepare("INSERT OR REPLACE INTO preferences VALUES ('node_profile', ?)").run(JSON.stringify(this.nodeProfile));return this.nodeProfile;}
  configurePrivacy(value){
    if(!['mesh-only','allow-third-party'].includes(value))throw new Error('Invalid inference privacy mode');
    this.ledger.db.prepare("INSERT OR REPLACE INTO preferences VALUES ('inference_privacy', ?)").run(value);this.inferencePrivacy=value;return {inferencePrivacy:value};
  }
  requestPolicy(input,payer){return payer===this.pubkey&&input?.privacy==null&&input?.allow_third_party==null?{...input,privacy:this.inferencePrivacy}:input;}
  async initialize() {
    await this.scanHardware();
    await this.refresh(); await this.energy.scan();
    return this.status();
  }
  async scanHardware(level = this.contributionLevel, options = {}) {
    this.hardware = await detectHardware(); this.recommendation = recommend(this.hardware);
    this.proposedProfile = chooseContribution(this.hardware, level, {...this.placementOptions,...options}); return this.proposedProfile;
  }
  nativeSlots() {
    if (this.pool) return this.ollama.snapshot().map(instance=>({id:instance.id,model:instance.model,total:instance.slots,free:this.draining||this.installing?0:instance.free,firstTokenMs:instance.metrics.firstTokenMs,tokensPerSecond:instance.metrics.tokensPerSecond}));
    return this.nativeModels().map(model=>({id:'legacy',model,total:1,free:this.localEnergyJobs||this.installing||this.draining?0:1,...this.modelMetrics[model]}));
  }
  localSlots() { return [...this.nativeSlots(),...this.browserWorkers.snapshot().map(instance=>({id:instance.id,model:instance.model,total:1,free:this.draining?0:instance.free,...instance.metrics,supportsTools:instance.supportsTools,maxContextTokens:4096,source:instance.community?'community':undefined})),...this.providers.snapshot().map(instance=>({id:instance.id,model:instance.model,total:1,free:this.draining?0:instance.free,source:'third-party',modelInfo:instance.modelInfo,creditBudget:instance.remainingCredits,requestTokenLimit:instance.requestTokenLimit,...instance.metrics}))]; }
  servingModels() { return [...new Set([...this.nativeModels(),...this.browserWorkers.snapshot().filter(instance=>instance.state==='ready').map(instance=>instance.model),...this.providers.snapshot().filter(instance=>instance.free).map(instance=>instance.model)])]; }
  nativeModels() { if(this.pool) return [...new Set(this.ollama.instances.filter(instance=>instance.state==='ready').map(instance=>instance.model.id))]; return this.assignedModel ? this.ready.filter(model => model === this.assignedModel) : this.profile ? [] : this.ready; }
  async configureContribution(level = this.contributionLevel, options = {}) {
    if(options.forceMemory&&(this.busy||this.installing||this.reservations.size))throw new Error('Finish active requests and setup before forcing a model load');
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
        await this.ollama.stopInstances(); await this.scanHardware(level,options); this.profile=this.proposedProfile; this.assignedModel=null;
        this.setup={state:'installing',message:this.profile.reason};
        await this.ollama.configure(this.profile.placement,this.hardware,item=>{this.setup={...this.setup,message:item.status,completed:item.completed,total:item.total};this.emit('progress',item);});
        this.ready=this.nativeModels(); if(!this.ready.length)throw new Error(this.ollama.instances.map(instance=>instance.error).filter(Boolean).join('; ')||this.profile.reason);
        this.assignedModel=this.loadedModel=this.ready[0];this.profile={...this.profile,model:catalog.models.find(model=>model.id===this.ready[0])};
        this.setup={state:'ready',message:`${this.ready.join(', ')} ready across ${this.ollama.instances.filter(instance=>instance.state==='ready').length} instances.`}; return this.status();
      }
      if (this.loadedModel) await this.ollama.unload?.(this.loadedModel);
      this.loadedModel = null; this.assignedModel = null; await this.scanHardware(level,options); this.profile = this.proposedProfile;
      if (!this.profile.model) throw new Error(this.profile.reason);
      const selected = this.profile.model;
      const candidates = this.profile.candidates?.length ? this.profile.candidates : catalog.models.filter(model => model.rank <= selected.rank && model.minRamGB <= this.hardware.ramGB && model.memoryGB * MODEL_MEMORY_FACTOR <= this.profile.availableMemoryGB).reverse();
      for (let index = 0; index < candidates.length; index++) {
        this.profile = { ...this.profile, model: candidates[index], reward: 1 };
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
      maxModelRank: this.pool ? Math.max(0,...this.ollama.instances.map(instance=>instance.model.rank),...this.browserWorkers.snapshot().filter(instance=>instance.free).map(()=>1),...this.providers.snapshot().filter(instance=>instance.free).map(instance=>instance.modelInfo.rank)) : this.profile?.model?.rank ?? this.recommendation?.capacityModel?.rank ?? 0,
      vramGB: this.hardware.gpus.reduce((sum,gpu)=>sum+(gpu.vramGB??0),0) };
  }
  async refresh() {
    this.ready = (await this.ollama.installed().catch(() => [])).filter(id => catalog.models.some(m => m.id === id));
  }
  topology() {
    const nodes=[{id:this.pubkey,name:this.nodeProfile.name,profile:this.nodeProfile,kind:'desktop',connected:true,disabled:this.draining||this.setup.state==='error',memoryBlocked:this.nativeModels().length===0&&this.setup.state==='error'&&memoryFailure(this.setup.message),ready:!this.draining&&(this.nativeModels().length>0||this.providers.snapshot().some(provider=>provider.state==='ready')),busy:Boolean(this.busy),model:this.currentModel??this.assignedModel}],edges=[];
    const add=(node,parent)=>{if(nodes.length>=200||nodes.some(item=>item.id===node.id))return;nodes.push(node);edges.push({from:parent,to:node.id});};
    for(const worker of this.mesh?.workers()??[]){add({id:worker.pubkey,name:worker.profile?.name??worker.pubkey.slice(0,10),profile:worker.profile,kind:'peer',connected:true,memoryBlocked:worker.memoryBlocked===true,ready:worker.models.length>0,busy:worker.working===true,model:worker.models[0]},this.pubkey);
      for(const device of worker.devices??[])add({...device,kind:'browser'},worker.pubkey);}
    for(const device of this.browserWorkers.snapshot())add({id:device.id,name:device.name,profile:device.profile,kind:'browser',connected:true,ready:device.state==='ready',disabled:device.state==='paused',memoryBlocked:device.memoryBlocked===true,busy:Boolean(device.busy),model:device.engineModel||device.state},this.pubkey);
    for(const provider of this.providers.snapshot())if(provider.state==='ready')add({id:provider.id,name:provider.provider+' API',kind:'provider',state:provider.state,busy:Boolean(provider.busy),model:provider.upstreamModel},this.pubkey);
    return {nodes,edges,scope:'Known trusted peers and linked browser devices'};
  }
  status() {
    return { nodeProfile:this.nodeProfile,inferencePrivacy:this.inferencePrivacy, draining: Boolean(this.draining), donations: this.providers.snapshot(), browserDevices: this.browserWorkers.snapshot(), topology: this.topology(), instances: this.pool ? this.ollama.snapshot() : this.nativeSlots(), placement: this.profile?.placement ?? this.proposedProfile?.placement, placementOptions:this.placementOptions, pubkey: this.pubkey, hardware: this.hardware, recommendation: this.recommendation, models: [...catalog.models,...this.providers.snapshot().map(provider=>provider.modelInfo)],
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
    const browser = job.instanceId?.startsWith('web-'),donated=job.instanceId?.startsWith('api-'),auxiliary=browser||donated;
    if(donated&&job.hardwareOnly)throw new Error('Hardware-only requests cannot use donated APIs');
    if(donated&&job.privacy!=='allow-third-party')throw new Error('Requester did not allow third-party APIs');
    if ((!auxiliary && !this.pool && this.localEnergyJobs) || this.draining || (!auxiliary && this.installing) || !this.servingModels().includes(job.model)) throw new Error('Local worker unavailable');
    this.busy++;
    this.currentModel = job.model; if(!auxiliary){this.localEnergyJobs=(this.localEnergyJobs??0)+1;this.energy.start(job.model);}
    const started = performance.now(); let firstAt;
    try {
      for await (const part of (browser ? this.browserWorkers : donated ? this.providers : this.ollama).chat(job, signal)) {
        if (['delta', 'tool_calls'].includes(part.type) && !firstAt) {
          firstAt = performance.now();

        }
        if (part.type === 'done') {
          const credits = usageCredits(part.promptTokens ?? 0, part.tokens ?? 0);
          if (part.tokens > job.maxTokens || part.promptTokens > job.contextTokens) throw new Error('Runtime exceeded token budget');
          if (input.payment) this.ledger.db.prepare('UPDATE worker_payments SET credits=? WHERE id=?').run(credits, input.payment.id);
          if(!auxiliary)this.loadedModel = job.model;
          if(!auxiliary&&firstAt)recordInference(this.modelMetrics[job.model]??={}, {firstTokenMs:firstAt-started,tokens:part.tokens,durationMs:performance.now()-started});
        }
        yield part;
      }
    } finally { this.busy = Math.max(0,this.busy-1); if(!this.busy)this.currentModel = null;if(!auxiliary){this.localEnergyJobs--;if(!this.localEnergyJobs)this.energy.stop();} this.applyPending(); }
  }
  route(input, payer = this.pubkey, includeBusy = false, avoid=new Set()) {
    input=this.requestPolicy(input,payer);
    const job = validateJob(input);
    const candidates = [...(this.mesh?.workers() ?? [])].filter(worker => !this.requirePayments ||
      (this.payments?.state.configured && worker.wallet && worker.chainId === this.payments?.state.chainId && worker.escrow?.toLowerCase() === this.payments?.settings.escrow?.toLowerCase()));
    if(this.pool)for(const instance of this.ollama.snapshot())candidates.push({pubkey:this.pubkey,instanceId:instance.id,models:[instance.model],busy:this.draining||this.installing||instance.free<=0?1:0,free:instance.free,total:instance.slots,
      seen:Date.now(),latencyMs:0,metrics:{[instance.model]:instance.metrics},loadedModel:instance.state==='ready'?instance.model:null,hardware:this.hardwareSummary(),local:true,wallet:this.payments?.wallet.address,contribution:this.contributionLevel});
    else candidates.push({ pubkey: this.pubkey, models: this.nativeModels(), contribution: this.profile?.level ?? 'low', busy: Number(Boolean(this.localEnergyJobs || this.installing || this.draining)), seen: Date.now(),
      latencyMs: 0, metrics: this.modelMetrics, loadedModel: this.loadedModel, hardware: this.hardwareSummary(), local: true, wallet: this.payments?.wallet.address });
    for(const instance of this.browserWorkers.snapshot())candidates.push({pubkey:this.pubkey,instanceId:instance.id,models:[instance.model],busy:this.draining||!instance.free?1:0,free:instance.free,seen:Date.now(),latencyMs:5,metrics:{[instance.model]:instance.metrics},hardware:{mode:'gpu',maxModelRank:1},local:true,supportsTools:instance.supportsTools,maxContextTokens:4096,source:instance.community?'community':undefined,wallet:this.payments?.wallet.address});
    for(const instance of this.providers.snapshot())candidates.push({pubkey:this.pubkey,instanceId:instance.id,models:[instance.model],modelCatalog:[instance.modelInfo],source:'third-party',creditBudget:instance.remainingCredits,requestTokenLimit:instance.requestTokenLimit,unavailableReason:instance.state==='ready'?undefined:instance.provider+' '+instance.upstreamModel+': '+instance.state+(instance.error?' ('+instance.error+')':''),busy:this.draining||!instance.free?1:0,free:instance.free,total:1,seen:Date.now(),latencyMs:0,metrics:{[instance.model]:instance.metrics},local:true,wallet:this.payments?.wallet.address});
    for(const candidate of candidates) {
      const key=candidate.pubkey+':'+(candidate.instanceId??'legacy');const reserved=this.reservations.get(key)??0;
      candidate.free=Math.max(0,(candidate.free??1)-reserved);if(!candidate.free)candidate.busy=1;
      if(includeBusy){candidate.busy=0;candidate.free=1;}
    }
    try { return planRoute(job, candidates.filter(candidate=>!avoid.has(candidate.pubkey+':'+candidate.instanceId))); }
    catch (error) {
      if (!candidates.some(worker => worker.models.length && worker.busy === 0)) {
        throw new Error(`No inference worker is ready. Your node: ${this.setup.message} ${this.browserWorkers.snapshot().length} browser devices connected; ${this.browserWorkers.snapshot().filter(device=>device.free>0).length} ready. Public discovery is not a worker connection. Keep the phone tab visible, load its model, and connect it to this desktop. Guest workers require privacy: allow-third-party; paired trusted workers can serve mesh-only requests.`, {cause:error});
      }
      if(this.setup.state!=='ready')throw new Error(`${error.message} Your native node: ${this.setup.message}`,{cause:error});
      throw error;
    }
  }
  async waitForRoute(input,payer,signal,avoid=new Set()){
    for(;;){
      signal.throwIfAborted();if(this.closed||this.draining)throw new Error('Node is draining');
      try{return this.route(input,payer,false,avoid);}catch(error){
        if(!(this.busy||this.reservations.size||this.browserWorkers.snapshot().some(device=>device.busy)||this.mesh?.workers().some(worker=>worker.busy)))throw error;
        // Wait only when a currently occupied slot could actually handle this job.
        try{this.route(input,payer,true,avoid);}catch{throw error;}
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    }
  }
  async swarm(payer,tasks,{maxConcurrency=16,signal=AbortSignal.timeout(180000),onEvent=()=>{}}={}){
    if(!Array.isArray(tasks)||!tasks.length||tasks.length>32||!Number.isInteger(maxConcurrency)||maxConcurrency<1||maxConcurrency>16)throw new Error('Use 1–32 tasks and concurrency 1–16');
    tasks.forEach(validateJob);
    const slots=this.localSlots().reduce((sum,slot)=>sum+slot.total,0)+(this.mesh?.workers()??[]).reduce((sum,worker)=>sum+(worker.total??1),0);
    const width=Math.min(maxConcurrency,tasks.length,Math.max(1,slots));let next=0;const results=new Array(tasks.length);
    await Promise.all(Array.from({length:width},async()=>{for(;;){const index=next++;if(index>=tasks.length)return;signal.throwIfAborted();onEvent({type:'started',index});
      try{results[index]={ok:true,receipt:await this.chat(payer,tasks[index],delta=>onEvent({type:'delta',index,delta}),signal,route=>onEvent({type:'route',index,route}))};}
      catch(error){results[index]={ok:false,error:error.message};}
      onEvent({type:'finished',index,...results[index]});
    }}));return {object:'llmesh.swarm',agents:width,results};
  }
  async chat(payer,input,onDelta,signal=AbortSignal.timeout(180000),onRoute){
    const avoid=new Set();for(;;){try{return await this.chatAttempt(payer,input,onDelta,signal,onRoute,avoid);}catch(error){
      if(!error.providerRejected||!error.providerInstance||payer!==this.pubkey||input.payment||!['auto','llmesh-auto'].includes(input.model)||avoid.size>=8)throw error;
      avoid.add(this.pubkey+':'+error.providerInstance);try{this.route(input,payer,false,avoid);}catch{throw error;}
    }}
  }
  async chatAttempt(payer, input, onDelta, signal, onRoute, avoid) {
    input=this.requestPolicy(input,payer);
    let job = validateJob(input);signal.throwIfAborted();
    if(this.draining)throw Object.assign(new Error('Node is draining'),{retryable:true});
    if (this.requests >= 16) throw new Error('Coordinator at capacity');
    this.requests = (this.requests ?? 0) + 1;
    let id, payment, settled = false, delivered = false, ownsPayment = false, route, reservationHeld = false;
    try {
      let worker, outputTokens = 0, promptTokens = 0, finishReason = 'stop';
      const output = createHash('sha256');
      const forward = delta => { output.update(typeof delta === 'string' ? delta : JSON.stringify(delta)); onDelta(delta); };
      // Reserve immediately after synchronous selection. Only yield while waiting
      // for occupied slots, so concurrent coordinators cannot choose the same slot.
      for(;;){
        try{route=this.route(input,payer,false,avoid);break;}catch(error){await this.waitForRoute(input,payer,signal,avoid);if(signal.aborted)throw error;}
      }
      const reservation=route.worker+':'+(route.instanceId??'legacy'); this.reservations.set(reservation,(this.reservations.get(reservation)??0)+1); reservationHeld=true; this.lastRoute = route; this.emit('route', route);
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
      const credits = usageCredits(promptTokens, outputTokens, route.priceUnits);
      if (outputTokens > job.maxTokens || promptTokens > job.contextTokens) throw new Error('Worker exceeded token budget');
      if (!payment) { this.ledger.settle(id, worker, credits); settled = true; }
      if (payment) payment = { ...payment, credits, promptTokens, outputTokens };
      if (payment && this.payments.signDelivery) {
        const outputHash = '0x' + output.digest('hex');
        payment = { ...payment, outputHash, attestation: await this.payments.signDelivery(payment, outputHash) };
        if (worker !== this.pubkey) this.mesh.acknowledge?.(worker, payment);
      }
      const receipt = { id, worker, model: job.model, route, outputTokens, promptTokens, finishReason, credits,
        adaptation:job.adaptation,billingVersion: 'token-usage-v1', reservedCredits: route.priceUnits, refundedCredits: route.priceUnits - credits,
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
  async close() { await this.drain(this.drainTimeoutMs??30000); this.closed = true; this.settlements.close(); clearInterval(this.contributionTimer); await this.mesh?.close(); await this.ollama.close(); this.payments?.close(); this.providers.close(); this.browserWorkers.close(); this.energy.close(); this.ledger.close(); }
}
