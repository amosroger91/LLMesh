import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKey } from '../src/key-store.js';
test('headless keys are encrypted with a passphrase and plaintext keys migrate without changing identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-keys-')), path = join(directory, 'identity.key');
  const secret = 'a'.repeat(64), passphrase = 'correct horse battery staple';
  try {
    writeFileSync(path, secret);
    assert.equal(loadKey(path, () => 'unused', passphrase), secret);
    assert.ok(!readFileSync(path, 'utf8').includes(secret));
    assert.equal(loadKey(path, () => 'unused', passphrase), secret);
    assert.throws(() => loadKey(path, () => 'unused'), /passphrase/i);
    assert.throws(() => loadKey(path, () => 'unused', 'wrong passphrase'), /unlock/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
