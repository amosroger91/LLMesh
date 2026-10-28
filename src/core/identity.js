import { createHash, randomBytes } from 'node:crypto';
import { finalizeEvent, verifyEvent, getPublicKey, generateSecretKey } from 'nostr-tools/pure';

export { generateSecretKey, getPublicKey };
export const hash = value => createHash('sha256').update(value).digest('hex');
export function signAuth(secret, url, method, body = '') {
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '',
    tags: [['u', url], ['method', method], ['payload', hash(body)], ['nonce', randomBytes(16).toString('hex')]] }, secret);
  return 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64');
}
export function authenticate(header, url, method, body, ledger) {
  if (!header?.startsWith('Nostr ') || header.length > 8192) throw new Error('Nostr authorization required');
  const event = JSON.parse(Buffer.from(header.slice(6), 'base64').toString());
  const tag = name => event.tags.filter(t => t[0] === name);
  if (!verifyEvent(event) || event.kind !== 27235 || Math.abs(Date.now() / 1000 - event.created_at) > 60 ||
      tag('u').length !== 1 || tag('u')[0][1] !== url || tag('method').length !== 1 || tag('method')[0][1] !== method ||
      tag('payload').length !== 1 || tag('payload')[0][1] !== hash(body)) throw new Error('Invalid or expired Nostr authorization');
  ledger.consumeAuth(event.id, event.created_at + 61);
  return event.pubkey;
}
