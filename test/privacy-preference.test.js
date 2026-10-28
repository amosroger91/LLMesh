import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Service} from '../src/core/service.js';import {startApi} from '../src/core/api.js';import {generateSecretKey} from '../src/core/identity.js';
test('saved routing preference applies to owner API requests, persists, and never overrides explicit or remote consent',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'llmesh-privacy-')),secret=generateSecretKey(),id='f'.repeat(64);let service=new Service({directory,secret,network:false,ollama:{close(){}}}),api;
 try{
 service.setup={state:'error',message:'No model fits current budgets'};service.browserWorkers.register(id,'Phone',true);service.browserWorkers.report(id,{type:'state',state:'ready'});
 const job={model:'llmesh-auto',messages:[{role:'user',content:'hello'}],maxTokens:12};
 assert.throws(()=>service.route(job),/privacy setting/);service.configurePrivacy('allow-third-party');assert.equal(service.route(job).source,'community');
 assert.throws(()=>service.route({...job,privacy:'mesh-only'}),/privacy setting/);assert.throws(()=>service.route({...job,allow_third_party:false}),/privacy setting/);assert.throws(()=>service.route(job,'a'.repeat(64)),/privacy setting/);
 service.browserWorkers.on('send',({deviceId,message})=>{if(message.type!=='job')return;assert.equal(message.job.privacy,'allow-third-party');setImmediate(()=>{service.browserWorkers.report(deviceId,{type:'delta',id:message.id,text:'Phone streamed hello'});service.browserWorkers.report(deviceId,{type:'done',id:message.id,promptTokens:2,tokens:2});});});
 api=await startApi(service,{port:0});const headers={Authorization:'Bearer '+service.apiKey,'Content-Type':'application/json'};
 const status=await (await fetch(service.apiUrl+'/v1/node',{headers})).json();assert.equal(status.readyBrowserWorkers,1);assert.equal(status.inferencePrivacy,'allow-third-party');assert.equal(status.apiKey,undefined);
 const result=await fetch(service.apiUrl+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({...job,max_tokens:12,stream:true})});assert.equal(result.status,200);const body=await result.text();assert.match(body,/Phone streamed hello/);assert.match(body,/\[DONE\]/);
 api.closeAllConnections();await new Promise(resolve=>api.close(resolve));api=null;await service.close();
 service=new Service({directory,secret,network:false,ollama:{close(){}}});assert.equal(service.status().inferencePrivacy,'allow-third-party');assert.throws(()=>service.configurePrivacy('invalid'),/Invalid/);
 }finally{if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}await service.close();rmSync(directory,{recursive:true,force:true});}
});
