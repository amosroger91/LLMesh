import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { copyModel } from '../src/model-bundle.js';
import { Ollama } from '../src/ollama.js';

test('installed models load without a registry request', async () => {
  const ollama = new Ollama(); let warmed = false;
  ollama.ensureRunning = async () => {};
  ollama.installed = async () => ['qwen3.5:0.8b'];
  ollama.request = async () => { throw new Error('Registry must not be contacted'); };
  ollama.warm = async () => { warmed = true; };
  await ollama.install('qwen3.5:0.8b', () => {});
  assert.equal(warmed, true);
});

test('offline bundle installs without pull and rejects corrupt weights before exposing a model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llmesh-bundle-'));
  const source = join(directory, 'source'), target = join(directory, 'target');
  const relative = join('manifests', 'registry.ollama.ai', 'library', 'qwen3.5', '0.8b');
  try {
    const bytes = Buffer.from('test model'), digest = createHash('sha256').update(bytes).digest('hex');
    const blob = { digest: 'sha256:' + digest, size: bytes.length };
    await mkdir(join(source, 'blobs'), { recursive: true });
    await mkdir(join(source, 'manifests', 'registry.ollama.ai', 'library', 'qwen3.5'), { recursive: true });
    await writeFile(join(source, 'blobs', 'sha256-' + digest), bytes);
    await writeFile(join(source, relative), JSON.stringify({ schemaVersion: 2, config: blob, layers: [blob] }));
    const ollama = new Ollama(); ollama.bundleDirectory = source; ollama.cacheDirectory = target;
    ollama.ensureRunning = async () => {}; let reads = 0, warmed = false;
    ollama.installed = async () => ++reads === 1 ? [] : ['qwen3.5:0.8b'];
    ollama.request = async () => { throw new Error('No network expected'); };
    ollama.warm = async () => { warmed = true; };
    await ollama.install('qwen3.5:0.8b', () => {});
    assert.equal(warmed, true); assert.deepEqual(await readFile(join(target, 'blobs', 'sha256-' + digest)), bytes);
    await writeFile(join(source, 'blobs', 'sha256-' + digest), Buffer.from('bad model!'));
    const corrupt = join(directory, 'corrupt');
    await assert.rejects(copyModel('qwen3.5:0.8b', source, corrupt), /checksum mismatch/);
    await assert.rejects(readFile(join(corrupt, relative)), { code: 'ENOENT' });
    assert.equal(await copyModel('qwen3.5:2b', source, target), false);
    await assert.rejects(copyModel('../bad:model', source, target), /Unsupported/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
