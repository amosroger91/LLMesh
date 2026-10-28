import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class Ledger {
  constructor(path, starter = 100) {
    this.starter = starter;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS accounts (pubkey TEXT PRIMARY KEY, balance INTEGER NOT NULL CHECK(balance >= 0), granted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payer TEXT NOT NULL, worker TEXT, state TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);`);
    if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'price')) this.db.exec('ALTER TABLE jobs ADD COLUMN price INTEGER NOT NULL DEFAULT 1');
    // An interrupted coordinator refunds unsettled reservations on restart.
    this.transaction(() => {
      for (const job of this.db.prepare("SELECT * FROM jobs WHERE state='reserved'").all()) this.refund(job.id);
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
    if (!Number.isInteger(price) || price < 1 || price > 3) throw new Error('Invalid contribution price');
    return this.transaction(() => {
      const result = this.db.prepare('UPDATE accounts SET balance=balance-? WHERE pubkey=? AND balance>=?').run(price, payer, price);
      if (!result.changes) throw new Error('Register an account with available credits first');
      const id = randomUUID();
      this.db.prepare("INSERT INTO jobs (id,payer,worker,state,created,price) VALUES (?, ?, NULL, 'reserved', ?, ?)").run(id, payer, Date.now(), price);
      return id;
    });
  }
  settle(id, worker) {
    return this.transaction(() => {
      const job = this.db.prepare("SELECT * FROM jobs WHERE id=? AND state='reserved'").get(id);
      if (!job) return false;
      // Worker payout accounts do not receive registration grants implicitly.
      this.db.prepare('INSERT OR IGNORE INTO accounts VALUES (?, 0, 0)').run(worker);
      this.db.prepare('UPDATE accounts SET balance=balance+? WHERE pubkey=?').run(job.price, worker);
      this.db.prepare("UPDATE jobs SET state='settled',worker=? WHERE id=?").run(worker, id);
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
