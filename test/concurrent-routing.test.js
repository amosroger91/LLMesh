import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Service} from '../src/core/service.js';
import {generateSecretKey} from '../src/core/identity.js';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const request={model:'llmesh-auto',messages:[{role:'user',content:'hello'}],maxTokens:12};
function fixture(chat){const directory=mkdtempSync(join(tmpdir(),'llmesh-concurrency-'));const service=new Service({directory,secret:generateSecretKey(),network:false,requirePayments:false,ollama:{close(){},chat}});service.ready=['qwen3.5:0.8b'];return{service,async close(){await service.close();rmSync(directory,{recursive:true,force:true});}};}

test('a request on another node leaves local hardware available for concurrent work',async()=>{
 let release,started;const running=new Promise(resolve=>{started=resolve;});
 const f=fixture(async function*(){yield{type:'delta',text:'local'};yield{type:'done',tokens:1,promptTokens:2};});
 const remote='b'.repeat(64);f.service.mesh={workers:()=>[{pubkey:remote,models:['qwen3.8:27b'],busy:0,seen:Date.now()}],async execute(){started();await new Promise(resolve=>{release=resolve;});return{worker:remote,tokens:2,promptTokens:3};},close(){}};
 try{const elsewhere=f.service.chat(f.service.pubkey,{...request,complexity:'complex'},()=>{});await running;
   assert.equal(f.service.busy,0);const local=await f.service.chat(f.service.pubkey,{...request,workerKey:f.service.pubkey},()=>{});
   assert.equal(local.credits,3);assert.equal(local.route.settlement,'local-self');release();assert.equal((await elsewhere).worker,remote);
 }finally{release?.();await f.close();}
});
test('a local request queues while an incoming request finishes, without preemption or double dispatch',{timeout:5000},async()=>{
 let release,starts=0,active=0,peak=0;const f=fixture(async function*(){starts++;peak=Math.max(peak,++active);try{if(starts===1)await new Promise(resolve=>{release=resolve;});yield{type:'done',tokens:1,promptTokens:2};}finally{active--;}});
 try{const payer='c'.repeat(64);f.service.ledger.register(payer);const incoming=f.service.chat(payer,request,()=>{});for(let i=0;i<100&&!release;i++)await pause(5);assert.ok(release);
   const local=f.service.chat(f.service.pubkey,request,()=>{});await pause(50);assert.equal(starts,1);release();await Promise.all([incoming,local]);assert.equal(starts,2);assert.equal(peak,1);
 }finally{release?.();await f.close();}
});
test('swarm tasks fan out to independent slots and preserve ordered results',{timeout:5000},async()=>{
 const f=fixture(async function*(){await pause(10);yield{type:'delta',text:'native'};yield{type:'done',tokens:2,promptTokens:3};});
 try{const events=[];const result=await f.service.swarm(f.service.pubkey,[request,request,request],{onEvent:event=>events.push(event)});
   assert.equal(result.agents,1);assert.equal(result.results.length,3);assert.ok(result.results.every(result=>result.ok&&result.receipt.credits===5));assert.deepEqual(events.filter(event=>event.type==='finished').map(event=>event.index),[0,1,2]);
 }finally{await f.close();}
});
test('native and browser slots handle separate swarm tasks at the same time',{timeout:5000},async()=>{
 const f=fixture(async function*(){await pause(30);yield{type:'done',tokens:2,promptTokens:3};});let peak=0;
 try{f.service.ready=['qwen3.5:4b'];const device='f'.repeat(64);f.service.browserWorkers.register(device,'Phone');f.service.browserWorkers.report(device,{type:'state',state:'ready'});
   f.service.browserWorkers.on('send',({deviceId,message})=>{if(message.type!=='job')return;peak=Math.max(peak,f.service.busy);setTimeout(()=>f.service.browserWorkers.report(deviceId,{type:'done',id:message.id,tokens:1,promptTokens:2}),15);});
   const result=await f.service.swarm(f.service.pubkey,[{...request,messages:[{role:'user',content:'implement a function'}]},request]);
   assert.equal(result.agents,2);assert.equal(peak,2);assert.deepEqual(result.results.map(result=>result.receipt.credits),[5,3]);assert.ok(result.results[1].receipt.route.instanceId.startsWith('web-'));
 }finally{await f.close();}
});
