import http from 'node:http';
import https from 'node:https';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { authenticate } from './identity.js';
import { StringDecoder } from 'node:string_decoder';
import { AUTO_MODEL } from './router.js';

export function openApi(base) {
  const document = { openapi: '3.1.0', info: { title: 'LLMesh local inference', version: '0.1.0' }, servers: [{ url: base }],
    security: [{ bearerAuth: [] }], components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    paths: { '/v1/models': { get: { responses: { 200: { description: 'OpenAI model list' } } } },
      '/v1/chat/completions': { post: { requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['model', 'messages'], properties: { model: { type: 'string' }, messages: { type: 'array', items: {
          type: 'object', required: ['role', 'content'], properties: { role: { enum: ['system', 'developer', 'user', 'assistant', 'tool'] }, content: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }, { type: 'null' }] }, tool_calls: { type: 'array', items: { type: 'object' } }, tool_call_id: { type: 'string' } } } },
          stream: { type: 'boolean', default: false }, complexity: { enum: ['auto','simple','standard','complex'], default: 'auto' },
          allow_degraded: { type: 'boolean', default: true, description: 'Use the best available model below the recommended tier; false requires the recommended capability.' }, tools: { type: 'array', items: { type: 'object' } }, tool_choice: { enum: ['auto', 'none'] }, max_tokens: { type: 'integer', minimum: 1, description: 'Output is capped at 2048 tokens; larger client limits are accepted and clamped.' }, max_completion_tokens: { type: 'integer', minimum: 1 } } } } } },
        responses: { 200: { description: 'Chat completion or streamed SSE chunks' }, 400: { description: 'Invalid request or unavailable worker' }, 401: { description: 'Invalid credentials' } } } } } };
  const properties=document.paths['/v1/chat/completions'].post.requestBody.content['application/json'].schema.properties;
  properties.privacy={type:'string',enum:['mesh-only','allow-third-party'],default:'mesh-only',description:'Explicit consent is required to send prompts to donated third-party APIs'};
  document.paths['/v1/swarm/completions']={post:{requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['tasks'],properties:{tasks:{type:'array',minItems:1,maxItems:32,items:{type:'object'}},max_concurrency:{type:'integer',minimum:1,maximum:16},stream:{type:'boolean'}}}}}},responses:{200:{description:'Ordered task results or indexed SSE events'}}}};
  return document;
}
function bearer(header, key) {
  const actual = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : ''); const expected = Buffer.from(key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function startApi(service, { port = 7337, host = '127.0.0.1', tls } = {}) {
  const handler = async (req, res) => {
    req.socket.setNoDelay(true);
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const error = (code, message) => json(code, { error: { message, type: 'llmesh_error', code } });
    try {
      const pathname = new URL(req.url, service.apiUrl).pathname;
      if (pathname === '/health' && req.method === 'GET') return json(200, { ok: true });
      if (pathname === '/ready' && req.method === 'GET') {
        const state = service.status();
        const ready = !service.draining && !service.closed && (state.serving.length > 0 || state.workers.some(worker => worker.busy === 0 && worker.models.length));
        return json(ready ? 200 : 503, { ready });
      }
      if (pathname === '/openapi.json' && req.method === 'GET') return json(200, openApi(service.apiUrl));
      if (req.headers.origin) return error(403, 'Browser origins are not allowed; use the desktop app or an API client');
      const decoder = new StringDecoder('utf8'); let raw = '', size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 524288) return error(413, 'Request body exceeds 512 KiB'); raw += decoder.write(chunk); }
      raw += decoder.end();
      let pubkey;
      try { pubkey = bearer(req.headers.authorization, service.apiKey) ? service.pubkey : authenticate(req.headers.authorization, service.apiUrl + req.url, req.method, raw, service.ledger); }
      catch (e) { return error(401, e.message); }
      if (req.method === 'POST' && pathname === '/v1/accounts') {
        if (service.requirePayments) {
          const wallet = JSON.parse(raw).wallet;
          service.grants.check(pubkey, wallet, req.socket.remoteAddress ?? 'unknown');
          const voucher = await service.payments.voucher(pubkey, wallet);
          return json(200, await service.payments.relayVoucher(voucher));
        }
        return json(200, service.ledger.register(pubkey));
      }
      if(req.method==='GET'&&pathname==='/v1/node'){
        if(pubkey!==service.pubkey)return error(403,'Node diagnostics require this desktop account');
        const state=service.status();return json(200,{inferencePrivacy:state.inferencePrivacy,setup:state.setup,serving:state.serving,browserDevices:state.browserDevices,donations:state.donations,slots:service.localSlots(),readyBrowserWorkers:state.browserDevices.filter(device=>device.free>0).length});
      }
      if (req.method === 'GET' && pathname === '/v1/account') {
        if (!service.requirePayments) return json(200, service.ledger.account(pubkey));
        const wallet = pubkey === service.pubkey ? service.payments?.wallet.address : service.ledger.db.prepare('SELECT wallet FROM account_wallets WHERE pubkey=?').get(pubkey)?.wallet;
        return json(200, wallet ? await service.payments.account(wallet) : { registered: false, wallet: null });
      }
      if (req.method === 'GET' && /^\/v1\/receipts\/[a-zA-Z0-9-]+$/.test(pathname)) {
        const receipt = service.receipt(pathname.split('/').at(-1), pubkey);
        return receipt ? json(200, receipt) : error(404, 'Receipt not found');
      }
      if (req.method === 'GET' && pathname === '/v1/models') {
        const state = service.status(); const ids = new Set([...state.serving, ...state.workers.flatMap(w => w.models)]);
        return json(200, { object: 'list', data: [AUTO_MODEL, ...ids].map(id => ({ id, object: 'model', created: 0, owned_by: 'llmesh' })), catalog: state.models, workers: state.workers });
      }
      if (req.method === 'POST' && pathname === '/v1/routes/preview') {
        const input = JSON.parse(raw); return json(200, service.route({ ...input, maxTokens: input.max_completion_tokens ?? input.max_tokens }));
      }
      if(req.method==='POST'&&pathname==='/v1/swarm/completions'){
        const input=JSON.parse(raw),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000);
        res.on('close',()=>controller.abort());
        try{if(input.stream)res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
          const result=await service.swarm(pubkey,Array.isArray(input.tasks)?input.tasks.map(task=>({...task,maxTokens:task.max_completion_tokens??task.max_tokens??task.maxTokens,privacy:task.privacy??input.privacy,allow_third_party:task.allow_third_party??input.allow_third_party})):input.tasks,{maxConcurrency:input.max_concurrency??16,signal:controller.signal,onEvent:event=>{
            if(!input.stream)return;if(res.writableLength>1048576){controller.abort();throw new Error('Client too slow');}res.write(`data: ${JSON.stringify(event)}\n\n`);
          }});
          if(input.stream)res.end(`data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`);else json(200,result);
        }finally{clearTimeout(timer);}return;
      }
      if (req.method !== 'POST' || pathname !== '/v1/chat/completions') return error(404, 'Not found');
      const input = JSON.parse(raw), stream = input.stream === true;
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 180000);
      res.on('close', () => controller.abort());
      const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000);
      let resolvedModel = input.model;
      const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created, model: resolvedModel,
        choices: [{ index: 0, delta, finish_reason }] });
      let text = '', first = true; const toolCalls = [];
      try {
        const result = await service.chat(pubkey, { ...input, maxTokens: input.max_completion_tokens ?? input.max_tokens ?? 512 }, delta => {
          const toolDelta = typeof delta === 'object' && delta.type === 'tool_calls';
          if (toolDelta) toolCalls.push(...delta.calls);
          else if (!stream) { text += delta; if (text.length > 262144) throw new Error('Response too large'); }
          if (!stream) return;
          if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          if (res.writableLength > 1024 * 1024) { controller.abort(); throw new Error('Client too slow'); }
          if (first) { res.write(`data: ${JSON.stringify(chunk({ role: 'assistant' }))}\n\n`); first = false; }
          res.write(`data: ${JSON.stringify(chunk(toolDelta ? { tool_calls: delta.calls } : { content: delta }))}\n\n`);
        }, controller.signal, route => { resolvedModel = route.model; });
        const usage = { prompt_tokens: result.promptTokens, completion_tokens: result.outputTokens, total_tokens: result.promptTokens + result.outputTokens };
        if (!stream) return json(200, { id, object: 'chat.completion', created, model: result.model,
          choices: [{ index: 0, message: { role: 'assistant', content: text || (toolCalls.length ? null : ''),
            ...(toolCalls.length ? { tool_calls: toolCalls.map(({ index, ...call }) => call) } : {}) }, finish_reason: result.finishReason }], usage, llmesh_receipt: result });
        if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ ...chunk({}, result.finishReason), ...(input.stream_options?.include_usage ? { usage } : {}), llmesh_receipt: result })}\n\ndata: [DONE]\n\n`);
      } catch (e) {
        if (res.headersSent) res.end(`data: ${JSON.stringify({ error: { message: e.message, type: 'llmesh_error' } })}\n\n`);
        else error(400, e.message);
      } finally { clearTimeout(timer); }
    } catch (e) { if (!res.headersSent) error(400, e.message); else res.end(); }
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  service.apiUrl = `${tls ? 'https' : 'http'}://${host.includes(':') ? '[' + host + ']' : host}:${server.address().port}`;
  return server;
}
