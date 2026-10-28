import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
export function loadKey(path, create, passphrase) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
  if (existing?.startsWith('{')) {
    if (!passphrase) throw new Error('LLMESH_KEY_PASSPHRASE is required to unlock headless keys');
    try {
      const envelope = JSON.parse(existing);
      if (envelope.format !== 'llmesh-key-v1') throw new Error('Unknown key format');
      const key = scryptSync(passphrase, Buffer.from(envelope.salt, 'hex'), 32);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'hex')), decipher.final()]).toString('utf8');
    } catch { throw new Error('Unable to unlock headless key; check the passphrase and file integrity'); }
  }
  const value = existing ?? create();
  if (passphrase) {
    const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(passphrase, salt, 32);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const body = JSON.stringify({ format: 'llmesh-key-v1', salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') });
    writeFileSync(path + '.tmp', body, { mode: 0o600 }); renameSync(path + '.tmp', path);
  } else if (!existing) writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
  return value;
}
