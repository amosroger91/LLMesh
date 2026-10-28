// Delivery is final for billing. Confirmation/recovery is durable background work.
export class SettlementQueue {
  constructor(db, payments) {
    this.db = db; this.payments = payments; this.active = new Map(); this.closed = false;
    db.exec(`CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, payer TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settlements (id TEXT PRIMARY KEY, payment TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_retry INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, error TEXT);`);
    this.timer = setInterval(() => this.tick(), 1000); this.timer.unref();
  }
  save(receipt, payer) { this.db.prepare('INSERT OR REPLACE INTO receipts VALUES (?, ?, ?)').run(receipt.id, payer, JSON.stringify(receipt)); }
  receipt(id, payer) {
    const row = this.db.prepare('SELECT body FROM receipts WHERE id=? AND payer=?').get(id, payer);
    return row ? JSON.parse(row.body) : null;
  }
  enqueue(payment) {
    this.db.prepare("INSERT OR IGNORE INTO settlements(id,payment,state) VALUES (?,?,'settle-pending')").run(payment.id, JSON.stringify(payment));
    this.payments.record?.({ ...payment, state: 'settle-pending' });
    setImmediate(() => { if (!this.closed) void this.retryNow(payment.id); });
  }
  tick() {
    if (this.closed || !this.payments?.state.configured) return;
    for (const row of this.db.prepare("SELECT id FROM settlements WHERE state='settle-pending' AND next_retry<=?").all(Date.now())) void this.retryNow(row.id);
  }
  retryNow(id) {
    if (this.closed || this.active.has(id)) return this.active.get(id) ?? Promise.resolve();
    const row = this.db.prepare("SELECT * FROM settlements WHERE id=? AND state='settle-pending'").get(id);
    if (!row) return Promise.resolve();
    const payment = JSON.parse(row.payment);
    if (payment.chainId !== this.payments.state.chainId || payment.escrow?.toLowerCase() !== this.payments.settings.escrow?.toLowerCase()) return Promise.resolve();
    const task = this.attempt(row, payment).finally(() => this.active.delete(id));
    this.active.set(id, task); return task;
  }
  async attempt(row, payment) {
    try {
      const transaction = await this.payments.settle(payment);
      if (this.closed) return;
      this.db.prepare("UPDATE settlements SET state='settled',error=NULL WHERE id=?").run(row.id);
      this.payments.record?.({ ...payment, state: 'settled', transaction });
      const stored = this.db.prepare('SELECT body,payer FROM receipts WHERE id=?').get(row.id);
      if (stored) this.save({ ...JSON.parse(stored.body), settlement: 'settled', transaction }, stored.payer);
    } catch (error) {
      if (this.closed) return;
      this.db.prepare('UPDATE settlements SET attempts=attempts+1,next_retry=?,error=? WHERE id=?')
        .run(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 6)), String(error.message).slice(0, 500), row.id);
      this.payments.record?.({ ...payment, state: 'settle-pending' });
    }
  }
  close() { this.closed = true; clearInterval(this.timer); }
}
