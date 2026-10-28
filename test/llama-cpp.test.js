import test from 'node:test';import assert from 'node:assert/strict';import {LlamaCppClient,llamaArguments} from '../src/core/runtime/llama-cpp.js';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Service} from '../src/core/service.js';import {generateSecretKey} from '../src/core/identity.js';import {LlamaCppPool} from '../src/core/runtime/llama-cpp.js';
test('direct llama.cpp client preserves streaming content, assembled tool calls and authoritative token usage',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async(_url,options)=>{const request=JSON.parse(options.body);assert.equal(request.stream_options.include_usage,true);return new Response([
  {choices:[{delta:{content:'Hello'}}]},
  {choices:[{delta:{tool_calls:[{index:0,id:'call_test',function:{name:'ping',arguments:'{"value":'}}]}}]},
  {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"hello"}'}}]},finish_reason:'tool_calls'}]},
  {choices:[],usage:{prompt_tokens:10,completion_tokens:5}}
 ].map(chunk=>'data: '+JSON.stringify(chunk)+'\n\n').join('')+'data: [DONE]\n\n');};
 try{const parts=[];for await(const part of new LlamaCppClient('http://127.0.0.1:11510','model').chat({model:'model',messages:[{role:'user',content:'Hi'}],maxTokens:20},new AbortController().signal))parts.push(part);
  assert.equal(parts[0].text,'Hello');assert.equal(parts[1].calls[0].function.arguments,'{"value":"hello"}');assert.deepEqual(parts[2],{type:'done',promptTokens:10,tokens:5,finishReason:'tool_calls'});
  globalThis.fetch=async()=>new Response('data: [DONE]\n\n');await assert.rejects(async()=>{for await(const _part of new LlamaCppClient('http://127.0.0.1','model').chat({model:'model',messages:[],maxTokens:20},new AbortController().signal)){/* consume */}},/metered usage/);
 }finally{globalThis.fetch=original;}
});
test('direct runtime binds loopback, fixes context, disables idle unloading and does not invoke a shell',()=>{
 const args=llamaArguments({port:11510,model:{id:'qwen3.5:4b-q4_K_M'},threads:4,batch:128,backend:'cuda'},'C:\\models\\model.gguf');
 assert.equal(args[args.indexOf('--host')+1],'127.0.0.1');assert.equal(args[args.indexOf('--ctx-size')+1],'4096');assert.ok(args.includes('--no-webui'));assert.ok(args.includes('--reasoning-budget'));assert.equal(args[args.indexOf('--model')+1],'C:\\models\\model.gguf');
});
test('runtime choice persists but only swaps the backend on restart',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'llmesh-runtime-choice-')),secret=generateSecretKey();let service=new Service({directory,secret,network:false});
 try{assert.equal(service.runtimeEngine,'ollama');service.configureRuntimeEngine('llama.cpp');assert.equal(service.runtimeEngine,'ollama');assert.equal(service.status().pendingRuntimeEngine,'llama.cpp');await service.close();service=new Service({directory,secret,network:false});assert.equal(service.runtimeEngine,'llama.cpp');assert.ok(service.ollama instanceof LlamaCppPool);assert.equal(service.pool,true);}
 finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});
