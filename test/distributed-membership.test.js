import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { MembershipVerifier, signMembershipOffer, MEMBERSHIP_KIND, MEMBERSHIP_DOMAIN } from '../src/core/distributed/membership.js';

const swarmId = 'swarm-1';
const sessionId = 'session-1';
const modelId = 'bloom-560m';
const revision = 'rev-1';
const context = { transportPeerId: 'peer-a', modelId, revision };

function setup(extra = {}) {
  let time = 1_700_000_000_000;
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const outsiderSecret = generateSecretKey();
  const verifier = new MembershipVerifier({ allowlist: [pubkey], swarmId, sessionId, ...extra, now: () => time });
  return { at: value => { time = value; }, verifier, secret, pubkey, outsiderSecret, outsider: getPublicKey(outsiderSecret) };
}
function offer(env, fields = {}, secret = env.secret) {
  const challenge = env.verifier.issueChallenge();
  const event = signMembershipOffer(secret, {
    swarmId, sessionId, challenge: challenge.challenge, pubkey: getPublicKey(secret), peerId: 'peer-a',
    modelId, revision, start: 0, end: 4, issued: challenge.issued, expires: challenge.expires, ...fields
  });
  return { challenge, event };
}

test('a signed offer verifies once and returns the claimed span', () => {
  const env = setup();
  const { event } = offer(env);
  const admitted = env.verifier.verify(event, context);
  assert.equal(admitted.pubkey, env.pubkey);
  assert.equal(admitted.peerId, 'peer-a');
  assert.equal(admitted.blocks, 4);
  assert.equal(admitted.modelId, modelId);
  assert.equal(admitted.revision, revision);
  assert.equal(admitted.swarmId, swarmId);
  assert.equal(admitted.sessionId, sessionId);
  assert.equal(admitted.eventId, event.id);
  assert.equal(admitted.latencyMs, undefined);
  assert.throws(() => env.verifier.verify(event, context), /already used/);
});

test('allowlist rejection does not consume the challenge', () => {
  const env = setup();
  const challenge = env.verifier.issueChallenge();
  const foreign = signMembershipOffer(env.outsiderSecret, {
    swarmId, sessionId, challenge: challenge.challenge, pubkey: env.outsider, peerId: 'peer-a',
    modelId, revision, start: 1, end: 3, issued: challenge.issued, expires: challenge.expires
  });
  assert.throws(() => env.verifier.verify(foreign, { ...context, transportPeerId: 'peer-a' }), /not allowlisted/);
  const event = signMembershipOffer(env.secret, {
    swarmId, sessionId, challenge: challenge.challenge, pubkey: env.pubkey, peerId: 'peer-a',
    modelId, revision, start: 1, end: 3, issued: challenge.issued, expires: challenge.expires
  });
  assert.equal(env.verifier.verify(event, context).blocks, 2);
});

test('the offer must match the session, transport peer, and model revision', () => {
  const env = setup();
  const wrongSession = signMembershipOffer(env.secret, {
    ...body(env, offer(env).challenge), swarmId: 'other-swarm'
  });
  assert.throws(() => env.verifier.verify(wrongSession, context), /session does not match/);
  const { event } = offer(env);
  assert.throws(() => env.verifier.verify(event, { ...context, transportPeerId: 'peer-b' }), /transport peer/);
  assert.throws(() => env.verifier.verify(event, { ...context, revision: 'rev-2' }), /model revision/);
  assert.equal(env.verifier.verify(event, context).peerId, 'peer-a');
});

function body(env, challenge) {
  return {
    swarmId, sessionId, challenge: challenge.challenge, pubkey: env.pubkey, peerId: 'peer-a',
    modelId, revision, start: 0, end: 4, issued: challenge.issued, expires: challenge.expires
  };
}

test('future and expired offers do not burn a challenge', () => {
  const env = setup();
  const first = offer(env);
  env.at(first.challenge.issued - 1000);
  assert.throws(() => env.verifier.verify(first.event, context), /not current/);
  env.at(first.challenge.issued);
  assert.equal(env.verifier.verify(first.event, context).eventId, first.event.id);
  const second = offer(env);
  env.at(second.challenge.expires);
  assert.throws(() => env.verifier.verify(second.event, context), /expired/);
  assert.throws(() => env.verifier.verify(second.event, context), /expired/);
});

test('tampering, http auth events, duplicates, and oversize input are rejected', () => {
  const env = setup();
  const { event, challenge } = offer(env);
  const tampered = { ...event, content: event.content.replace('peer-a', 'peer-b') };
  assert.throws(() => env.verifier.verify(tampered, { ...context, transportPeerId: 'peer-b' }), /Invalid membership offer/);
  const inplace = offer(env);
  inplace.event.content = inplace.event.content.replace('peer-a', 'peer-b');
  assert.throws(() => env.verifier.verify(inplace.event, { ...context, transportPeerId: 'peer-b' }), /Invalid membership offer/);
  assert.equal(env.verifier.verify(event, context).peerId, 'peer-a');
  const httpAuth = finalizeEvent({ kind: 27235, created_at: 1_700_000_000, tags: [['u', 'https://example.test']], content: '' }, env.secret);
  assert.notEqual(httpAuth.kind, MEMBERSHIP_KIND);
  assert.throws(() => env.verifier.verify(httpAuth, context), /Invalid membership offer/);
  const duplicate = finalizeEvent({
    kind: MEMBERSHIP_KIND, created_at: 1_700_000_000,
    tags: [['d', MEMBERSHIP_DOMAIN], ['d', 'other'], ['challenge', challenge.challenge]],
    content: '{}'
  }, env.secret);
  assert.throws(() => env.verifier.verify(duplicate, context), /Invalid membership offer/);
  assert.throws(() => env.verifier.verify({ ...event, content: 'x'.repeat(2049) }, context), /too large/);
  assert.throws(() => signMembershipOffer(env.secret, { ...body(env, env.verifier.issueChallenge()), end: 4097 }), /Invalid membership offer/);
  const open = env.verifier.issueChallenge();
  const claimed = body(env, open);
  const ambiguous = finalizeEvent({
    kind: MEMBERSHIP_KIND, created_at: Math.floor(claimed.issued / 1000),
    tags: [['d', MEMBERSHIP_DOMAIN], ['challenge', claimed.challenge], ['expiration', String(Math.floor(claimed.expires / 1000))]],
    content: JSON.stringify({ ...claimed, pubkey: env.outsider })
  }, env.secret);
  assert.throws(() => env.verifier.verify(ambiguous, context), /Invalid membership offer/);
  const extra = finalizeEvent({
    kind: MEMBERSHIP_KIND, created_at: Math.floor(open.issued / 1000),
    tags: [['d', MEMBERSHIP_DOMAIN], ['challenge', open.challenge], ['expiration', String(Math.floor(open.expires / 1000))]],
    content: JSON.stringify({ note: 'extra', ...body(env, open) })
  }, env.secret);
  assert.throws(() => env.verifier.verify(extra, context), /Invalid membership offer/);
  assert.equal(env.verifier.verify(signMembershipOffer(env.secret, body(env, open)), context).pubkey, env.pubkey);
});

test('challenge and replay caches stay bounded without dropping a live challenge', () => {
  const env = setup({ maxChallenges: 1, maxReplays: 1 });
  const first = offer(env);
  assert.throws(() => env.verifier.issueChallenge(), /Too many outstanding challenges/);
  env.verifier.verify(first.event, context);
  const second = offer(env);
  assert.throws(() => env.verifier.verify(second.event, context), /replay cache is full/);
  assert.throws(() => env.verifier.verify(second.event, context), /replay cache is full/);
  env.at(second.challenge.expires + 1);
  const third = env.verifier.issueChallenge();
  assert.equal(third.challenge.length, 64);
  assert.throws(() => new MembershipVerifier({ allowlist: [], swarmId, sessionId, maxChallenges: Number.POSITIVE_INFINITY }), /configuration/);
  assert.throws(() => new MembershipVerifier({ allowlist: [], swarmId, sessionId, maxReplays: 257 }), /configuration/);
});
