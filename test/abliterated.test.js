import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {catalog,DESKTOP_PLACEMENT} from '../src/core/catalog.js';import {chooseContribution} from '../src/core/contribution.js';
import {validateJob,Service} from '../src/core/service.js';import {planRoute} from '../src/core/router.js';import {generateSecretKey} from '../src/core/identity.js';
const model=catalog.models.find(model=>model.abliterated),job={model:model.id,messages:[{role:'user',content:'Hello'}],maxTokens:16};
test('abliterated models require an exact ID plus explicit API opt-in and never enter automatic placement/routing',()=>{
 assert.throws(()=>validateJob(job),/allow_abliterated/);assert.throws(()=>validateJob({...job,model:'llmesh-auto',allow_abliterated:true}),/exact model ID/);
 assert.throws(()=>validateJob({...job,allow_abliterated:'true'}),/must be boolean/);
 const normalized=validateJob({...job,allow_abliterated:true}),worker={pubkey:'worker',models:[model.id],seen:Date.now(),busy:0};
 assert.equal(planRoute(normalized,[worker]).model,model.id);assert.throws(()=>planRoute({...normalized,model:'llmesh-auto'},[worker]),/abliterated models require/);
 assert.throws(()=>planRoute({...normalized,allowAbliterated:false},[worker]),/abliterated models require/);
 const hw={ramGB:64,freeRamGB:64,cores:8,gpus:[{vendor:'NVIDIA',vramGB:24,freeGB:24}]};
 const profile=chooseContribution(hw,'high',DESKTOP_PLACEMENT);assert.ok(profile.candidates.every(model=>!model.abliterated));
 assert.equal(chooseContribution(hw,'medium',{...DESKTOP_PLACEMENT,fixedModel:model.id}).model.id,model.id);
});
test('workers independently refuse explicitly requested abliterated inference until their owner enables serving',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'llmesh-abliterated-')),service=new Service({directory,secret:generateSecretKey(),network:false,ollama:{close(){}}});
 try{assert.equal(service.status().abliteratedServing,false);
  await assert.rejects(async()=>{for await(const _part of service.runLocal({...job,allow_abliterated:true},new AbortController().signal)){/* consume */}},/serving is disabled/);
  service.loadAbliterated=async()=>{};await service.configureAbliterated(true);assert.equal(service.abliteratedServing,true);
  await service.configureAbliterated(false);assert.equal(service.abliteratedServing,false);
 }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('enabling a secondary worker preserves the normal instance and disabling it closes only the secondary',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'llmesh-coexist-'));let normalStops=0,secondaryStops=0;
 const service=new Service({directory,secret:generateSecretKey(),network:false,ollama:{close(){normalStops++;}}});
 service.pool=true;service.ollama.instances=[{state:'ready',model:{id:'qwen3.5:4b-q4_K_M'}}];service.ollama.snapshot=()=>[{id:'normal',model:'qwen3.5:4b-q4_K_M',state:'ready',slots:1,free:1,metrics:{}}];
 service.abliteratedPool={configure:async()=>{},snapshot:()=>[{id:'abliterated-cpu',model:model.id,state:'ready',slots:1,free:1,metrics:{}}],close:async()=>{secondaryStops++;}};
 try{await service.configureAbliterated(true);assert.equal(service.nativeSlots().length,2);assert.equal(service.nativeModels().length,2);assert.equal(normalStops,0);
 assert.equal(service.route({model:'llmesh-auto',messages:job.messages,maxTokens:16}).model,'qwen3.5:4b-q4_K_M');
 assert.equal(service.route({...job,allow_abliterated:true}).instanceId,'abliterated-cpu');
 await service.configureAbliterated(false);assert.equal(service.nativeSlots().length,1);assert.equal(secondaryStops,1);assert.equal(normalStops,0);
 }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});
