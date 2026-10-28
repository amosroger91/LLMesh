import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, copyFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const defaultCache = () => process.env.OLLAMA_MODELS || join(homedir(), '.ollama', 'models');
export const defaultBundle = () => process.resourcesPath && existsSync(join(process.resourcesPath, 'model-bundle'))
  ? join(process.resourcesPath, 'model-bundle')
  : fileURLToPath(new URL('../../models/ollama/', import.meta.url));

function manifestPath(root, model) {
  if (!/^qwen[\w.]*:[\w.-]+$/.test(model)) throw new Error('Unsupported bundle model');
  const [name, tag] = model.split(':');
  return join(root, 'manifests', 'registry.ollama.ai', 'library', name, tag);
}
async function digestFile(path, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest('hex');
}

// Verify every weight/config/license blob before publishing a manifest to Ollama.
export async function copyModel(model, source, target, progress = () => {}, signal) {
  let raw;
  try { raw = await readFile(manifestPath(source, model), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let manifest = JSON.parse(raw);
  // Cached multi-runner manifests can refer to an uncached MLX variant. Bundle
  // the cached llama.cpp manifest alone, retaining its weights and license.
  const leaf = manifest.layers?.find(layer => layer.mediaType === 'application/vnd.docker.distribution.manifest.v2+json');
  if (leaf && manifest.runner === 'llamacpp') {
    if (!/^sha256:[a-f0-9]{64}$/.test(leaf.digest)) throw new Error('Invalid bundled manifest digest');
    const path = join(source, 'blobs', leaf.digest.replace(':', '-'));
    if (await digestFile(path, signal) !== leaf.digest.slice(7)) throw new Error('Bundled manifest checksum mismatch');
    raw = await readFile(path, 'utf8'); manifest = JSON.parse(raw);
  }
  if (manifest.schemaVersion !== 2 || !manifest.config || !Array.isArray(manifest.layers) || manifest.layers.length > 30) throw new Error('Invalid model bundle manifest');
  const blobs = [manifest.config, ...manifest.layers];
  await mkdir(join(target, 'blobs'), { recursive: true });
  for (let index = 0; index < blobs.length; index++) {
    signal?.throwIfAborted();
    const blob = blobs[index];
    if (!/^sha256:[a-f0-9]{64}$/.test(blob.digest) || !Number.isSafeInteger(blob.size) || blob.size < 0) throw new Error('Invalid model bundle blob');
    const name = blob.digest.replace(':', '-'), from = join(source, 'blobs', name), to = join(target, 'blobs', name);
    progress({ status: `Verifying offline model file ${index + 1}/${blobs.length}` });
    if ((await stat(from)).size !== blob.size || await digestFile(from, signal) !== blob.digest.slice(7)) throw new Error(`Model bundle checksum mismatch: ${name}`);
    let present = false;
    try { present = (await stat(to)).size === blob.size && await digestFile(to, signal) === blob.digest.slice(7); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!present) {
      const temporary = to + '.' + randomUUID() + '.tmp';
      await copyFile(from, temporary); signal?.throwIfAborted(); await rename(temporary, to);
    }
  }
  signal?.throwIfAborted();
  const destination = manifestPath(target, model); await mkdir(dirname(destination), { recursive: true });
  const temporary = destination + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, raw); await rename(temporary, destination);
  progress({ status: 'Offline model imported; no registry download needed' });
  return true;
}
