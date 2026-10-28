import {recordInference,publicMetrics} from '../shared/inference-metrics.js';
import {nodeProfile} from '../shared/node-profile.js';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {usageCredits, creditAtomsPerToken} from './pricing.js';

export class BrowserWorkers extends EventEmitter {
  constructor(){super();this.devices=new Map();this.tasks=new Map();this.timer=setInterval(()=>this.expire(),5000);this.timer.unref();}
  register(id,name,community=false,harvest=!community){if(!/^[a-f0-9]{64}$/.test(id)||this.devices.size>=16)throw new Error('Invalid device or device limit reached');
    this.devices.set(id,{id:'web-'+id,name:String(name).slice(0,60),deviceId:id,model:'qwen3.5:0.8b',state:'paired',busy:0,lastSeen:Date.now(),engine:'WebLLM',supportsTools:false,metrics:{},community,harvest});}
  report(id,event){const device=this.devices.get(id);if(!device)throw new Error('Device is not approved');device.lastSeen=Date.now();
    if(event.type==='heartbeat')return;
    if(event.type==='harvest'){if(device.community||typeof event.enabled!=='boolean')throw new Error('Pair a trusted desktop before changing harvesting');device.harvest=event.enabled;return;}
    if(event.type==='state'){device.calibration=publicMetrics(event.metrics); if(!['paired','loading','ready','paused','error'].includes(event.state))throw new Error('Invalid browser state');if(event.profile){device.profile=nodeProfile(event.profile);device.name=device.profile.name;}device.state=event.state;device.memoryBlocked=event.memoryBlocked===true;device.supportsTools=event.supportsTools===true&&event.toolAdapter==='json-schema-v1';device.engineModel=String(event.engineModel??'').slice(0,100);return;}
    const task=this.tasks.get(event.id);if(!task)return;if(task.deviceId!==id)throw new Error('Wrong browser request owner');
    if(['delta','tool_calls'].includes(event.type)&&!task.firstAt){task.firstAt=performance.now();task.buffered=event.type==='tool_calls';}
    if(event.type==='delta'){if(typeof event.text!=='string'||(task.bytes+=Buffer.byteLength(event.text))>262144)throw new Error('Browser response too large');task.queue.push({type:'delta',text:event.text});}
    else if(event.type==='tool_calls'){if(!device.supportsTools||!Array.isArray(event.calls)||!event.calls.length||event.calls.length>8)throw new Error('Invalid browser tool calls');const names=new Set((task.job.tools??[]).map(tool=>tool.function.name));for(const call of event.calls){if(!names.has(call.function?.name)||typeof call.function.arguments!=='string'||!call.id||call.id.length>200)throw new Error('Invalid browser tool call');const args=JSON.parse(call.function.arguments);if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Invalid browser tool arguments');}if((task.bytes+=Buffer.byteLength(JSON.stringify(event.calls)))>262144)throw new Error('Browser response too large');task.queue.push({type:'tool_calls',calls:event.calls});}
    else if(event.type==='done'){const atoms=creditAtomsPerToken({parametersB:0.8},{instanceId:task.job.instanceId,source:'web'});usageCredits(event.promptTokens,event.tokens,(task.job.contextTokens+task.job.maxTokens)*atoms,atoms);if(event.tokens>task.job.maxTokens||event.promptTokens>task.job.contextTokens)throw new Error('Browser exceeded token budget');if(task.firstAt)recordInference(device.metrics,{firstTokenMs:task.firstAt-task.started,tokens:event.tokens,durationMs:performance.now()-task.started,buffered:task.buffered});task.queue.push({type:'done',tokens:event.tokens,promptTokens:event.promptTokens,finishReason:event.finishReason});task.done=true;}
    else if(event.type==='error'){task.error=new Error(String(event.error).slice(0,400));task.done=true;}
    else throw new Error('Invalid browser event');task.wake?.();
  }
  remove(id){this.devices.delete(id);for(const task of this.tasks.values())if(task.deviceId===id){task.error=new Error('Browser worker disconnected');task.done=true;task.wake?.();}}
  expire(){for(const [id,device]of this.devices)if(Date.now()-device.lastSeen>30000)this.remove(id);}
  snapshot(){return [...this.devices.values()].map(device=>({...device,slots:1,free:device.state==='ready'&&!device.busy?1:0,metrics:{...device.calibration,...device.metrics},backend:'webgpu',gpus:[]}));}
  async *chat(job,signal){const device=[...this.devices.values()].find(device=>device.id===job.instanceId&&device.state==='ready'&&!device.busy);if(!device)throw new Error('Browser worker is unavailable');
    if(device.community&&job.privacy!=='allow-third-party')throw new Error('Community workers require explicit external-worker consent');
    if(job.tools?.length&&!device.supportsTools)throw new Error('Browser model has not passed its tool-calling self-test');
    if(job.contextTokens>4096)throw new Error('Browser worker context limit is 4096 tokens');
    const id=randomUUID(),task={deviceId:device.deviceId,queue:[],bytes:0,job,started:performance.now()};this.tasks.set(id,task);device.busy=1;
    const abort=()=>{task.error=new Error('Browser inference cancelled');task.done=true;task.wake?.();this.emit('send',{deviceId:device.deviceId,message:{type:'cancel',id}});};
    signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,180000);
    try{signal.throwIfAborted();this.emit('send',{deviceId:device.deviceId,message:{type:'job',id,job}});
      while(!task.done||task.queue.length){if(task.queue.length)yield task.queue.shift();else await new Promise(resolve=>{task.wake=resolve;});}
      if(task.error)throw task.error;
    }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);this.tasks.delete(id);device.busy=0;}
  }
  close(){clearInterval(this.timer);for(const id of this.devices.keys())this.remove(id);}
}
