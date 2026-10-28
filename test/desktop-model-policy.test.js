import test from 'node:test';import assert from 'node:assert/strict';
import {DESKTOP_PLACEMENT,catalog} from '../src/core/catalog.js';
import {chooseContribution} from '../src/core/contribution.js';
import {instanceEnvironment} from '../src/core/runtime/pool.js';
import {Ollama} from '../src/core/ollama.js';
const hardware={ramGB:16,freeRamGB:0.2,cores:16,physicalCores:8,platform:'win32',gpus:[{vendor:'NVIDIA',name:'RTX 3050',index:0,uuid:'gpu-0',vramGB:6,freeGB:0.1}]};
test('desktop minimum is quantized 4B even when RAM and VRAM are occupied; all levels stay loaded',()=>{
 for(const level of ['low','medium','high']){
  const profile=chooseContribution(hardware,level,DESKTOP_PLACEMENT),instance=profile.placement.instances[0];
  assert.equal(profile.model.id,'qwen3.5:4b-q4_K_M');assert.equal(instance.backend,'cuda');assert.equal(profile.keepAlive,-1);assert.equal(instance.keepAlive,-1);
  assert.ok(profile.candidates.every(model=>model.rank>=3));assert.equal(instanceEnvironment(instance,'cache',hardware).OLLAMA_KEEP_ALIVE,'-1');
 }
 const larger=chooseContribution({...hardware,ramGB:64,gpus:[{...hardware.gpus[0],vramGB:24}]},'high',DESKTOP_PLACEMENT);assert.equal(larger.model.id,'qwen3.8:27b');
 assert.equal(chooseContribution({...hardware,ramGB:8,gpus:[]},'medium',DESKTOP_PLACEMENT).model,null,'No silent fallback to a browser-sized model');
 assert.ok(catalog.models.some(model=>model.id==='qwen3.5:2b-q4_K_M'));assert.ok(catalog.models.some(model=>model.id==='qwen3.5:0.8b'));
});
test('indefinite residency reaches both warmup and inference requests',async()=>{
 const client=new Ollama();client.profile={keepAlive:-1,threads:4,batch:128,mode:'gpu'};const bodies=[];
 client.request=async(_path,body)=>{bodies.push(body);return{body:(async function*(){yield new TextEncoder().encode(JSON.stringify({done:true,eval_count:0,prompt_eval_count:0})+'\n');})()};};
 await client.warm('qwen3.5:4b-q4_K_M');for await(const _part of client.chat({model:'qwen3.5:4b-q4_K_M',messages:[{role:'user',content:'Hi'}],maxTokens:4},new AbortController().signal)){/* consume */}
 assert.deepEqual(bodies.map(body=>body.keep_alive),[-1,-1]);
});
