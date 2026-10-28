import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Service} from '../src/core/service.js';
import {generateSecretKey} from '../src/core/identity.js';
import {discoverProvider} from '../src/core/providers.js';
import {validateJob} from '../src/core/chat-request.js';

test('donated APIs require per-request consent, stream actual usage, hide keys and enforce quota',{timeout:15000},async()=>{
 const requests=[];let mode='ok';
 const upstream=http.createServer(async(req,res)=>{
   assert.equal(req.headers.authorization,'Bearer private-donor-key');
   if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'fast-70b',name:'Fast 70B'}]}));return;}
   let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
   if(mode==='limit'){res.writeHead(429);res.end();return;}
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   res.write('data: '+JSON.stringify({model:'fast-70b-v2',choices:[{delta:{content:'donated answer'}}]})+'\n\n');
   if(mode!=='missing-usage')res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:4}})+'\n\n');
   res.end('data: [DONE]\n\n');
 });await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const directory=mkdtempSync(join(tmpdir(),'llmesh-provider-'));
 const service=new Service({directory,secret:generateSecretKey(),network:false,requirePayments:false,ollama:{close(){},async *chat(){yield{type:'delta',text:'local answer'};yield{type:'done',promptTokens:2,tokens:1};}}});
 const config={id:'test-donor',kind:'custom',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,apiKey:'private-donor-key',model:'fast-70b',dailyLimit:50000,freeTierConfirmed:true};
 const request={model:'llmesh-auto',messages:[{role:'user',content:'hi'}],maxTokens:12};service.ready=['qwen3.5:0.8b'];
 try{
   assert.deepEqual(await discoverProvider(config),[{id:'fast-70b',name:'Fast 70B'}]);
   assert.throws(()=>service.providers.configure([{...config,freeTierConfirmed:false}]),/free-tier/);
   assert.throws(()=>service.providers.configure([{...config,kind:'openrouter',model:'paid-model'}]),/:free/);
   service.providers.configure([config]);
   assert.equal(service.route(request).source,'mesh');
   await service.chat(service.pubkey,request,()=>{});assert.equal(requests.length,0);
   service.modelMetrics['qwen3.5:0.8b']={firstTokenMs:1000,tokensPerSecond:20};
   await assert.rejects(service.chat(service.pubkey,{...request,model:'donated:test-donor'},()=>{}));assert.equal(requests.length,0);
   await assert.rejects(async()=>{for await(const _part of service.runLocal({...request,model:'donated:test-donor',instanceId:'api-test-donor',privacy:'mesh-only'},AbortSignal.timeout(1000))){/* consume */}},/did not allow/);
   assert.equal(requests.length,0,'Worker-side privacy enforcement also prevents direct donated-runtime dispatch');
   let text='';const receipt=await service.chat(service.pubkey,{...request,privacy:'allow-third-party'},delta=>{text+=delta;});
   assert.equal(text,'donated answer');assert.equal(receipt.credits,14);assert.equal(receipt.route.source,'third-party');assert.equal(receipt.route.upstreamModel,'fast-70b');
   assert.equal(requests.length,1);assert.equal(requests[0].model,'fast-70b');assert.equal(service.ledger.account(service.pubkey).balance,100000,'Self donation cannot create credits');
   let status=service.status().donations[0];assert.equal(status.usage.input_tokens,10);assert.equal(status.usage.output_tokens,4);assert.equal(status.calls[0].reported_model,'fast-70b-v2');
   assert.equal(JSON.stringify(service.status()).includes('private-donor-key'),false);
   const payer='d'.repeat(64);service.ledger.register(payer);await service.chat(payer,{...request,privacy:'allow-third-party'},()=>{});
   assert.equal(service.ledger.account(payer).balance,99986);assert.equal(service.ledger.account(service.pubkey).balance,100014,'Donor earns only for serving another account');
   mode='missing-usage';await assert.rejects(service.chat(payer,{...request,privacy:'allow-third-party',model:'donated:test-donor'},()=>{}),/usage/);
   status=service.providers.snapshot()[0];assert.equal(status.state,'cooldown');assert.equal(status.usage.input_tokens,20);assert.equal(status.usage.output_tokens,8);assert.ok(status.usage.uncertain_tokens>0);assert.equal(service.ledger.account(payer).balance,99986);
   service.providers.configure([config]);mode='limit';await assert.rejects(service.chat(payer,{...request,privacy:'allow-third-party',model:'donated:test-donor'},()=>{}),/429/);assert.equal(service.providers.snapshot()[0].free,0);
   assert.equal(service.route({...request,privacy:'allow-third-party'}).source,'mesh','Rate-limited API withdraws; normal routing can use local hardware');
   assert.throws(()=>validateJob({...request,privacy:'mesh-only',allow_third_party:true}),/Conflicting/);
 }finally{await service.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));rmSync(directory,{recursive:true,force:true});}
});

test('HTTP 413 learns provider limits, keeps small jobs available, and safely reroutes before streaming',{timeout:10000},async()=>{
 let calls=0,rejectLarge=true;const upstream=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const payload=JSON.parse(raw);calls++;
 if(rejectLarge){res.writeHead(413,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Request too large on tokens per minute (TPM): Limit 1000, Requested 9000. secret-key private prompt org_secret'}}));return;}
 res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'small donated response'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:2}})+'\n\ndata: [DONE]\n\n');assert.equal(payload.model,'fast-70b');
 });await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const directory=mkdtempSync(join(tmpdir(),'llmesh-provider-413-')),secret=generateSecretKey();let service=new Service({directory,secret,network:false,ollama:{close(){},async *chat(){yield{type:'delta',text:'native fallback'};yield{type:'done',promptTokens:2,tokens:2};}}});
 const config={id:'reject-large',kind:'custom',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,apiKey:'secret-key',model:'fast-70b',dailyLimit:100000,freeTierConfirmed:true};
 const job={model:'llmesh-auto',privacy:'allow-third-party',complexity:'simple',messages:[{role:'user',content:'x'.repeat(9000)}],maxTokens:12};
 try{service.ready=['qwen3.5:0.8b'];service.providers.configure([config]);let output='';const receipt=await service.chat(service.pubkey,job,delta=>{output+=delta;});assert.equal(output,'native fallback');assert.equal(receipt.model,'qwen3.5:0.8b');assert.equal(calls,1);
 const status=service.providers.snapshot()[0];assert.equal(status.state,'ready');assert.equal(status.requestTokenLimit,1000);assert.equal(status.usage.uncertain_tokens,0);assert.equal(status.usage.errors,1);assert.equal(service.ledger.account(service.pubkey).balance,100000);assert.match(status.error,/Token limit 1000/);assert.equal(JSON.stringify(status).includes('private prompt'),false);assert.equal(JSON.stringify(status).includes('secret-key'),false);
 assert.equal(service.route(job).source,'mesh','Known oversized request avoids donor');assert.equal(service.route({...job,model:'donated:reject-large',messages:[{role:'user',content:'hi'}]}).source,'third-party');
 rejectLarge=false;await service.chat(service.pubkey,{...job,model:'donated:reject-large',messages:[{role:'user',content:'hi'}]},()=>{});assert.equal(calls,2);
 await service.close();service=new Service({directory,secret,network:false,ollama:{close(){}}});service.providers.configure([config]);assert.equal(service.providers.snapshot()[0].requestTokenLimit,1000,'Learned limit survives restart');
 }finally{await service.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));rmSync(directory,{recursive:true,force:true});}
});
