// Fake block chains for tests and planning. This does not run Petals, move tensors, or prove a model answer.
const pubkey = value => /^[a-f0-9]{64}$/.test(value ?? '');

export function splitAtoms(total, spans) {
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(spans) || !spans.length || spans.length > 64) throw new Error('Invalid distributed charge');
  const blocks = spans.reduce((sum, span) => {
    if (!pubkey(span.worker) || !Number.isSafeInteger(span.blocks) || span.blocks < 1) throw new Error('Invalid distributed charge');
    return sum + span.blocks;
  }, 0);
  let assigned = 0;
  return spans.map((span, index) => {
    const atoms = index === spans.length - 1 ? total - assigned : Math.floor(total * span.blocks / blocks);
    assigned += atoms;
    return { worker: span.worker, atoms };
  });
}

function eligible(offer, { blockCount, allowlist, now, excludePeerIds, modelId, revision }) {
  if (!offer || offer.public === true || offer.busy === true || offer.capable === false || !pubkey(offer.pubkey) || !allowlist.has(offer.pubkey)) return false;
  if (modelId != null && offer.modelId !== modelId) return false;
  if (revision != null && offer.revision !== revision) return false;
  if (typeof offer.peerId !== 'string' || !offer.peerId || excludePeerIds.has(offer.peerId)) return false;
  if (!Number.isSafeInteger(offer.start) || !Number.isSafeInteger(offer.end) || offer.start < 0 || offer.end <= offer.start || offer.end > blockCount) return false;
  if (offer.expires != null && offer.expires <= now) return false;
  const latency = offer.latencyMs ?? 0;
  return Number.isFinite(latency) && latency >= 0;
}

export function selectChain({ blockCount, offers, allowlist, now = Date.now(), excludePeerIds = [], modelId, revision, maxOffers = 32 }) {
  if (!Number.isSafeInteger(blockCount) || blockCount < 1 || blockCount > 4096) throw new Error('Invalid distributed model');
  if (!Array.isArray(offers) || offers.length > maxOffers) throw new Error('Too many span offers');
  const trusted = new Set(allowlist ?? []);
  const banned = new Set(excludePeerIds);
  const open = offers.filter(offer => eligible(offer, { blockCount, allowlist: trusted, now, excludePeerIds: banned, modelId, revision }));
  const found = [];
  const walk = (cursor, chain, latency) => {
    if (cursor === blockCount) {
      found.push({ spans: chain, latencyMs: latency, peerIds: chain.map(span => span.peerId) });
      return;
    }
    for (const offer of open) {
      // The next span must start on the current block, so a chain cannot overlap or skip.
      if (offer.start !== cursor) continue;
      walk(offer.end, chain.concat([{ pubkey: offer.pubkey, peerId: offer.peerId, start: offer.start, end: offer.end, blocks: offer.end - offer.start, latencyMs: offer.latencyMs ?? 0 }]), latency + (offer.latencyMs ?? 0));
    }
  };
  walk(0, [], 0);
  found.sort((a, b) => a.latencyMs - b.latencyMs || a.spans.length - b.spans.length || a.peerIds.join('\0').localeCompare(b.peerIds.join('\0')));
  return found[0] ?? null;
}

function visible(part) {
  return Boolean(part && (typeof part.text === 'string' && part.text.trim() || part.toolCall && typeof part.toolCall.name === 'string'));
}

export async function runDistributed({ ledger, payer, offers, blockCount, allowlist, reserved, used, forward, localOnly = false, hardwareOnly = false, enabled = false, now = Date.now(), modelId, revision, maxOffers }) {
  if (enabled !== true) throw new Error('Distributed serving is off');
  if (localOnly || hardwareOnly) throw new Error('Local-only requests stay on one machine');
  if (!Number.isSafeInteger(reserved) || !Number.isSafeInteger(used) || reserved < 1 || used < 0 || used > reserved) throw new Error('Invalid distributed charge');
  let chain = selectChain({ blockCount, offers, allowlist, now, modelId, revision, maxOffers });
  if (!chain) throw new Error('The model is not fully hosted');
  const id = ledger.reserve(payer, reserved);
  let settled = false, sawOutput = false, rebuilt = false;
  const excluded = [];
  try {
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
    if (!settled) ledger.cancel(id);
    throw error;
  }
}
