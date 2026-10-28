import {recordInference} from '../../shared/inference-metrics.js';
import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Ollama } from '../ollama.js';
import { defaultCache } from '../model-bundle.js';
export const OLLAMA_VERSION = '0.40.2';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export function instanceEnvironment(instance, cache, hardware) {
  const ids = instance.gpus.map(uuid => hardware.gpus.find(gpu => (gpu.uuid ?? `gpu-${gpu.index}`) === uuid)).filter(Boolean);
  const env = { OLLAMA_HOST: `127.0.0.1:${instance.port}`, OLLAMA_MODELS: cache, OLLAMA_NUM_PARALLEL: String(instance.parallel),
    OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_KEEP_ALIVE: String(instance.keepAlive), OLLAMA_SCHED_SPREAD: instance.mode === 'split' ? '1' : '0', OLLAMA_NO_CLOUD: '1', OLLAMA_CONTEXT_LENGTH: '4096' };
  if (instance.backend === 'cuda') { env.CUDA_VISIBLE_DEVICES = ids.map(gpu=>gpu.uuid).join(','); env.ROCR_VISIBLE_DEVICES = '-1'; env.GGML_VK_VISIBLE_DEVICES = '-1'; }
  else if (instance.backend === 'rocm') {
    env.ROCR_VISIBLE_DEVICES = ids.map(gpu=>gpu.runtimeId ?? gpu.index).join(','); env.HIP_VISIBLE_DEVICES = env.ROCR_VISIBLE_DEVICES;
    env.GGML_VK_VISIBLE_DEVICES = '-1';
  } else if (instance.backend === 'vulkan') { env.GGML_VK_VISIBLE_DEVICES = ids.map(gpu=>gpu.runtimeId ?? gpu.index).join(','); env.CUDA_VISIBLE_DEVICES = '-1'; env.ROCR_VISIBLE_DEVICES = '-1'; }
  else if (instance.backend === 'cpu') { env.CUDA_VISIBLE_DEVICES = '-1'; env.ROCR_VISIBLE_DEVICES = '-1'; env.HIP_VISIBLE_DEVICES = '-1'; env.GGML_VK_VISIBLE_DEVICES = '-1'; }
  return env;
}
export class OllamaPool extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = { runtime: 'managed', parallel: 1, ...options }; this.instances = []; this.downloads = new Map();
    this.cache = options.cache ?? defaultCache(); this.closed = false;
  }
  async configure(placement, hardware, progress = () => {}) {
    if (this.instances.some(instance=>instance.inFlight)) throw new Error('Drain active requests before replanning');
    await this.stopInstances(); this.closed = false; this.placement = placement; this.hardware = hardware;
    let external = this.options.runtime === 'external';
    if (!this.options.explicitRuntime && !external && await new Ollama().available()) {
      external = true; this.emit('warning', 'Existing Ollama on 11434: using external mode without taking ownership');
    }
    let specifications = placement.instances;
    if (external) specifications = (this.options.urls?.length ? this.options.urls : ['http://127.0.0.1:11434']).map((url,index)=>({
      ...(placement.instances[index] ?? placement.instances[0]), id:`external-${index}`, url, external:true
    })).filter(instance=>instance.model);
    this.instances = specifications.map(spec=>({ ...spec, slots: spec.parallel, inFlight: 0, state:'starting', metrics:{}, restartAttempts:0 }));
    await Promise.all(this.instances.map(async instance=>{
      try {
        await this.start(instance);
        for (let index=0;index<instance.candidates.length;index++) {
          instance.model=instance.candidates[index]; instance.client.profile={...instance,mode:instance.backend==='cpu'?'cpu':'gpu'};
          try {
            await this.installOnce(instance,progress); instance.state='ready'; instance.loadedModel=instance.model.id; instance.error=null; break;
          } catch(error) {
            instance.error=error.message; if(this.closed||instance.client.installController?.signal.aborted||index===instance.candidates.length-1)throw error;
            progress({status:`${instance.id}: ${error.message}; trying a smaller model`});
            await instance.client.unload(instance.model.id).catch(()=>{});
          }
        }
      } catch(error) { instance.state='error';instance.error=error.message;progress({status:`${instance.id}: ${error.message}`}); }
    }));
    this.healthTimer=setInterval(()=>{void this.checkHealth();},5000);this.healthTimer.unref();
    return this.snapshot();
  }
  async start(instance) {
    if (instance.external) {
      instance.client=new Ollama(instance.url); instance.client.ensureRunning=async()=>{if(!await instance.client.available())throw new Error('External Ollama is unavailable');};
      await instance.client.ensureRunning(); return;
    }
    const url=`http://127.0.0.1:${instance.port}`;
    const client=instance.client=new Ollama(url);client.cacheDirectory=this.cache;client.bundleDirectory=this.options.bundleDirectory;client.ensureRunning=async()=>{
      if(await client.available())return;throw new Error('Managed Ollama stopped');
    };
    if(await client.available())throw new Error(`Port ${instance.port} is already occupied; choose a different basePort`);
    const local=process.platform==='win32'?join(process.env.LOCALAPPDATA??'','Programs','Ollama','ollama.exe'):'';
    const executable=this.options.executable??(local&&existsSync(local)?local:'ollama');
    const args=this.options.args??['serve'];
    const env={...process.env,...this.options.env,...instanceEnvironment(instance,this.cache,this.hardware)};
    instance.environment=instanceEnvironment(instance,this.cache,this.hardware);
    const child=instance.child=spawn(executable,args,{env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','ignore','pipe']});
    let failure; child.once('error',error=>{failure=error;});
    child.stderr?.on('data',data=>this.emit('log',{instance:instance.id,message:data.toString().slice(0,4000)}));
    child.once('exit',()=>{if(instance.child===child&&!this.closed&&this.instances.includes(instance)){instance.state='error';instance.error='Runtime exited';this.scheduleRestart(instance);}});
    for(let i=0;i<100;i++) {
      if(failure)throw new Error(`Ollama is missing or cannot start: ${failure.message}. Install Ollama ${OLLAMA_VERSION}, then retry.`);
      if(await client.available()) {
        const version=(await (await client.request('/api/version')).json()).version;
        instance.version=version;if(!this.options.skipVersionCheck&&version!==OLLAMA_VERSION){await this.stopChild(instance);throw new Error(`Managed runtime requires Ollama ${OLLAMA_VERSION}; found ${version}. Use external mode to manage another version yourself.`);}return;
      }
      if(this.closed)throw new Error('Runtime startup cancelled');await pause(100);
    }
    await this.stopChild(instance);throw new Error(`${instance.id}: Ollama did not become healthy`);
  }
  async installOnce(instance,progress) {
    const id=instance.model.id, key=id;
    if(!this.downloads.has(key)) {
      const download=(async()=>{
        // Ollama's blob cache is shared. Only one endpoint pulls/imports each model.
        await instance.client.install(id,item=>progress({...item,instance:instance.id}));
      })();this.downloads.set(key,download);download.catch(()=>this.downloads.delete(key));
      await download;
    } else { await this.downloads.get(key); await instance.client.warm(id); }
    if(instance.external) {
      const shown=await (await instance.client.request('/api/show',{model:id})).json().catch(()=>({}));
      if(['qwen35','qwen35moe'].includes(shown.details?.family))instance.slots=1;
    }
  }
  scheduleRestart(instance) {
    if(instance.external||instance.restartTimer||this.closed)return;
    instance.restartTimer=setTimeout(()=>{instance.restartTimer=null;void this.restart(instance.id).catch(error=>{instance.error=error.message;this.scheduleRestart(instance);});},Math.min(30000,500*2**Math.min(instance.restartAttempts++,6)));
    instance.restartTimer.unref();
  }
  async checkHealth(){if(this.closed||this.checking)return;this.checking=true;try{await Promise.all(this.instances.map(async instance=>{
    if(instance.state==='ready'&&!await instance.client.available()){instance.state='error';instance.error='Health check failed';this.scheduleRestart(instance);}
    else if(instance.external&&instance.state==='error'&&await instance.client?.available()){await instance.client.warm(instance.model.id).then(()=>{instance.state='ready';}).catch(()=>{});}
  }));}finally{this.checking=false;}}
  async restart(id){const instance=this.instances.find(item=>item.id===id);if(!instance)throw new Error('Unknown runtime instance');if(instance.inFlight)throw new Error('Instance has active requests');
    clearTimeout(instance.restartTimer);instance.restartTimer=null;instance.state='starting';await this.stopChild(instance);await this.start(instance);
    instance.client.profile={...instance,mode:instance.backend==='cpu'?'cpu':'gpu'};await instance.client.warm(instance.model.id);instance.state='ready';instance.error=null;
  }
  snapshot(){return this.instances.map(({client:_client,child:_child,restartTimer:_timer,...instance})=>({...instance,model:instance.model.id,free:instance.state==='ready'?Math.max(0,instance.slots-instance.inFlight):0}));}
  async *chat(job,signal){const instance=this.instances.find(item=>(!job.instanceId||item.id===job.instanceId)&&item.model.id===job.model&&item.state==='ready'&&item.inFlight<item.slots);
    if(!instance)throw Object.assign(new Error('No runtime slot available'),{retryable:true});instance.inFlight++;const started=performance.now();let firstAt;
    try{for await(const part of instance.client.chat(job,signal)){if(!firstAt&&['delta','tool_calls'].includes(part.type)){firstAt=performance.now();}
      if(part.type==='done'&&firstAt)recordInference(instance.metrics,{firstTokenMs:firstAt-started,tokens:part.tokens,durationMs:performance.now()-started});yield part;}
    }finally{instance.inFlight--;}
  }
  async installed(){const lists=await Promise.all(this.instances.map(instance=>instance.client?.installed().catch(()=>[])??[]));return [...new Set(lists.flat())];}
  cancelInstall(){for(const instance of this.instances)instance.client?.cancelInstall();}
  async stopChild(instance){const child=instance.child;instance.child=null;if(!child?.pid||child.exitCode!=null)return;
    if(process.platform==='win32'){ await promisify(execFile)('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>child.kill()); if(child.exitCode==null)await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(1500)]); }
    else{try{process.kill(-child.pid,'SIGTERM');}catch{}await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(1500)]);if(child.exitCode==null)try{process.kill(-child.pid,'SIGKILL');}catch{}}
  }
  async stopInstances(){clearInterval(this.healthTimer);for(const instance of this.instances){clearTimeout(instance.restartTimer);instance.client?.cancelInstall();}await Promise.all(this.instances.map(instance=>this.stopChild(instance)));this.downloads.clear();}
  async close(){this.closed=true;await this.stopInstances();}
}
