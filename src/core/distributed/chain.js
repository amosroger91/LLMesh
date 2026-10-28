// Fake block chains for tests and planning. This does not run Petals, move tensors, or prove a model answer.
const pubkey = value => /^[a-f0-9]{64}$/.test(value ?? '');

export const DEFAULT_SPAN_OFFERS = 32;
export const MAX_SPAN_OFFERS = 64;

function offerLimit(maxOffers) {
  const limit = maxOffers === undefined ? DEFAULT_SPAN_OFFERS : maxOffers;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SPAN_OFFERS) throw new Error('Invalid offer limit');
  return limit;
}

function assertOffer(offer, now) {
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) throw new Error('Invalid span offer');
  if (typeof offer.peerId !== 'string' || !offer.peerId) throw new Error('Invalid span offer');
  if (!Number.isSafeInteger(offer.start) || !Number.isSafeInteger(offer.end) || offer.start < 0 || offer.end <= offer.start) throw new Error('Invalid span offer');
  if (offer.latencyMs != null && (!Number.isSafeInteger(offer.latencyMs) || offer.latencyMs < 0)) throw new Error('Invalid span offer');
  if (offer.expires != null && !Number.isSafeInteger(offer.expires)) throw new Error('Invalid span offer');
  if (!Number.isSafeInteger(now)) throw new Error('Invalid distributed clock');
}

function eligible(offer, { blockCount, allowlist, now, excludePeerIds, modelId, revision }) {
  if (offer.public === true || offer.busy === true || offer.capable === false || !pubkey(offer.pubkey) || !allowlist.has(offer.pubkey)) return false;
  if (modelId != null && offer.modelId !== modelId) return false;
  if (revision != null && offer.revision !== revision) return false;
  if (excludePeerIds.has(offer.peerId) || offer.end > blockCount) return false;
  return offer.expires == null || offer.expires > now;
}

function better(next, current) {
  if (!current) return true;
  if (next.latencyMs !== current.latencyMs) return next.latencyMs < current.latencyMs;
  if (next.spans.length !== current.spans.length) return next.spans.length < current.spans.length;
  for (let index = 0; index < next.spans.length; index += 1) {
    if (next.spans[index].peerId < current.spans[index].peerId) return true;
    if (next.spans[index].peerId > current.spans[index].peerId) return false;
  }
  return false;
}

export function splitAtoms(total, spans) {
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(spans) || !spans.length || spans.length > 64) throw new Error('Invalid distributed charge');
  let blockSum = 0n;
  const widths = spans.map(span => {
    if (!pubkey(span.worker) || !Number.isSafeInteger(span.blocks) || span.blocks < 1) throw new Error('Invalid distributed charge');
    blockSum += BigInt(span.blocks);
    return span.blocks;
  });
  let assigned = 0n;
  const totalAtoms = BigInt(total);
  return widths.map((blocks, index) => {
    const atoms = index === widths.length - 1 ? totalAtoms - assigned : totalAtoms * BigInt(blocks) / blockSum;
    if (atoms < 0n || atoms > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid distributed charge');
    assigned += atoms;
    return { worker: spans[index].worker, atoms: Number(atoms) };
  });
}

export function selectChain({ blockCount, offers, allowlist, now = Date.now(), excludePeerIds = [], modelId, revision, maxOffers }) {
  if (!Number.isSafeInteger(blockCount) || blockCount < 1 || blockCount > 4096) throw new Error('Invalid distributed model');
  if (modelId != null && (typeof modelId !== 'string' || !modelId)) throw new Error('Invalid distributed model');
  if (revision != null && (typeof revision !== 'string' || !revision)) throw new Error('Invalid distributed model');
  const limit = offerLimit(maxOffers);
  if (!Array.isArray(offers)) throw new Error('Invalid span offers');
  if (offers.length > limit) throw new Error('Too many span offers');
  if (allowlist != null && !Array.isArray(allowlist)) throw new Error('Invalid span offers');
  if (!Array.isArray(excludePeerIds)) throw new Error('Invalid span offers');
  const trusted = new Set(allowlist ?? []);
  const banned = new Set(excludePeerIds);
  const buckets = Array.from({ length: blockCount }, () => []);
  for (const offer of offers) {
    assertOffer(offer, now);
    if (!eligible(offer, { blockCount, allowlist: trusted, now, excludePeerIds: banned, modelId, revision })) continue;
    buckets[offer.start].push(offer);
  }
  // One best chain per block boundary. Each offer is considered once.
  const best = new Array(blockCount + 1);
  best[0] = { spans: [], latencyMs: 0 };
  for (let cursor = 0; cursor < blockCount; cursor += 1) {
    const chain = best[cursor];
    if (!chain) continue;
    for (const offer of buckets[cursor]) {
      const latencyMs = chain.latencyMs + (offer.latencyMs ?? 0);
      if (!Number.isSafeInteger(latencyMs)) throw new Error('Invalid span offer');
      const spans = chain.spans.concat([{ pubkey: offer.pubkey, peerId: offer.peerId, start: offer.start, end: offer.end, blocks: offer.end - offer.start, latencyMs: offer.latencyMs ?? 0 }]);
      if (spans.length > 64) continue;
      const candidate = { spans, latencyMs };
      if (better(candidate, best[offer.end])) best[offer.end] = candidate;
    }
  }
  const winner = best[blockCount];
  if (!winner) return null;
  return { spans: winner.spans, latencyMs: winner.latencyMs, peerIds: winner.spans.map(span => span.peerId) };
}

function visible(part) {
  return Boolean(part && (typeof part.text === 'string' && part.text.trim() || part.toolCall && typeof part.toolCall.name === 'string'));
}

export async function runDistributed({ ledger, payer, offers, blockCount, allowlist, reserved, used, forward, localOnly = false, hardwareOnly = false, enabled = false, now, modelId, revision, maxOffers }) {
  if (enabled !== true) throw new Error('Distributed serving is off');
  if (localOnly || hardwareOnly) throw new Error('Local-only requests stay on one machine');
  if (!Number.isSafeInteger(reserved) || !Number.isSafeInteger(used) || reserved < 1 || used < 0 || used > reserved) throw new Error('Invalid distributed charge');
  if (typeof modelId !== 'string' || !modelId || typeof revision !== 'string' || !revision) throw new Error('Distributed session requires a model revision');
  if (!Number.isSafeInteger(now)) throw new Error('Invalid distributed clock');
  let id = null, settled = false, sawOutput = false, rebuilt = false;
  const excluded = [];
  try {
    let chain = selectChain({ blockCount, offers, allowlist, now, modelId, revision, maxOffers });
    if (!chain) throw new Error('The model is not fully hosted');
    id = ledger.reserve(payer, reserved);
    let activation = 'prompt';
    const walk = async active => {
      activation = 'prompt';
      for (const span of active.spans) {
        let part;
        try { part = await forward(span, activation); }
        catch (error) { error.peerId = span.peerId; throw error; }
        if (visible(part)) sawOutput = true;
        if (typeof part?.activation !== 'string') throw Object.assign(new Error('Span returned no activation'), { peerId: span.peerId });
        activation = part.activation;
      }
    };
    for (;;) {
      try { await walk(chain); break; }
      catch (error) {
        if (sawOutput || rebuilt) throw error;
        excluded.push(error.peerId);
        const replacement = selectChain({ blockCount, offers, allowlist, now, excludePeerIds: excluded, modelId, revision, maxOffers });
        if (!replacement) throw error;
        rebuilt = true;
        chain = replacement;
      }
    }
    if (!sawOutput) throw new Error('Worker reported output tokens without returning output');
    const allocations = splitAtoms(used, chain.spans.map(span => ({ worker: span.pubkey, blocks: span.blocks })));
    settled = ledger.settleMany(id, allocations, used) === true;
    if (!settled) throw new Error('Distributed reservation was already settled');
    return { id, chain, text: activation, allocations, rebuilt };
  } catch (error) {
    if (id != null && !settled) ledger.cancel(id);
    throw error;
  }
}
