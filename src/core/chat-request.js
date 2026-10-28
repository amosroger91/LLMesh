import { catalog } from './catalog.js';
export const MAX_INPUT_CHARACTERS = 90000;
export const MAX_OUTPUT_TOKENS = 2048;

function textContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(part => part?.type === 'text' && typeof part.text === 'string')) return content.map(part => part.text).join('\n');
  throw new Error('Only text content parts are supported; images and audio are not supported');
}
function toolCall(call) {
  if (call?.type !== 'function' || !/^[\w.-]{1,128}$/.test(call.function?.name) || typeof call.id !== 'string' || call.id.length > 200)
    throw new Error('Invalid assistant function tool call');
  let args;
  try { args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments; }
  catch { throw new Error('Tool arguments must be valid JSON'); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object');
  return { id: call.id, type: 'function', function: { name: call.function.name, arguments: JSON.stringify(args) } };
}
export function validateJob(job) {
  if (!job || !(['auto', 'llmesh-auto', ...catalog.models.map(model => model.id)].includes(job.model) || typeof job.model === 'string' && /^donated:[a-z0-9-]{1,80}$/.test(job.model))) throw new Error('Unknown model; use llmesh-auto or an ID from GET /v1/models');
  if (!Array.isArray(job.messages) || job.messages.length < 1 || job.messages.length > 256) throw new Error('messages must contain 1–256 chat messages');
  if(job.privacy!=null&&!['mesh-only','allow-third-party'].includes(job.privacy))throw new Error('privacy must be mesh-only or allow-third-party');
  if(job.allow_third_party!=null&&typeof job.allow_third_party!=='boolean')throw new Error('allow_third_party must be boolean');
  if(job.privacy==='mesh-only'&&job.allow_third_party===true||job.privacy==='allow-third-party'&&job.allow_third_party===false)throw new Error('Conflicting privacy options');
  const privacy=job.privacy??(job.allow_third_party===true?'allow-third-party':'mesh-only');
  const messages = job.messages.map(message => {
    if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw new Error('Unsupported chat message role');
    const normalized = { role: message.role === 'developer' ? 'system' : message.role, content: textContent(message.content) };
    if (message.tool_calls != null) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length > 128) throw new Error('Invalid assistant tool_calls');
      normalized.tool_calls = message.tool_calls.map(toolCall);
    }
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || message.tool_call_id.length > 200) throw new Error('Tool results require tool_call_id');
      normalized.tool_call_id = message.tool_call_id;
    }
    return normalized;
  });
  let tools = job.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 128 || !tools.every(tool => tool?.type === 'function' && /^[\w.-]{1,128}$/.test(tool.function?.name) &&
      (tool.function.description == null || typeof tool.function.description === 'string') && tool.function.parameters && typeof tool.function.parameters === 'object' && !Array.isArray(tool.function.parameters)))
    throw new Error('tools must contain up to 128 function definitions with JSON Schema parameters');
  if (job.tool_choice != null && !['auto', 'none'].includes(job.tool_choice)) throw new Error('tool_choice currently supports auto or none');
  // Coding clients attach their full tool catalog even to an initial greeting.
  // A standalone greeting needs no tools; preserve every system/user message.
  const users=messages.filter(message=>message.role==='user');
  const greeting=JSON.stringify(tools).length>16000&&['auto','llmesh-auto'].includes(job.model)&&users.length===1&&!messages.some(message=>['assistant','tool'].includes(message.role))&&/^(?:hi|hello|hey|hiya|howdy|good (?:morning|afternoon|evening))[!.?\s]*$/i.test(users[0].content.trim())&&(!job.complexity||['auto','simple'].includes(job.complexity));
  const omittedTools=greeting?tools.length:0;if(greeting)tools=[];
  const inputCharacters = JSON.stringify({ messages, tools }).length;
  if (inputCharacters > MAX_INPUT_CHARACTERS) throw new Error(`Chat context and tools exceed ${MAX_INPUT_CHARACTERS} characters; compact the conversation or reduce enabled tools`);
  const limit = job.maxTokens ?? 512;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Output token limit must be a positive integer');
  const requestedMaxTokens = Number.isSafeInteger(job.requestedMaxTokens) ? Math.max(limit, job.requestedMaxTokens) : limit;
  const maxTokens = Math.min(limit, greeting?128:MAX_OUTPUT_TOKENS);
  if (job.complexity != null && !['auto', 'simple', 'standard', 'complex'].includes(job.complexity)) throw new Error('Invalid complexity level');
  if (job.allow_degraded != null && typeof job.allow_degraded !== 'boolean') throw new Error('allow_degraded must be boolean');
  return { model: job.model, privacy, messages, tools: tools.map(tool => ({ type: 'function', function: { ...tool.function } })),
    tool_choice:greeting?'none':job.tool_choice??'auto', maxTokens, requestedMaxTokens,
    adaptation:greeting?{kind:'standalone-greeting',omittedTools,outputLimit:maxTokens}:undefined,
    contextTokens: Math.min(32768, Math.max(4096, Math.ceil((inputCharacters / 3 + maxTokens + 512) / 1024) * 1024)),
    complexity: job.complexity ?? 'auto', allowDegraded: job.allow_degraded == null ? job.allowDegraded !== false : job.allow_degraded,
    instanceId: typeof job.instanceId==='string'?job.instanceId:undefined, workerKey: job.workerKey };
}
