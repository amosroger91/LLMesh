import test from 'node:test';import assert from 'node:assert/strict';
import {recordInference,benchmarkInference,publicMetrics} from '../src/shared/inference-metrics.js';
import {modelInventory,rankNodes,performanceLabel} from '../src/browser/node-performance.js';
import {planRoute} from '../src/core/router.js';
test('average token speed is weighted by actual generation time, and startup benchmarks require metered text',async()=>{
 const metric={};recordInference(metric,{firstTokenMs:100,tokens:10,durationMs:1100});recordInference(metric,{firstTokenMs:200,tokens:30,durationMs:1200});assert.equal(metric.averageTokensPerSecond,20);assert.equal(metric.samples,2);
 let time=0;async function* stream(){time=100;yield{type:'delta',text:'one'};time=1100;yield{type:'done',tokens:10};}
 const benchmark=await benchmarkInference(stream(),{},()=>time);assert.equal(benchmark.averageTokensPerSecond,10);
 await assert.rejects(benchmarkInference((async function*(){yield{type:'done',tokens:0};})()),/no metered text/);
 assert.deepEqual(publicMetrics({averageTokensPerSecond:Infinity,firstTokenMs:-1,tokensPerSecond:20,secret:'hidden'}),{tokensPerSecond:20});
});
test('graph ranks by capability then measured average, and inventory counts loaded instances without visitors',()=>{
 const nodes=[{id:'fast-small',kind:'browser',connected:true,ready:true,model:'Qwen3.5-0.8B-q4f16_1-MLC',metrics:{averageTokensPerSecond:100}},
 {id:'normal',kind:'desktop',ready:true,instances:[{id:'a',model:'qwen3.5:4b-q4_K_M',metrics:{averageTokensPerSecond:20}},{id:'b',model:'qwen3.5:4b-abliterated-q4_K_M',metrics:{averageTokensPerSecond:5}}]},
 {id:'fast-normal',ready:true,model:'qwen3.5:4b-q4_K_M',metrics:{averageTokensPerSecond:30}},
 {id:'visitor',connected:false,ready:true,model:'qwen3.5:27b'}, {id:'paused',disabled:true,model:'qwen3.5:9b'}];
 const ranked=rankNodes(nodes.slice(0,3));assert.equal(ranked[0].id,'fast-normal');assert.match(performanceLabel(ranked[0]),/30.0 avg tok\/s.*tier 3/);
 const inventory=modelInventory(nodes);assert.equal(inventory.find(item=>item.model==='qwen3.5:4b-q4_K_M').count,2);assert.equal(inventory.find(item=>item.model==='qwen3.5:0.8b').count,1);assert.equal(inventory.length,3);
});
test('routing prefers measured average throughput within a capable tier instead of a misleading last sample',()=>{
 const worker=(pubkey,average,last)=>({pubkey,models:['qwen3.5:4b-q4_K_M'],busy:0,seen:Date.now(),latencyMs:10,metrics:{'qwen3.5:4b-q4_K_M':{averageTokensPerSecond:average,tokensPerSecond:last,firstTokenMs:100}}});
 const route=planRoute({model:'llmesh-auto',messages:[{role:'user',content:'implement sort'}],maxTokens:128},[worker('steady',30,10),worker('spiky',10,100)]);assert.equal(route.worker,'steady');
});
