// Explicit live test: uses an existing local Ollama endpoint and loads an additional CPU model.
import assert from 'node:assert/strict';import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Service} from '../src/core/service.js';import {OllamaPool} from '../src/core/runtime/pool.js';import {catalog} from '../src/core/catalog.js';import {generateSecretKey} from '../src/core/identity.js';import {startApi} from '../src/core/api.js';
const directory=mkdtempSync(join(tmpdir(),'llmesh-dual-e2e-')),normal=catalog.models.find(m=>m.id==='qwen3.5:4b-q4_K_M'),ablit=catalog.models.find(m=>m.abliterated),pool=new OllamaPool({runtime:'external',explicitRuntime:true,urls:[process.env.LLMESH_E2E_OLLAMA_URL??'http://127.0.0.1:11500']});
const service=new Service({directory,secret:generateSecretKey(),network:false,ollama:pool,requirePayments:false});let server;const evidence={};
try{
 service.hardware={cores:4,gpus:[],ramGB:16};service.setup={state:'ready',message:'E2E external normal runtime'};
 const spec={id:'normal-e2e',port:11500,backend:'cuda',gpus:[],threads:4,batch:128,parallel:1,keepAlive:-1,model:normal,candidates:[normal]};
 await pool.configure({instances:[spec]},service.hardware,p=>console.log(p.status));assert.equal(pool.snapshot()[0].state,'ready');
 service.assignedModel=normal.id;service.ready=[normal.id];evidence.normalBefore=structuredClone(pool.snapshot().map(i=>({model:i.model,metrics:i.metrics})));
 await service.configureAbliterated(true);assert.equal(service.abliteratedSetup.state,'ready',JSON.stringify(service.abliteratedSetup));
 assert.deepEqual(new Set(service.nativeModels()),new Set([normal.id,ablit.id]));evidence.instances=structuredClone(service.nativeInstances().map(i=>({model:i.model,state:i.state,metrics:i.metrics})));
 server=await startApi(service,{port:0});const url='http://127.0.0.1:'+server.address().port,headers={Authorization:'Bearer '+service.apiKey,'Content-Type':'application/json'};
 const request=async body=>{const response=await fetch(url+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({messages:[{role:'user',content:'Reply with a short hello.'}],max_tokens:24,...body}),signal:AbortSignal.timeout(180000)});return {status:response.status,body:await response.json()};};
 const denied=await request({model:ablit.id});assert.equal(denied.status,400);evidence.optInGuard=denied.status;
 const results=await Promise.all([request({model:normal.id}),request({model:ablit.id,allow_abliterated:true})]);
 for(const result of results){assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(result.body.choices[0].message.content);assert.ok(result.body.usage.completion_tokens>0);}
 evidence.concurrent=results.map(r=>({status:r.status,model:r.body.model,answer:r.body.choices[0].message.content,usage:r.body.usage}));
 assert.equal(service.route({model:'llmesh-auto',messages:[{role:'user',content:'Hello'}],maxTokens:16}).model,normal.id);
 const response=await fetch(url+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:normal.id,messages:[{role:'user',content:'Say hello.'}],max_tokens:16,stream:true}),signal:AbortSignal.timeout(180000)});const text=await response.text();assert.equal(response.status,200);assert.match(text,/data: \[DONE\]/);evidence.sseCompleted=true;
 await service.configureAbliterated(false);assert.ok(service.nativeModels().includes(normal.id));assert.ok(!service.nativeModels().includes(ablit.id));evidence.normalSurvivesDisable=true;
 console.log(JSON.stringify(evidence,null,2));writeFileSync(process.env.LLMESH_E2E_REPORT??'.llmesh/dual-e2e-results.json',JSON.stringify(evidence,null,2));
}catch(error){console.error(error);console.error(JSON.stringify(service.abliteratedSetup));process.exitCode=1;}finally{await new Promise(resolve=>server?server.close(resolve):resolve());await service.close();rmSync(directory,{recursive:true,force:true});}

