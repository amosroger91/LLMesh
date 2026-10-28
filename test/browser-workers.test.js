import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserWorkers} from '../src/core/browser-workers.js';
import {Service} from '../src/core/service.js';
import {generateSecretKey} from '../src/core/identity.js';
import {ephemeralKey,publicKey,secureChannel} from '../src/browser/secure-channel.js';

test('QR-bound encryption rejects tampering, wrong sessions and replay',async()=>{
 const a=await ephemeralKey(),b=await ephemeralKey();let frame;
 const host=await secureChannel(a,await publicKey(b),'session',value=>{frame=value;});
 const worker=await secureChannel(b,await publicKey(a),'session',()=>{});
 await host.send({type:'job',text:'private prompt'});assert.equal(JSON.stringify(frame).includes('private prompt'),false);
 assert.deepEqual(await worker.receive(frame),{type:'job',text:'private prompt'});await assert.rejects(worker.receive(frame));
 const wrong=await secureChannel(b,await publicKey(a),'other-session',()=>{});await assert.rejects(wrong.receive(frame));
 await host.send({type:'job'});await assert.rejects(worker.receive({...frame,data:frame.data.slice(0,-4)+'AAAA'}));
});
test('only approved browser devices advertise slots; disconnect cancels active work',async()=>{
 const workers=new BrowserWorkers(),id='a'.repeat(64);
 try{assert.throws(()=>workers.report(id,{type:'state',state:'ready'}));workers.register(id,'Phone');
   workers.report(id,{type:'state',state:'ready',engineModel:'Qwen3.5-0.8B-q4f16_1-MLC'});assert.equal(workers.snapshot()[0].free,1);
   const controller=new AbortController();workers.once('send',event=>{assert.equal(event.message.type,'job');setImmediate(()=>workers.remove(id));});
   await assert.rejects(async()=>{for await(const _part of workers.chat({instanceId:'web-'+id,contextTokens:4096,maxTokens:12},controller.signal)){/* consume until disconnect */}},/disconnected/);
   assert.equal(workers.snapshot().length,0);
 }finally{workers.close();}
});
test('linked browser serves the real service route and accounts to the desktop identity',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'llmesh-browser-')),device='b'.repeat(64);
 const service=new Service({directory,secret:generateSecretKey(),network:false,ollama:{installed:async()=>[],close(){}}});
 try{service.browserWorkers.register(device,'Phone');service.browserWorkers.report(device,{type:'state',state:'ready'});
   service.browserWorkers.on('send',({deviceId,message})=>{if(message.type!=='job')return;setImmediate(()=>{
     service.browserWorkers.report(deviceId,{type:'delta',id:message.id,text:'browser answer'});
     service.browserWorkers.report(deviceId,{type:'done',id:message.id,tokens:3,promptTokens:7});});});
   let text='';const receipt=await service.chat(service.pubkey,{model:'llmesh-auto',messages:[{role:'user',content:'hi'}],maxTokens:12},delta=>{text+=delta;});
   assert.equal(text,'browser answer');assert.equal(receipt.credits,10);assert.equal(receipt.worker,service.pubkey);assert.equal(receipt.route.instanceId,'web-'+device);
   assert.equal(service.ledger.account(service.pubkey).balance,100000);assert.equal(service.topology().nodes.length,2);
   assert.equal(service.energy.status().sessions.length,0,'Browser inference is not charged as desktop electricity');
   assert.throws(()=>service.route({model:'llmesh-auto',messages:[{role:'user',content:'hi'}],tools:[{type:'function',function:{name:'test',parameters:{type:'object'}}}]}),/No idle/);
 }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('guest browser donates without a wallet and cannot receive private requests',async()=>{
 const workers=new BrowserWorkers(),id='c'.repeat(64);workers.register(id,'Guest phone',true);workers.report(id,{type:'state',state:'ready'});
 const job={instanceId:'web-'+id,contextTokens:4096,maxTokens:12,privacy:'mesh-only'};
 try{await assert.rejects(async()=>{for await(const _part of workers.chat(job,new AbortController().signal)){/* Drain until the privacy guard rejects. */}},/explicit external-worker consent/);
 workers.on('send',({message})=>{if(message.type==='job'){workers.report(id,{type:'delta',id:message.id,text:'guest answer'});workers.report(id,{type:'done',id:message.id,promptTokens:2,tokens:3});}});
 const parts=[];for await(const part of workers.chat({...job,privacy:'allow-third-party'},new AbortController().signal))parts.push(part);
 assert.equal(parts[0].text,'guest answer');assert.equal(parts[1].tokens,3);assert.equal(workers.snapshot()[0].community,true);
 }finally{workers.close();}
});

test('guest capability is consent-gated at routing and execution and respects browser context',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'llmesh-guest-')),device='d'.repeat(64);
 const service=new Service({directory,secret:generateSecretKey(),network:false,ollama:{installed:async()=>[],close(){}}});
 try{service.browserWorkers.register(device,'Anonymous phone',true);service.browserWorkers.report(device,{type:'state',state:'ready'});
 const job={model:'llmesh-auto',messages:[{role:'user',content:'hello'}],maxTokens:12};
 assert.throws(()=>service.route(job),/No idle/);assert.equal(service.route({...job,privacy:'allow-third-party'}).source,'community');
 assert.equal(service.localSlots()[0].source,'community');
 assert.throws(()=>service.route({...job,privacy:'allow-third-party',messages:[{role:'user',content:'a'.repeat(20000)}]}),/No idle/);
 service.browserWorkers.on('send',({deviceId,message})=>{if(message.type==='job')setImmediate(()=>service.browserWorkers.report(deviceId,{type:'done',id:message.id,promptTokens:2,tokens:3}));});
 const receipt=await service.chat(service.pubkey,{...job,privacy:'allow-third-party'},()=>{});assert.equal(receipt.credits,5);assert.equal(service.ledger.account(service.pubkey).balance,100000);
 }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('a ready browser does not hide a failed native setup and still serves requests independently',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'llmesh-browser-native-error-')),device='e'.repeat(64);
 const service=new Service({directory,secret:generateSecretKey(),network:false});
 try{service.browserWorkers.register(device,'Phone');service.browserWorkers.report(device,{type:'state',state:'ready'});
 service.scanHardware=async()=>{service.hardware={gpus:[],ramGB:16,freeRamGB:2,cores:8};service.proposedProfile={reason:'No native model fits',placement:{instances:[]}};};service.ollama.configure=async()=>[];
 await service.configureContribution('high');assert.equal(service.setup.state,'error');assert.match(service.setup.message,/No native model fits/);assert.equal(service.assignedModel,null);
 assert.equal(service.route({model:'llmesh-auto',messages:[{role:'user',content:'hi'}],maxTokens:12}).instanceId,'web-'+device);
 }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});


test('browser tool capability is opt-in after self-test and forwards validated metered calls',async()=>{
 const workers=new BrowserWorkers(),id='9'.repeat(64);workers.register(id,'Phone',true);workers.report(id,{type:'state',state:'ready',supportsTools:true});assert.equal(workers.snapshot()[0].supportsTools,false);
 workers.report(id,{type:'state',state:'ready',supportsTools:true,toolAdapter:'json-schema-v1'});assert.equal(workers.snapshot()[0].supportsTools,true);
 const job={instanceId:'web-'+id,privacy:'allow-third-party',contextTokens:4096,maxTokens:96,tools:[{type:'function',function:{name:'ping'}}]};
 workers.on('send',({message})=>{if(message.type!=='job')return;setImmediate(()=>{workers.report(id,{type:'tool_calls',id:message.id,calls:[{index:0,id:'call_test',type:'function',function:{name:'ping',arguments:'{"value":"hello"}'}}]});workers.report(id,{type:'done',id:message.id,promptTokens:12,tokens:10,finishReason:'tool_calls'});});});
 try{const parts=[];for await(const part of workers.chat(job,new AbortController().signal))parts.push(part);assert.equal(parts[0].calls[0].function.name,'ping');assert.equal(parts[1].finishReason,'tool_calls');}finally{workers.close();}
});
