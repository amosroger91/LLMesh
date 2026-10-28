// Signed span-membership offers. A valid signature binds a Nostr key to the peer id it claims.
// It does not prove the transport session, that the model is loaded, or that an answer is correct.
import { randomBytes } from 'node:crypto';
import { finalizeEvent, getEventHash, verifyEvent } from 'nostr-tools/pure';

export const MEMBERSHIP_KIND = 27240;
export const MEMBERSHIP_DOMAIN = 'llmesh-span-offer-v1';
export const MEMBERSHIP_VERSION = 1;
export const MAX_MEMBERSHIP_TTL_MS = 60_000;
export const DEFAULT_MEMBERSHIP_TTL_MS = 30_000;
export const DEFAULT_MEMBERSHIP_CHALLENGES = 32;
export const MAX_MEMBERSHIP_CHALLENGES = 64;
export const DEFAULT_MEMBERSHIP_REPLAYS = 64;
export const MAX_MEMBERSHIP_REPLAYS = 256;
export const MAX_MEMBERSHIP_BYTES = 4096;
export const MAX_BLOCK_END = 4096;

const KEYS = ['v', 'domain', 'swarmId', 'sessionId', 'challenge', 'pubkey', 'peerId', 'modelId', 'revision', 'start', 'end', 'issued', 'expires'];
const NUMBERS = new Set(['v', 'start', 'end', 'issued', 'expires']);
const pubkey = value => /^[a-f0-9]{64}$/.test(value ?? '');
const label = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);

function bounded(value, fallback, max) {
  const limit = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) throw new Error('Invalid membership configuration');
  return limit;
}

function clock(now) {
  const time = now();
  if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid membership clock');
  return time;
}

function contentKeys(content) {
  if (typeof content !== 'string' || content.length > 2048 || content.length < 2 || content[0] !== '{' || content.at(-1) !== '}') throw new Error('Invalid membership offer');
  const keys = [];
  let index = 1;
  const end = content.length - 1;
  while (index < end) {
    while (index < end && (content[index] === ' ' || content[index] === '\n' || content[index] === ',')) index += 1;
    if (index >= end) break;
    if (content[index] !== '"') throw new Error('Invalid membership offer');
    const start = index + 1;
    index = content.indexOf('"', start);
    if (index <= start || content.slice(start, index).includes('\\')) throw new Error('Invalid membership offer');
    const key = content.slice(start, index);
    index += 1;
    while (content[index] === ' ') index += 1;
    if (content[index] !== ':') throw new Error('Invalid membership offer');
    index += 1;
    while (content[index] === ' ') index += 1;
    if (NUMBERS.has(key)) {
      const numberStart = index;
      while (index < end && content[index] !== ',' && content[index] !== ' ' && content[index] !== '\n') index += 1;
      if (!/^(0|[1-9]\d*)$/.test(content.slice(numberStart, index))) throw new Error('Invalid membership offer');
    } else if (content[index] === '"') {
      index += 1;
      const valueStart = index;
      index = content.indexOf('"', valueStart);
      if (index < valueStart || content.slice(valueStart, index).includes('\\')) throw new Error('Invalid membership offer');
      index += 1;
    } else throw new Error('Invalid membership offer');
    keys.push(key);
  }
  if (keys.length !== KEYS.length || new Set(keys).size !== keys.length || KEYS.some(key => !keys.includes(key))) throw new Error('Invalid membership offer');
  try { return JSON.parse(content); }
  catch { throw new Error('Invalid membership offer'); }
}

function fieldsOf(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid membership offer');
  if (typeof event.content === 'string' && event.content.length > 2048) throw new Error('Membership offer is too large');
  let encoded = '';
  try { encoded = JSON.stringify(event); }
  catch { throw new Error('Invalid membership offer'); }
  if (encoded.length > MAX_MEMBERSHIP_BYTES) throw new Error('Membership offer is too large');
  if (event.kind !== MEMBERSHIP_KIND || !pubkey(event.pubkey) || !pubkey(event.id)) throw new Error('Invalid membership offer');
  if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) throw new Error('Invalid membership offer');
  if (!Array.isArray(event.tags) || event.tags.length !== 3) throw new Error('Invalid membership offer');
  const tags = new Map();
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length !== 2 || typeof tag[0] !== 'string' || typeof tag[1] !== 'string' || tags.has(tag[0])) throw new Error('Invalid membership offer');
    tags.set(tag[0], tag[1]);
  }
  if (tags.get('d') !== MEMBERSHIP_DOMAIN || !pubkey(tags.get('challenge')) || !/^(0|[1-9]\d*)$/.test(tags.get('expiration') ?? '')) throw new Error('Invalid membership offer');
  const fields = contentKeys(event.content);
  if (fields.v !== MEMBERSHIP_VERSION || fields.domain !== MEMBERSHIP_DOMAIN || fields.pubkey !== event.pubkey || fields.challenge !== tags.get('challenge')) throw new Error('Invalid membership offer');
  if (![fields.swarmId, fields.sessionId, fields.peerId, fields.modelId, fields.revision].every(label)) throw new Error('Invalid membership offer');
  if (!Number.isSafeInteger(fields.start) || !Number.isSafeInteger(fields.end) || fields.start < 0 || fields.end <= fields.start || fields.end > MAX_BLOCK_END) throw new Error('Invalid membership offer');
  if (!Number.isSafeInteger(fields.issued) || !Number.isSafeInteger(fields.expires) || fields.expires - fields.issued < 1000 || fields.expires - fields.issued > MAX_MEMBERSHIP_TTL_MS) throw new Error('Invalid membership offer');
  if (event.created_at !== Math.floor(fields.issued / 1000) || tags.get('expiration') !== String(Math.floor(fields.expires / 1000))) throw new Error('Invalid membership offer');
  return fields;
}

export function signMembershipOffer(secret, fields) {
  const body = {
    v: MEMBERSHIP_VERSION, domain: MEMBERSHIP_DOMAIN, swarmId: fields?.swarmId, sessionId: fields?.sessionId,
    challenge: fields?.challenge, pubkey: fields?.pubkey, peerId: fields?.peerId, modelId: fields?.modelId,
    revision: fields?.revision, start: fields?.start, end: fields?.end, issued: fields?.issued, expires: fields?.expires
  };
  const event = finalizeEvent({
    kind: MEMBERSHIP_KIND,
    created_at: Math.floor(body.issued / 1000),
    tags: [['d', MEMBERSHIP_DOMAIN], ['challenge', body.challenge], ['expiration', String(Math.floor(body.expires / 1000))]],
    content: JSON.stringify(body)
  }, secret);
  fieldsOf(event);
  return event;
}

export class MembershipVerifier {
  constructor({ allowlist, swarmId, sessionId, now = Date.now, ttlMs, maxChallenges, maxReplays } = {}) {
    if (!Array.isArray(allowlist) || !label(swarmId) || !label(sessionId) || typeof now !== 'function') throw new Error('Invalid membership configuration');
    this.allowlist = new Set(allowlist);
    for (const key of this.allowlist) if (!pubkey(key)) throw new Error('Invalid membership configuration');
    this.swarmId = swarmId;
    this.sessionId = sessionId;
    this.now = now;
    this.ttlMs = bounded(ttlMs, DEFAULT_MEMBERSHIP_TTL_MS, MAX_MEMBERSHIP_TTL_MS);
    if (this.ttlMs < 1000) throw new Error('Invalid membership configuration');
    this.maxChallenges = bounded(maxChallenges, DEFAULT_MEMBERSHIP_CHALLENGES, MAX_MEMBERSHIP_CHALLENGES);
    this.maxReplays = bounded(maxReplays, DEFAULT_MEMBERSHIP_REPLAYS, MAX_MEMBERSHIP_REPLAYS);
    this.challenges = new Map();
    this.replays = new Set();
  }

  issueChallenge() {
    const now = clock(this.now);
    for (const [id, challenge] of this.challenges) if (challenge.expires <= now) this.challenges.delete(id);
    if (this.challenges.size >= this.maxChallenges) throw new Error('Too many outstanding challenges');
    const id = randomBytes(32).toString('hex');
    const record = { id, issued: now, expires: now + this.ttlMs };
    this.challenges.set(id, record);
    return { challenge: id, issued: record.issued, expires: record.expires, swarmId: this.swarmId, sessionId: this.sessionId, domain: MEMBERSHIP_DOMAIN, version: MEMBERSHIP_VERSION, kind: MEMBERSHIP_KIND };
  }

  verify(event, { transportPeerId, modelId, revision } = {}) {
    const now = clock(this.now);
    const fields = fieldsOf(event);
    if (fields.expires - fields.issued > this.ttlMs) throw new Error('Invalid membership offer');
    // The signer object can carry a cached verification mark. Recompute the id and check a plain copy.
    let signed = false;
    try {
      const plain = { id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content, sig: event.sig };
      signed = getEventHash(plain) === event.id && verifyEvent(plain) === true;
    } catch { signed = false; }
    if (!signed) throw new Error('Invalid membership offer');
    if (!this.allowlist.has(event.pubkey)) throw new Error('Membership signer is not allowlisted');
    if (fields.swarmId !== this.swarmId || fields.sessionId !== this.sessionId) throw new Error('Membership session does not match');
    if (!label(transportPeerId) || fields.peerId !== transportPeerId) throw new Error('Membership transport peer does not match');
    if (!label(modelId) || !label(revision) || fields.modelId !== modelId || fields.revision !== revision) throw new Error('Membership model revision does not match');
    if (fields.issued > now) throw new Error('Membership offer is not current');
    if (fields.expires <= now) throw new Error('Membership offer expired');
    if (this.replays.has(event.id)) throw new Error('Membership offer was already used');
    if (this.replays.size >= this.maxReplays) throw new Error('Membership replay cache is full');
    const challenge = this.challenges.get(fields.challenge);
    if (!challenge) throw new Error('Unknown membership challenge');
    if (challenge.expires <= now) {
      this.challenges.delete(fields.challenge);
      throw new Error('Membership challenge expired');
    }
    if (fields.issued < challenge.issued || fields.expires > challenge.expires) throw new Error('Membership offer is not current');
    this.challenges.delete(fields.challenge);
    this.replays.add(event.id);
    return {
      pubkey: event.pubkey, peerId: fields.peerId, modelId: fields.modelId, revision: fields.revision,
      start: fields.start, end: fields.end, blocks: fields.end - fields.start, swarmId: fields.swarmId,
      sessionId: fields.sessionId, issued: fields.issued, expires: fields.expires, eventId: event.id
    };
  }
}
