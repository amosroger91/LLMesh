import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { copyModel, defaultBundle, defaultCache } from './model-bundle.js';
import { randomUUID } from 'node:crypto';

export async function* ndjson(body) {
  let pending = '';
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    if (pending.length > 2 ** 20) throw new Error('Stream frame exceeds 1 MiB');
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) yield JSON.parse(pending);
}

export class Ollama {
  constructor(base = 'http://127.0.0.1:11434') { this.base = base; }
  async request(path, body, signal) {
    const response = await fetch(this.base + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      signal: signal ?? AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response;
  }
  async available() { try { await this.request('/api/version'); return true; } catch { return false; } }
  async ensureRunning() {
    if (await this.available()) return;
    const local = process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe') : '';
    let executable = local && existsSync(local) ? local : 'ollama';
    this.child = spawn(executable, ['serve'], { windowsHide: true, stdio: 'ignore' });
    let failed;
    this.child.on('error', e => { failed = e; });
    for (let i = 0; i < 30; i++) {
      if (failed) {
        if (!this.installRuntime) throw new Error('Ollama runtime missing. Automatic runtime installation is unavailable on this platform. Install it from https://ollama.com/download and retry.');
        await this.installRuntime(); this.installRuntime = null;
        executable = local && existsSync(local) ? local : 'ollama'; failed = null;
        this.child = spawn(executable, ['serve'], { windowsHide: true, stdio: 'ignore' }); this.child.on('error', error => { failed = error; });
      }
      if (await this.available()) return;
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Ollama did not start. Install it from https://ollama.com/download.');
  }
  async install(model, progress) {
    this.installController = new AbortController();
    const signal = AbortSignal.any([this.installController.signal, AbortSignal.timeout(2 * 60 * 60 * 1000)]);
    await this.ensureRunning(); signal.throwIfAborted();
    if ((await this.installed()).includes(model)) {
      progress({ status: 'Using installed model; skipping registry download' });
    } else if (await copyModel(model, this.bundleDirectory ?? defaultBundle(), this.cacheDirectory ?? defaultCache(), progress, signal)) {
      if (!(await this.installed()).includes(model)) throw new Error('Offline model copied but not visible to Ollama. Its OLLAMA_MODELS directory must match LLMesh.');
    } else {
      for await (const item of ndjson((await this.request('/api/pull', { model, stream: true }, signal)).body)) {
        if (item.error) throw new Error(item.error);
        progress(item);
      }
    }
    progress({ status: 'Loading model into memory' }); await this.warm(model, signal);
  }
  async warm(model, signal) {
    await this.request('/api/chat', { model, messages: [], stream: false, keep_alive: this.profile?.keepAlive ?? '15m',
      options: { num_ctx: 4096, ...(this.profile ? { num_thread: this.profile.threads, num_batch: this.profile.batch, ...(this.profile.mode === 'cpu' ? { num_gpu: 0 } : {}) } : {}) } }, signal ?? AbortSignal.timeout(180000));
  }
  async unload(model) { await this.request('/api/generate', { model, keep_alive: 0, stream: false }); }
  cancelInstall() { this.installController?.abort(); }
  async installed() { return (await (await this.request('/api/tags')).json()).models.map(m => m.name); }
  async *chat(job, signal) {
    const callNames = new Map();
    const messages = job.messages.map(message => {
      const converted = { role: message.role, content: message.content };
      if (message.tool_calls?.length) converted.tool_calls = message.tool_calls.map(call => {
        callNames.set(call.id, call.function.name);
        return { function: { name: call.function.name, arguments: JSON.parse(call.function.arguments) } };
      });
      if (message.role === 'tool') converted.tool_name = callNames.get(message.tool_call_id) ?? '';
      return converted;
    });
    const response = await this.request('/api/chat', { model: job.model, messages,
      ...(job.tools?.length && job.tool_choice !== 'none' ? { tools: job.tools } : {}),
      stream: true, think: false, keep_alive: this.profile?.keepAlive ?? '15m', options: { num_ctx: job.contextTokens ?? 4096, num_predict: job.maxTokens,
        ...(this.profile ? { num_thread: this.profile.threads, num_batch: this.profile.batch, ...(this.profile.mode === 'cpu' ? { num_gpu: 0 } : {}) } : {}) } }, signal);
    let done = false, toolIndex = 0;
    for await (const item of ndjson(response.body)) {
      if (item.error) throw new Error(item.error);
      if (item.message?.content) yield { type: 'delta', text: item.message.content };
      if (item.message?.tool_calls?.length) {
        const calls = item.message.tool_calls.map(call => {
          if (typeof call.function?.name !== 'string' || !call.function.arguments || typeof call.function.arguments !== 'object') throw new Error('Model returned an invalid tool call');
          return { index: toolIndex++, id: 'call_' + randomUUID().replaceAll('-', ''), type: 'function',
            function: { name: call.function.name, arguments: JSON.stringify(call.function.arguments) } };
        });
        yield { type: 'tool_calls', calls };
      }
      if (item.done) { done = true; yield { type: 'done', tokens: item.eval_count ?? 0, promptTokens: item.prompt_eval_count ?? 0,
        finishReason: toolIndex ? 'tool_calls' : item.done_reason === 'length' ? 'length' : 'stop' }; }
    }
    if (!done) throw new Error('Ollama stream ended before completion');
  }
  async close() {
    this.installController?.abort();
    const child = this.child; this.child = null;
    if (!child?.pid || child.exitCode != null) return;
    // On Windows, killing only `ollama serve` leaves its llama-server children
    // alive with their RAM/VRAM allocations. Target only the server we own.
    if (process.platform === 'win32') {
      await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => child.kill());
    } else child.kill();
  }
}
