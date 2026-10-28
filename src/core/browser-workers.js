import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {usageCredits} from './pricing.js';

export class BrowserWorkers extends EventEmitter {
  constructor(){super();this.devices=new Map();this.tasks=new Map();this.timer=setInterval(()=>this.expire(),5000);this.timer.unref();}
  register(id,name,community=false){if(!/^[a-f0-9]{64}$/.test(id)||this.devices.size>=16)throw new Error('Invalid device or device limit reached');
    this.devices.set(id,{id:'web-'+id,name:String(name).slice(0,60),deviceId:id,model:'qwen3.5:0.8b',state:'paired',busy:0,lastSeen:Date.now(),engine:'WebLLM',community});}
  report(id,event){const device=this.devices.get(id);if(!device)throw new Error('Device is not approved');device.lastSeen=Date.now();
    if(event.type==='heartbeat')return;
    if(event.type==='state'){if(!['paired','loading','ready','paused','error'].includes(event.state))throw new Error('Invalid browser state');device.state=event.state;device.engineModel=String(event.engineModel??'').slice(0,100);return;}
    const task=this.tasks.get(event.id);if(!task)return;if(task.deviceId!==id)throw new Error('Wrong browser request owner');
    if(event.type==='delta'){if(typeof event.text!=='string'||(task.bytes+=Buffer.byteLength(event.text))>262144)throw new Error('Browser response too large');task.queue.push({type:'delta',text:event.text});}
    else if(event.type==='done'){usageCredits(event.promptTokens,event.tokens,task.job.contextTokens+task.job.maxTokens);if(event.tokens>task.job.maxTokens||event.promptTokens>task.job.contextTokens)throw new Error('Browser exceeded token budget');task.queue.push({type:'done',tokens:event.tokens,promptTokens:event.promptTokens,finishReason:event.finishReason});task.done=true;}
    else if(event.type==='error'){task.error=new Error(String(event.error).slice(0,400));task.done=true;}
    else throw new Error('Invalid browser event');task.wake?.();
  }
  remove(id){this.devices.delete(id);for(const task of this.tasks.values())if(task.deviceId===id){task.error=new Error('Browser worker disconnected');task.done=true;task.wake?.();}}
  expire(){for(const [id,device]of this.devices)if(Date.now()-device.lastSeen>30000)this.remove(id);}
  snapshot(){return [...this.devices.values()].map(device=>({...device,slots:1,free:device.state==='ready'&&!device.busy?1:0,metrics:{},backend:'webgpu',gpus:[]}));}
  async *chat(job,signal){const device=[...this.devices.values()].find(device=>device.id===job.instanceId&&device.state==='ready'&&!device.busy);if(!device)throw new Error('Browser worker is unavailable');
    if(device.community&&job.privacy!=='allow-third-party')throw new Error('Community workers require explicit external-worker consent');
    if(job.tools?.length)throw new Error('Browser model does not support tools');
    if(job.contextTokens>4096)throw new Error('Browser worker context limit is 4096 tokens');
    const id=randomUUID(),task={deviceId:device.deviceId,queue:[],bytes:0,job};this.tasks.set(id,task);device.busy=1;
    const abort=()=>{task.error=new Error('Browser inference cancelled');task.done=true;task.wake?.();this.emit('send',{deviceId:device.deviceId,message:{type:'cancel',id}});};
    signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,180000);
    try{signal.throwIfAborted();this.emit('send',{deviceId:device.deviceId,message:{type:'job',id,job}});
      while(!task.done||task.queue.length){if(task.queue.length)yield task.queue.shift();else await new Promise(resolve=>{task.wake=resolve;});}
      if(task.error)throw task.error;
    }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);this.tasks.delete(id);device.busy=0;}
  }
  close(){clearInterval(this.timer);for(const id of this.devices.keys())this.remove(id);}
}
