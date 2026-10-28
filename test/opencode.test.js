import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateJob, Service } from '../src/service.js';
import { Ollama } from '../src/ollama.js';
import { startApi } from '../src/api.js';
import { generateSecretKey } from '../src/identity.js';

const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
test('coding-client request normalization accepts text parts, developer messages and large output limits without truncating context', () => {
  const request = validateJob({ model: 'llmesh-auto', maxTokens: 32768, tools, messages: [
    { role: 'developer', content: 'x'.repeat(14000) }, { role: 'user', content: [{ type: 'text', text: 'hello' }] }
  ] });
  assert.equal(request.maxTokens, 2048); assert.equal(request.requestedMaxTokens, 32768);
  assert.equal(request.messages[0].role, 'system'); assert.equal(request.messages[0].content.length, 14000);
  assert.equal(request.messages[1].content, 'hello'); assert.ok(request.contextTokens > 4096);
  assert.deepEqual(request.tools, tools);
  assert.throws(() => validateJob({ ...request, messages: [{ role: 'user', content: [{ type: 'image_url' }] }] }), /Only text/);
  assert.throws(() => validateJob({ ...request, messages: [{ role: 'user', content: 'x'.repeat(90001) }] }), /compact the conversation/);
});

test('OpenAI API streams tool calls and accepts their results through the Ollama adapter', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-opencode-')), ollama = new Ollama();
  let round = 0;
  ollama.request = async (path, body) => {
    assert.equal(path, '/api/chat'); assert.equal(body.model, 'qwen3.5:0.8b');
    assert.deepEqual(body.tools, tools); assert.equal(body.options.num_predict, 2048);
    let message;
    if (++round <= 2) message = { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'README.md' } } }] };
    else {
      assert.equal(body.messages.at(-1).role, 'tool'); assert.equal(body.messages.at(-1).tool_name, 'read_file');
      assert.deepEqual(body.messages.at(-2).tool_calls[0].function.arguments, { path: 'README.md' });
      message = { content: 'The file contains a project description.' };
    }
    return new Response([JSON.stringify({ message }), JSON.stringify({ done: true, eval_count: 12, prompt_eval_count: 100 })].join('\n') + '\n');
  };
  const service = new Service({ directory, secret: generateSecretKey(), network: false, ollama });
  service.ready = ['qwen3.5:0.8b']; const api = await startApi(service, { port: 0 });
  const request = async extra => {
    const response = await fetch(service.apiUrl + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + service.apiKey }, body: JSON.stringify({
      model: 'llmesh-auto', tools, max_tokens: 32000, messages: [{ role: 'user', content: [{ type: 'text', text: 'Read README.md' }] }], ...extra
    }) });
    assert.equal(response.status, 200); return response;
  };
  try {
    const streamed = await (await request({ stream: true })).text();
    assert.match(streamed, /"tool_calls":\[/); assert.match(streamed, /"finish_reason":"tool_calls"/); assert.match(streamed, /data: \[DONE\]/);
    const result = await (await request({ stream: false })).json(); const call = result.choices[0].message.tool_calls[0];
    assert.equal(result.choices[0].finish_reason, 'tool_calls'); assert.equal(call.function.arguments, '{"path":"README.md"}');
    assert.equal(result.llmesh_receipt.maxTokens, 2048); assert.equal(result.llmesh_receipt.requestedMaxTokens, 32000);
    const completed = await (await request({ messages: [
      { role: 'user', content: 'Read README.md' }, result.choices[0].message,
      { role: 'tool', tool_call_id: call.id, content: [{ type: 'text', text: 'Project description' }] }
    ] })).json();
    assert.match(completed.choices[0].message.content, /project description/);
    assert.equal(service.ledger.account(service.pubkey).balance, 200000);
  } finally {
    api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await service.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('an initial OpenCode greeting omits unused tools and caps output while preserving all system instructions',()=>{
 const system='Coding client instructions. '.repeat(820),catalog=Array.from({length:10},(_,i)=>({type:'function',function:{name:'tool_'+i,description:'Detailed tool documentation. '.repeat(180),parameters:{type:'object'}}}));
 const job=validateJob({model:'llmesh-auto',messages:[{role:'system',content:system},{role:'user',content:'hi'}],tools:catalog,maxTokens:32000});
 assert.equal(job.messages[0].content,system);assert.equal(job.tools.length,0);assert.equal(job.maxTokens,128);assert.equal(job.adaptation.omittedTools,10);
 const coding=validateJob({model:'llmesh-auto',messages:[{role:'system',content:system},{role:'user',content:'hi, read README.md'}],tools:catalog,maxTokens:32000});assert.equal(coding.tools.length,10);assert.equal(coding.maxTokens,2048);
});
