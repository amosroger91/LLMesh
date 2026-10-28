import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/core/ledger.js';
import { splitAtoms, selectChain, runDistributed, MAX_SPAN_OFFERS } from '../src/core/distributed/chain.js';
import { STARTER_CREDITS, CREDIT_SCALE } from '../src/core/pricing.js';

const payer = 'd'.repeat(64), a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
const grant = STARTER_CREDITS * CREDIT_SCALE;
const blockCount = 4;
const modelId = 'bloom-560m';
const revision = 'rev-1';
const clock = 1_000;
const offers = [
  { pubkey: a, peerId: 'peer-a', start: 0, end: 1, latencyMs: 10 },
  { pubkey: b, peerId: 'peer-b', start: 1, end: 3, latencyMs: 20 },
  { pubkey: c, peerId: 'peer-c', start: 3, end: 4, latencyMs: 15 },
  { pubkey: a, peerId: 'peer-a-slow', start: 0, end: 1, latencyMs: 80 },
  { pubkey: 'e'.repeat(64), peerId: 'stranger', start: 0, end: 4, latencyMs: 1 },
  { pubkey: b, peerId: 'public-b', start: 1, end: 3, latencyMs: 1, public: true }
].map(offer => ({ modelId, revision, ...offer }));
const allowlist = [a, b, c];
const pass = (span, activation) => ({ activation: activation + '/' + span.peerId, text: span.end === blockCount ? 'answer' : '' });

function ledger() {
  const book = new Ledger(':memory:');
  book.register(payer);
  return book;
}
function shares(book, id) { return JSON.parse(book.db.prepare('SELECT payouts FROM settlement_splits WHERE id=?').get(id).payouts); }
function sum(book, column) { return book.db.prepare(`SELECT COALESCE(SUM(${column}),0) AS n FROM accounts`).get().n; }
function tag(offer, extra = {}) { return { modelId, revision, expires: 5_000, ...offer, ...extra }; }
function distributed(book, extra = {}) {
  return runDistributed({ ledger: book, payer, offers, blockCount, allowlist, reserved: 100, used: 10, modelId, revision, now: clock, enabled: true, forward: async (span, activation) => pass(span, activation), ...extra });
}
function untouched(book, refunded = 0) {
  assert.equal(book.account(payer).balance, grant);
  assert.equal(book.account(payer).redeemable, 0);
  assert.equal(book.account(payer).earned_total, 0);
  assert.equal(book.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='settled'").get().n, 0);
  assert.equal(book.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='reserved'").get().n, 0);
  assert.equal(book.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='refunded'").get().n, refunded);
  assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM settlement_splits').get().n, 0);
}

test('integer block shares sum to one charge and the last span takes the remainder', () => {
  const split = splitAtoms(10, [{ worker: a, blocks: 1 }, { worker: b, blocks: 2 }, { worker: c, blocks: 1 }]);
  assert.deepEqual(split.map(item => item.atoms), [2, 5, 3]);
  assert.equal(split.reduce((total, item) => total + item.atoms, 0), 10);
  const big = Number.MAX_SAFE_INTEGER;
  const near = splitAtoms(big, [{ worker: a, blocks: big }, { worker: b, blocks: 1 }]);
  assert.deepEqual(near.map(item => item.atoms), [big - 1, 1]);
  const wide = splitAtoms(5, [{ worker: a, blocks: big }, { worker: b, blocks: big }, { worker: c, blocks: 2 }]);
  assert.deepEqual(wide.map(item => item.atoms), [2, 2, 1]);
  assert.equal(wide.reduce((total, item) => total + item.atoms, 0), 5);
});

test('chain selection keeps an allowlisted cover and pins its peer ids', () => {
  const chain = selectChain({ blockCount, offers, allowlist });
  assert.deepEqual(chain.peerIds, ['peer-a', 'peer-b', 'peer-c']);
  assert.equal(selectChain({ blockCount, offers: offers.filter(offer => offer.peerId !== 'peer-b'), allowlist }), null);
  assert.equal(selectChain({ blockCount, offers, allowlist: [a, c] }), null);
  assert.equal(selectChain({ blockCount, allowlist, offers: [
    { pubkey: a, peerId: 'peer-a', start: 0, end: 1 },
    { pubkey: c, peerId: 'peer-c', start: 2, end: 4 }
  ] }), null);
});

test('selection requires one model revision and drops incapable, busy, or stale hosts', () => {
  const now = 1_000;
  const tagged = offers.map(offer => tag(offer));
  const chain = selectChain({ blockCount, offers: tagged, allowlist, now, modelId, revision });
  assert.deepEqual(chain.peerIds, ['peer-a', 'peer-b', 'peer-c']);
  assert.equal(selectChain({ blockCount, offers: tagged, allowlist, now, modelId: 'other-model', revision }), null);
  assert.equal(selectChain({ blockCount, offers: tagged, allowlist, now, modelId, revision: 'rev-2' }), null);
  const incapable = tagged.map(offer => offer.peerId === 'peer-b' ? { ...offer, capable: false } : offer);
  assert.equal(selectChain({ blockCount, offers: incapable, allowlist, now, modelId, revision }), null);
  const busy = tagged.map(offer => offer.peerId === 'peer-b' ? { ...offer, busy: true } : offer);
  assert.equal(selectChain({ blockCount, offers: busy, allowlist, now, modelId, revision }), null);
  assert.equal(selectChain({ blockCount, offers: tagged, allowlist, now: 5_000, modelId, revision }), null);
  const spare = tag({ pubkey: b, peerId: 'peer-b2', start: 1, end: 3, latencyMs: 40 });
  const replaced = selectChain({ blockCount, offers: [...incapable, spare], allowlist, now, modelId, revision });
  assert.deepEqual(replaced.peerIds, ['peer-a', 'peer-b2', 'peer-c']);
});

test('ranking follows latency, then fewer spans, then peer id, after trust filters', () => {
  const cover = (peerId, latencyMs, extra = {}) => ({ pubkey: a, peerId, start: 0, end: 4, latencyMs, ...extra });
  const trusted = selectChain({ blockCount, allowlist: [a], offers: [cover('peer-public', 1, { public: true }), cover('peer-private', 50)] });
  assert.deepEqual(trusted.peerIds, ['peer-private']);
  const fewer = selectChain({ blockCount, allowlist: [a, b], offers: [
    cover('peer-whole', 20),
    { pubkey: b, peerId: 'peer-left', start: 0, end: 2, latencyMs: 10 },
    { pubkey: b, peerId: 'peer-right', start: 2, end: 4, latencyMs: 10 }
  ] });
  assert.deepEqual(fewer.peerIds, ['peer-whole']);
  const faster = selectChain({ blockCount, allowlist: [a, b], offers: [
    cover('peer-whole', 30),
    { pubkey: b, peerId: 'peer-left', start: 0, end: 2, latencyMs: 5 },
    { pubkey: b, peerId: 'peer-right', start: 2, end: 4, latencyMs: 5 }
  ] });
  assert.deepEqual(faster.peerIds, ['peer-left', 'peer-right']);
  const names = selectChain({ blockCount, allowlist: [a, b], offers: [cover('peer-z', 10), cover('peer-m', 10, { pubkey: b })] });
  assert.deepEqual(names.peerIds, ['peer-m']);
  const order = selectChain({ blockCount, allowlist, offers: [
    { pubkey: b, peerId: 'peer-b', start: 0, end: 2, latencyMs: 5 },
    { pubkey: a, peerId: 'peer-a', start: 2, end: 4, latencyMs: 5 },
    { pubkey: c, peerId: 'peer-c', start: 0, end: 2, latencyMs: 5 },
    { pubkey: a, peerId: 'peer-d', start: 2, end: 4, latencyMs: 5 }
  ] });
  assert.deepEqual(order.peerIds, ['peer-b', 'peer-a']);
});

test('repeated and overlapping offers still make one contiguous cover', () => {
  const repeated = [
    { pubkey: a, peerId: 'peer-a', start: 0, end: 2, latencyMs: 10 },
    { pubkey: a, peerId: 'peer-a', start: 0, end: 2, latencyMs: 10 },
    { pubkey: b, peerId: 'peer-overlap', start: 1, end: 3, latencyMs: 1 },
    { pubkey: b, peerId: 'peer-b', start: 2, end: 4, latencyMs: 10 },
    { pubkey: c, peerId: 'peer-gap', start: 3, end: 4, latencyMs: 1 }
  ];
  const chain = selectChain({ blockCount, offers: repeated, allowlist });
  assert.deepEqual(chain.peerIds, ['peer-a', 'peer-b']);
  assert.equal(chain.spans.reduce((total, span) => total + span.blocks, 0), blockCount);
  assert.equal(selectChain({ blockCount, offers: repeated.filter(offer => offer.peerId !== 'peer-b'), allowlist }), null);
  const stitched = selectChain({ blockCount, allowlist: [a], offers: [
    { pubkey: a, peerId: 'peer-a', start: 0, end: 2, latencyMs: 4 },
    { pubkey: a, peerId: 'peer-a', start: 2, end: 4, latencyMs: 4 }
  ] });
  assert.deepEqual(stitched.peerIds, ['peer-a', 'peer-a']);
  assert.deepEqual(stitched.spans.map(span => span.blocks), [2, 2]);
});

test('duplicate overlapping offers still resolve to one bounded cover', () => {
  const width = 6;
  const dense = [];
  for (let start = 0; start < width; start += 1) {
    for (let end = start + 1; end <= width; end += 1) {
      dense.push({ pubkey: a, peerId: 'slow-' + start + '-' + end, start, end, latencyMs: 9 });
      dense.push({ pubkey: a, peerId: 'slow-' + start + '-' + end, start, end, latencyMs: 9 });
    }
  }
  dense.push({ pubkey: b, peerId: 'peer-left', start: 0, end: 3, latencyMs: 4 });
  dense.push({ pubkey: b, peerId: 'peer-right', start: 3, end: 6, latencyMs: 4 });
  dense.push({ pubkey: c, peerId: 'peer-public', start: 0, end: 6, latencyMs: 1, public: true });
  const chain = selectChain({ blockCount: width, offers: dense, allowlist, maxOffers: MAX_SPAN_OFFERS });
  assert.deepEqual(chain.peerIds, ['peer-left', 'peer-right']);
  assert.equal(chain.latencyMs, 8);
  assert.throws(() => selectChain({ blockCount, offers: dense.slice(0, 1), allowlist, maxOffers: MAX_SPAN_OFFERS + 1 }), /Invalid offer limit/);
  assert.throws(() => selectChain({ blockCount, offers: dense.slice(0, 1), allowlist, maxOffers: Number.POSITIVE_INFINITY }), /Invalid offer limit/);
  assert.throws(() => selectChain({ blockCount, offers: [{ pubkey: a, peerId: 'bad', start: 0, end: 1, latencyMs: Number.NaN }], allowlist }), /Invalid span offer/);
  assert.throws(() => selectChain({ blockCount, offers: [{ pubkey: a, peerId: 'bad', start: 0, end: 1, expires: Number.POSITIVE_INFINITY }], allowlist, now: clock }), /Invalid span offer/);
});

test('too many span offers are rejected before any reservation', async () => {
  const many = Array.from({ length: 33 }, (_, index) => ({ pubkey: a, peerId: 'peer-' + index, start: 0, end: 1, latencyMs: 1 }));
  assert.throws(() => selectChain({ blockCount, offers: many, allowlist }), /Too many span offers/);
  assert.equal(selectChain({ blockCount, offers: many.slice(0, 32), allowlist }), null);
  const book = ledger();
  try {
    await assert.rejects(distributed(book, { offers: many }), /Too many span offers/);
    assert.equal(book.account(payer).balance, grant);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
  } finally { book.close(); }
});

test('a session pays the matching revision and does not reserve a stale or foreign chain', async () => {
  const book = ledger();
  const tagged = [
    tag({ pubkey: a, peerId: 'peer-a', start: 0, end: 1, latencyMs: 10 }),
    tag({ pubkey: b, peerId: 'peer-b', start: 1, end: 3, latencyMs: 20 }),
    tag({ pubkey: c, peerId: 'peer-c', start: 3, end: 4, latencyMs: 15 }),
    tag({ pubkey: b, peerId: 'peer-old', start: 0, end: 4, latencyMs: 1 }, { revision: 'rev-0' })
  ];
  try {
    const result = await runDistributed({ ledger: book, payer, offers: tagged, blockCount, allowlist, reserved: 100, used: 10, enabled: true, modelId, revision, now: 1_000, forward: async (span, activation) => pass(span, activation) });
    assert.deepEqual(result.chain.peerIds, ['peer-a', 'peer-b', 'peer-c']);
    assert.equal(book.account(b).balance, 5);
    await assert.rejects(runDistributed({ ledger: book, payer, offers: tagged, blockCount, allowlist, reserved: 100, used: 10, enabled: true, modelId, revision: 'rev-9', now: 1_000, forward: async (span, activation) => pass(span, activation) }), /not fully hosted/);
    await assert.rejects(runDistributed({ ledger: book, payer, offers: tagged, blockCount, allowlist, reserved: 100, used: 10, enabled: true, modelId, revision, now: 5_000, forward: async (span, activation) => pass(span, activation) }), /not fully hosted/);
    assert.equal(book.account(payer).balance, grant - 10);
    assert.equal(book.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='reserved'").get().n, 0);
    assert.equal(book.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='settled'").get().n, 1);
  } finally { book.close(); }
});

test('a rebuild stays on the same model revision', async () => {
  const book = ledger();
  const tagged = [
    tag({ pubkey: a, peerId: 'peer-a', start: 0, end: 1, latencyMs: 10 }),
    tag({ pubkey: b, peerId: 'peer-b', start: 1, end: 3, latencyMs: 10 }),
    tag({ pubkey: c, peerId: 'peer-c', start: 3, end: 4, latencyMs: 10 }),
    tag({ pubkey: b, peerId: 'peer-fast-old', start: 1, end: 3, latencyMs: 1 }, { revision: 'rev-0' }),
    tag({ pubkey: b, peerId: 'peer-b2', start: 1, end: 3, latencyMs: 30 })
  ];
  try {
    const result = await runDistributed({ ledger: book, payer, offers: tagged, blockCount, allowlist, reserved: 100, used: 10, enabled: true, modelId, revision, now: 1_000, forward: async (span, activation) => {
      if (span.peerId === 'peer-b') throw new Error('span disconnected');
      return pass(span, activation);
    } });
    assert.equal(result.rebuilt, true);
    assert.deepEqual(result.chain.peerIds, ['peer-a', 'peer-b2', 'peer-c']);
    assert.equal(book.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='settled'").get().n, 1);
  } finally { book.close(); }
});

test('a fake chain debits the payer once and pays each span through the ledger', async () => {
  const book = ledger();
  try {
    const result = await distributed(book);
    assert.equal(result.text, 'prompt/peer-a/peer-b/peer-c');
    assert.deepEqual(result.allocations.map(item => item.atoms), [2, 5, 3]);
    assert.equal(book.settleMany(result.id, result.allocations, 10), false);
    assert.equal(book.account(payer).balance, grant - 10);
    assert.equal(book.account(payer).redeemable, 0);
    assert.equal(book.account(payer).earned_total, 0);
    assert.equal(book.account(a).balance, 2);
    assert.equal(book.account(b).balance, 5);
    assert.equal(book.account(c).balance, 3);
    assert.equal(book.account(a).redeemable, 0);
    assert.equal(book.account(a).earned_total, 2);
    assert.deepEqual(shares(book, result.id).map(item => item.atoms), [2, 5, 3]);
    assert.equal(sum(book, 'balance'), grant);
    assert.equal(sum(book, 'redeemable'), 0);
    assert.equal(book.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='settled'").get().n, 1);
  } finally { book.close(); }
});

test('a self-hosted span does not turn the starter grant into earned credits', async () => {
  const book = ledger();
  const selfOffers = [
    { pubkey: a, peerId: 'peer-a', start: 0, end: 1, latencyMs: 10 },
    { pubkey: payer, peerId: 'peer-self', start: 1, end: 3, latencyMs: 10 },
    { pubkey: c, peerId: 'peer-c', start: 3, end: 4, latencyMs: 10 }
  ].map(offer => ({ modelId, revision, ...offer }));
  try {
    await distributed(book, { offers: selfOffers, allowlist: [a, payer, c] });
    assert.equal(book.account(payer).earned_total, 0);
    assert.equal(book.account(payer).redeemable, 0);
    assert.equal(book.account(payer).balance, grant - 5);
    assert.equal(book.account(a).earned_total, 2);
    assert.equal(book.account(c).earned_total, 3);
    assert.equal(sum(book, 'balance'), grant);
  } finally { book.close(); }
});

test('losing a span before output rebuilds once inside the same reservation', async () => {
  const book = ledger();
  let failed = false;
  const extra = { pubkey: b, peerId: 'peer-b2', start: 1, end: 3, latencyMs: 30, modelId, revision };
  try {
    const result = await distributed(book, { offers: [...offers, extra], forward: async (span, activation) => {
      if (span.peerId === 'peer-b' && !failed) { failed = true; throw new Error('span disconnected'); }
      return pass(span, activation);
    } });
    assert.equal(result.rebuilt, true);
    assert.deepEqual(result.chain.peerIds, ['peer-a', 'peer-b2', 'peer-c']);
    assert.equal(book.account(payer).balance, grant - 10);
    assert.equal(book.account(b).balance, 5);
    assert.equal(book.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='settled'").get().n, 1);
    assert.equal(shares(book, result.id).find(item => item.worker === b).atoms, 5);
  } finally { book.close(); }
});

test('a span failure after visible output refunds the reservation and does not retry', async () => {
  const book = ledger();
  let forwards = 0;
  const extra = { pubkey: b, peerId: 'peer-b2', start: 1, end: 3, latencyMs: 30, modelId, revision };
  try {
    await assert.rejects(distributed(book, { offers: [...offers, extra], forward: async span => {
      forwards += 1;
      if (span.peerId === 'peer-b') throw new Error('span disconnected');
      return { activation: 'prompt/' + span.peerId, text: 'partial' };
    } }), /span disconnected/);
    assert.equal(forwards, 2);
    assert.equal(book.account(payer).balance, grant);
    assert.equal(book.account(b), null);
    assert.equal(book.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='settled'").get().n, 0);
    assert.equal(book.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='refunded'").get().n, 1);
  } finally { book.close(); }
});

test('a second failure and a token claim without output do not pay', async () => {
  const book = ledger();
  try {
    await assert.rejects(distributed(book, { forward: async () => { throw new Error('span disconnected'); } }), /span disconnected/);
    await assert.rejects(distributed(book, { forward: async () => ({ activation: 'x', text: '  ' }) }), /without returning output/);
    assert.equal(book.account(payer).balance, grant);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM settlement_splits').get().n, 0);
    await assert.rejects(distributed(book, { reserved: grant + 1 }), /available credits/);
    await assert.rejects(distributed(book, { enabled: false }), /Distributed serving is off/);
    await assert.rejects(distributed(book, { localOnly: true }), /one machine/);
    untouched(book, 2);
  } finally { book.close(); }
});

test('a rebuild skips public, unapproved, and mismatched offers', async () => {
  const book = ledger();
  const seen = [];
  const tagged = [
    tag({ pubkey: a, peerId: 'peer-a', start: 0, end: 1, latencyMs: 10 }),
    tag({ pubkey: b, peerId: 'peer-b', start: 1, end: 3, latencyMs: 10 }),
    tag({ pubkey: c, peerId: 'peer-c', start: 3, end: 4, latencyMs: 10 }),
    tag({ pubkey: b, peerId: 'peer-public', start: 1, end: 3, latencyMs: 1, public: true }),
    tag({ pubkey: 'e'.repeat(64), peerId: 'peer-stranger', start: 1, end: 3, latencyMs: 1 }),
    tag({ pubkey: b, peerId: 'peer-old', start: 1, end: 3, latencyMs: 1 }, { revision: 'rev-0' }),
    tag({ pubkey: b, peerId: 'peer-other', start: 1, end: 3, latencyMs: 1 }, { modelId: 'other-model' }),
    tag({ pubkey: b, peerId: 'peer-b2', start: 1, end: 3, latencyMs: 40 })
  ];
  try {
    const result = await distributed(book, { offers: tagged, forward: async (span, activation) => {
      seen.push(span.peerId);
      if (span.peerId === 'peer-b') throw new Error('span disconnected');
      return pass(span, activation);
    } });
    assert.equal(result.rebuilt, true);
    assert.deepEqual(result.chain.peerIds, ['peer-a', 'peer-b2', 'peer-c']);
    assert.deepEqual(seen, ['peer-a', 'peer-b', 'peer-a', 'peer-b2', 'peer-c']);
    assert.equal(book.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='settled'").get().n, 1);
  } finally { book.close(); }
});

test('every failed session leaves the reservation unpaid', async () => {
  const book = ledger();
  const seen = [];
  const tagged = [
    tag({ pubkey: a, peerId: 'peer-a', start: 0, end: 1, latencyMs: 10 }),
    tag({ pubkey: b, peerId: 'peer-b', start: 1, end: 3, latencyMs: 10 }),
    tag({ pubkey: c, peerId: 'peer-c', start: 3, end: 4, latencyMs: 10 }),
    tag({ pubkey: b, peerId: 'peer-public', start: 0, end: 4, latencyMs: 1, public: true }),
    tag({ pubkey: 'e'.repeat(64), peerId: 'peer-stranger', start: 0, end: 4, latencyMs: 1 }),
    tag({ pubkey: b, peerId: 'peer-old', start: 0, end: 4, latencyMs: 1 }, { revision: 'rev-0' })
  ];
  try {
    await assert.rejects(distributed(book, { offers: tagged, forward: async (span, activation) => {
      seen.push(span.peerId);
      if (span.peerId === 'peer-b') throw new Error('span disconnected');
      return pass(span, activation);
    } }), /span disconnected/);
    assert.deepEqual(seen, ['peer-a', 'peer-b']);
    await assert.rejects(distributed(book, { modelId: '' }), /model revision/);
    await assert.rejects(distributed(book, { now: Number.NaN }), /Invalid distributed clock/);
    await assert.rejects(distributed(book, { maxOffers: MAX_SPAN_OFFERS + 1 }), /Invalid offer limit/);
    await assert.rejects(distributed(book, { offers: [{ pubkey: a, peerId: 'bad', start: 0, end: 4, latencyMs: 1.5, public: true }] }), /Invalid span offer/);
    untouched(book, 1);
    assert.equal(book.account(a), null);
    assert.equal(book.account(b), null);
  } finally { book.close(); }
});
