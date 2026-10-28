import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { GrantAdmission } from '../src/admission.js';
test('grants require admission, bind accounts once, and rate limit repeat requests', () => {
  const db = new DatabaseSync(':memory:');
  const owner = 'a'.repeat(64), invited = 'b'.repeat(64), stranger = 'c'.repeat(64);
  const admission = new GrantAdmission(db, { owner, allowed: [invited] });
  const wallet = '0x' + '1'.repeat(40);
  try {
    assert.throws(() => admission.check(stranger, wallet, 'ip'), /not admitted/);
    admission.check(invited, wallet, 'ip');
    assert.throws(() => admission.check(invited, '0x' + '2'.repeat(40), 'ip'), /already bound/);
    for (let i = 0; i < 4; i++) admission.check(invited, wallet, 'ip');
    assert.throws(() => admission.check(invited, wallet, 'ip'), /rate limit/);
    assert.equal(db.prepare('SELECT wallet FROM account_wallets WHERE pubkey=?').get(invited).wallet, wallet);
  } finally { db.close(); }
});
