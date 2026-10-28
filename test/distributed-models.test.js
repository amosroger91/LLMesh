import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/core/ledger.js';
import { splitAtoms, selectChain, runDistributed } from '../src/core/distributed/chain.js';
import { STARTER_CREDITS, CREDIT_SCALE } from '../src/core/pricing.js';

const payer = 'd'.repeat(64), a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
const grant = STARTER_CREDITS * CREDIT_SCALE;
const blockCount = 4;
const offers = [
  { pubkey: a, peerId: 'peer-a', start: 0, end: 1, latencyMs: 10 },
  { pubkey: b, peerId: 'peer-b', start: 1, end: 3, latencyMs: 20 },
  { pubkey: c, peerId: 'peer-c', start: 3, end: 4, latencyMs: 15 },
  { pubkey: a, peerId: 'peer-a-slow', start: 0, end: 1, latencyMs: 80 },
  { pubkey: 'e'.repeat(64), peerId: 'stranger', start: 0, end: 4, latencyMs: 1 },
  { pubkey: b, peerId: 'public-b', start: 1, end: 3, latencyMs: 1, public: true }
];
const allowlist = [a, b, c];
const pass = (span, activation) => ({ activation: activation + '/' + span.peerId, text: span.end === blockCount ? 'answer' : '' });

function ledger() {
  const book = new Ledger(':memory:');
  book.register(payer);
  return book;
}
function shares(book, id) { return JSON.parse(book.db.prepare('SELECT payouts FROM settlement_splits WHERE id=?').get(id).payouts); }
function sum(book, column) { return book.db.prepare(`SELECT COALESCE(SUM(${column}),0) AS n FROM accounts`).get().n; }

test('integer block shares sum to one charge and the last span takes the remainder', () => {
  const split = splitAtoms(10, [{ worker: a, blocks: 1 }, { worker: b, blocks: 2 }, { worker: c, blocks: 1 }]);
  assert.deepEqual(split.map(item => item.atoms), [2, 5, 3]);
  assert.equal(split.reduce((total, item) => total + item.atoms, 0), 10);
});

test('chain selection keeps an allowlisted cover and pins its peer ids', () => {
  const chain = selectChain({ blockCount, offers, allowlist });
  assert.deepEqual(chain.peerIds, ['peer-a', 'peer-b', 'peer-c']);
  assert.equal(selectChain({ blockCount, offers: offers.filter(offer => offer.peerId !== 'peer-b'), allowlist }), null);
  assert.equal(selectChain({ blockCount, offers, allowlist: [a, c] }), null);
});

test('a fake chain debits the payer once and pays each span through the ledger', async () => {
  const book = ledger();
  try {
    const result = await runDistributed({ ledger: book, payer, offers, blockCount, allowlist, reserved: 100, used: 10, forward: async (span, activation) => pass(span, activation), enabled: true });
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
  ];
  try {
    await runDistributed({ ledger: book, payer, offers: selfOffers, blockCount, allowlist: [a, payer, c], reserved: 100, used: 10, forward: async (span, activation) => pass(span, activation), enabled: true });
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
  const extra = { pubkey: b, peerId: 'peer-b2', start: 1, end: 3, latencyMs: 30 };
  try {
    const result = await runDistributed({ ledger: book, payer, offers: [...offers, extra], blockCount, allowlist, reserved: 100, used: 10, enabled: true, forward: async (span, activation) => {
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
  const extra = { pubkey: b, peerId: 'peer-b2', start: 1, end: 3, latencyMs: 30 };
  try {
    await assert.rejects(runDistributed({ ledger: book, payer, offers: [...offers, extra], blockCount, allowlist, reserved: 100, used: 10, enabled: true, forward: async span => {
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
    await assert.rejects(runDistributed({ ledger: book, payer, offers, blockCount, allowlist, reserved: 100, used: 10, enabled: true, forward: async () => { throw new Error('span disconnected'); } }), /span disconnected/);
    await assert.rejects(runDistributed({ ledger: book, payer, offers, blockCount, allowlist, reserved: 100, used: 10, enabled: true, forward: async span => ({ activation: 'x', text: '  ' }) }), /without returning output/);
    assert.equal(book.account(payer).balance, grant);
    assert.equal(book.db.prepare("SELECT COUNT(*) AS n FROM settlement_splits").get().n, 0);
    await assert.rejects(runDistributed({ ledger: book, payer, offers, blockCount, allowlist, reserved: grant + 1, used: 10, enabled: true, forward: async (span, activation) => pass(span, activation) }), /available credits/);
    await assert.rejects(runDistributed({ ledger: book, payer, offers, blockCount, allowlist, reserved: 100, used: 10, enabled: false, forward: async (span, activation) => pass(span, activation) }), /Distributed serving is off/);
    await assert.rejects(runDistributed({ ledger: book, payer, offers, blockCount, allowlist, reserved: 100, used: 10, localOnly: true, enabled: true, forward: async (span, activation) => pass(span, activation) }), /one machine/);
    assert.equal(book.account(payer).balance, grant);
  } finally { book.close(); }
});
