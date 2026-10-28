# Distributed membership offers

Updated 2026-10-28. This describes `src/core/distributed/membership.js`. It checks an application-level signed offer. It does not join a swarm, open a socket, or decide that a model is running.

## Event

Kind `27240`, domain tag `llmesh-span-offer-v1`, content version `1`. This is not kind `27235` and it is not an HTTP authorization event. The tags are exactly `d`, `challenge`, and `expiration`, each once. The content is one flat object. Duplicate keys, extra keys, nested values, and escaped characters are rejected.

The signature covers the protocol version and domain, swarm id, session id, verifier challenge, Nostr pubkey, claimed transport peer id, model id, revision, half-open block span, and issued and expiry times. Verification recomputes the event id from those fields. A cached mark on the signer object is not accepted. The span end is at most 4096. The offer window is from 1 to 60 seconds. A verifier can require a shorter window. Its default is 30 seconds.

`signMembershipOffer(secret, fields)` builds that event. `MembershipVerifier` issues challenges and checks events.

## Challenges and replays

`issueChallenge()` returns a fresh 32-byte hex id and a short expiry. The default cap is 32 outstanding challenges. No caller can raise it above 64. Expired challenges are dropped before that cap is applied. A live challenge is not dropped to make room.

The challenge is removed only after every check has succeeded. A bad signature, a signer who is not on the allowlist, the wrong session, peer, or revision, a future or expired offer, or a full replay cache leaves the challenge outstanding.

Accepted event ids are remembered until the process exits. The default memory holds 64 ids. The hard cap is 256. When it is full, new offers are rejected and their challenges stay outstanding. The cache is not written to disk. After a restart every challenge and every remembered event id is gone. Old signatures still fail closed, because the verifier will not issue the same challenge id again. This memory is not a durable replay ledger.

## Trust boundary

The allowlist is checked after the signature and before the offer is returned. The returned object is `{ pubkey, peerId, modelId, revision, start, end, blocks, swarmId, sessionId, issued, expires, eventId }`. It has no latency and it is not yet a planner span.

The signature binds the Nostr key to the peer id written in the offer. The verifier also requires the caller to pass the same peer id as `transportPeerId`. That argument has to come from a transport session that authenticated the peer on its own. This module does not make that check. A private DHT address or an `initial_peers` list is not membership. The signature does not prove the process hosts the model, how fast it is, or that its output is correct.

Production admission still needs that independent transport identity, then the existing planner filters, before any request is reserved.
