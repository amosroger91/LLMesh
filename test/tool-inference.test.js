import test from 'node:test';import assert from 'node:assert/strict';import {browserInference,probeBrowserTools,toolRequest} from '../src/browser/tool-inference.js';
const tools=[{type:'function',function:{name:'ping',parameters:{type:'object',properties:{value:{type:'string'}},required:['value']}}}];
const engine=result=>({chat:{completions:{async *create(request){assert.equal(request.tools,undefined);assert.equal(request.response_format.type,'json_object');yield{choices:[{delta:{content:JSON.stringify(result)},finish_reason:'stop'}]};yield{choices:[],usage:{prompt_tokens:12,completion_tokens:10}};}}}});
test('browser structured tool adapter produces metered OpenAI calls and serializes tool history',async()=>{
 const e=engine({type:'tool_calls',calls:[{name:'ping',arguments:{value:'hello'}}]});assert.equal(await probeBrowserTools(e),true);const parts=[];for await(const part of browserInference(e,{messages:[{role:'user',content:'ping'}],tools,maxTokens:96}))parts.push(part);
 assert.equal(parts[0].type,'tool_calls');assert.equal(parts[0].calls[0].function.name,'ping');assert.equal(parts[1].finishReason,'tool_calls');assert.equal(parts[1].promptTokens,12);
 const next=toolRequest({tools,maxTokens:96,messages:[{role:'system',content:'Keep original instructions'},{role:'assistant',content:'',tool_calls:parts[0].calls},{role:'tool',tool_call_id:parts[0].calls[0].id,content:'hello'}]});assert.match(next.messages[0].content,/Keep original instructions/);assert.match(next.messages[2].content,/Tool result/);
});
test('browser tool self-test refuses unsupported calls rather than advertising fake capability',async()=>{
 const e=engine({type:'tool_calls',calls:[{name:'not_allowed',arguments:{}}]});assert.equal(await probeBrowserTools(e),false);await assert.rejects(async()=>{for await(const _part of browserInference(e,{messages:[{role:'user',content:'hi'}],tools,maxTokens:96})){/* consume */}},/invalid tool call/);
});
