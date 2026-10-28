import test from 'node:test';import assert from 'node:assert/strict';
import {recordInference} from '../src/shared/inference-metrics.js';
import {planRoute} from '../src/core/router.js';
import {BrowserWorkers} from '../src/core/browser-workers.js';
test('completed speed samples smooth out noise and rank a faster worker ahead on later requests',()=>{
 const model='qwen3.5:0.8b',metric={};recordInference(metric,{firstTokenMs:100,tokens:100,durationMs:10100});assert.equal(metric.tokensPerSecond,10);
 recordInference(metric,{firstTokenMs:100,tokens:100,durationMs:2100});assert.equal(metric.tokensPerSecond,22);assert.equal(metric.samples,2);
 assert.equal(recordInference({},{firstTokenMs:10000,tokens:100,durationMs:10000,buffered:true}).tokensPerSecond,10,'Buffered tool delivery is not instantaneous generation');
 const make=(pubkey,metrics)=>({pubkey,models:[model],busy:0,seen:Date.now(),latencyMs:5,metrics:{[model]:metrics}});
 const slow=make('slow',metric),fast=make('fast',recordInference({},{firstTokenMs:300,tokens:100,durationMs:1300}));
 const job={model,messages:[{role:'user',content:'Hello'}],maxTokens:512};assert.equal(planRoute(job,[slow,fast]).worker,'fast');
 fast.busy=1;assert.equal(planRoute(job,[slow,fast]).worker,'slow');
});
test('browser completion records measured timing and throughput for its own device',async()=>{
 const workers=new BrowserWorkers(),id='f'.repeat(64);workers.register(id,'Phone');workers.report(id,{type:'state',state:'ready'});
 workers.on('send',({message})=>{if(message.type!=='job')return;setImmediate(()=>{workers.report(id,{type:'delta',id:message.id,text:'Hello'});workers.report(id,{type:'done',id:message.id,promptTokens:4,tokens:2});});});
 try{for await(const _part of workers.chat({instanceId:'web-'+id,contextTokens:100,maxTokens:10},new AbortController().signal)){/* consume */}const metric=workers.snapshot()[0].metrics;assert.equal(metric.samples,1);assert.ok(metric.tokensPerSecond>0);assert.ok(metric.firstTokenMs>=0);}finally{workers.close();}
});
