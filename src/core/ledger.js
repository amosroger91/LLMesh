import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { STARTER_CREDITS, CREDIT_SCALE, MAX_RESERVED_CREDITS } from './pricing.js';

export class Ledger {
  constructor(path, starter = STARTER_CREDITS * CREDIT_SCALE) {
    this.starter = starter;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS accounts (pubkey TEXT PRIMARY KEY, balance INTEGER NOT NULL CHECK(balance >= 0), granted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payer TEXT NOT NULL, worker TEXT, state TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);`);
    if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'price')) this.db.exec('ALTER TABLE jobs ADD COLUMN price INTEGER NOT NULL DEFAULT 1');
    if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'used_credits')) this.db.exec('ALTER TABLE jobs ADD COLUMN used_credits INTEGER');
    this.db.exec('CREATE TABLE IF NOT EXISTS billing_migrations (version TEXT PRIMARY KEY)');
    if (starter === STARTER_CREDITS * CREDIT_SCALE) this.transaction(() => {
      if (this.db.prepare("SELECT version FROM billing_migrations WHERE version='token-usage-v1'").get()) return;
      // One-time local upgrade preserves spending/earnings, rather than resetting balances.
      this.db.prepare('UPDATE accounts SET balance=balance+? WHERE granted=1').run(STARTER_CREDITS - 100);
      this.db.prepare("INSERT INTO billing_migrations VALUES ('token-usage-v1')").run();
    });
    // An interrupted coordinator refunds unsettled reservations on restart.
    // Refund in the stored unit before the half-credit scale migration.
    this.transaction(() => {
      for (const job of this.db.prepare("SELECT * FROM jobs WHERE state='reserved'").all()) this.refund(job.id);
    });
    if (starter === STARTER_CREDITS * CREDIT_SCALE) this.transaction(() => {
      if (this.db.prepare("SELECT version FROM billing_migrations WHERE version='token-rate-v2'").get()) return;
      this.db.prepare('UPDATE accounts SET balance=balance*?').run(CREDIT_SCALE);
      this.db.prepare('UPDATE jobs SET price=price*?, used_credits=CASE WHEN used_credits IS NULL THEN NULL ELSE used_credits*? END').run(CREDIT_SCALE, CREDIT_SCALE);
      this.db.prepare("INSERT INTO billing_migrations VALUES ('token-rate-v2')").run();
    });
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  register(pubkey) {
    if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('Invalid Nostr public key');
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO accounts VALUES (?, 0, 0)').run(pubkey);
      this.db.prepare('UPDATE accounts SET balance=balance+?,granted=1 WHERE pubkey=? AND granted=0').run(this.starter, pubkey);
      return this.account(pubkey);
    });
  }
  account(pubkey) { return this.db.prepare('SELECT * FROM accounts WHERE pubkey=?').get(pubkey) ?? null; }
  consumeAuth(id, expires) {
    this.db.prepare('DELETE FROM auth WHERE expires < ?').run(Math.floor(Date.now() / 1000));
    try { this.db.prepare('INSERT INTO auth VALUES (?, ?)').run(id, expires); }
    catch { throw new Error('Authentication replay rejected'); }
  }
  reserve(payer, price = 1) {
    if (!Number.isSafeInteger(price) || price < 1 || price > MAX_RESERVED_CREDITS) throw new Error('Invalid credit reservation');
    return this.transaction(() => {
      const result = this.db.prepare('UPDATE accounts SET balance=balance-? WHERE pubkey=? AND balance>=?').run(price, payer, price);
      if (!result.changes) throw new Error('Register an account with available credits first');
      const id = randomUUID();
      this.db.prepare("INSERT INTO jobs (id,payer,worker,state,created,price) VALUES (?, ?, NULL, 'reserved', ?, ?)").run(id, payer, Date.now(), price);
      return id;
    });
  }
  settle(id, worker, usedCredits) {
    return this.transaction(() => {
      const job = this.db.prepare("SELECT * FROM jobs WHERE id=? AND state='reserved'").get(id);
      if (!job) return false;
      usedCredits ??= job.price;
      if (!Number.isSafeInteger(usedCredits) || usedCredits < 0 || usedCredits > job.price) throw new Error('Invalid token usage');
      // Worker payout accounts do not receive registration grants implicitly.
      this.db.prepare('INSERT OR IGNORE INTO accounts VALUES (?, 0, 0)').run(worker);
      this.db.prepare('UPDATE accounts SET balance=balance+? WHERE pubkey=?').run(usedCredits, worker);
      this.db.prepare('UPDATE accounts SET balance=balance+? WHERE pubkey=?').run(job.price - usedCredits, job.payer);
      this.db.prepare("UPDATE jobs SET state='settled',worker=?,used_credits=? WHERE id=?").run(worker, usedCredits, id);
      return true;
    });
  }
  refund(id) {
    const job = this.db.prepare("SELECT * FROM jobs WHERE id=? AND state='reserved'").get(id);
    if (!job) return;
    this.db.prepare('UPDATE accounts SET balance=balance+? WHERE pubkey=?').run(job.price, job.payer);
    this.db.prepare("UPDATE jobs SET state='refunded' WHERE id=?").run(id);
  }
  cancel(id) { this.transaction(() => this.refund(id)); }
  close() { this.db.close(); }
}
