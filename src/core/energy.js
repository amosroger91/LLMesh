import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const run = promisify(execFile);

export async function scanPower() {
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=power.draw,power.limit', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 2500 });
    const rows = stdout.trim().split('\n').map(line => line.split(',').map(Number));
    const measured = rows.every(row => Number.isFinite(row[0]) && row[0] >= 0);
    const limit = rows.reduce((sum, row) => sum + (Number.isFinite(row[1]) ? row[1] : 0), 0);
    return { gpuWatts: measured ? rows.reduce((sum, row) => sum + row[0], 0) : null, gpuLimitWatts: limit || null,
      source: measured ? 'nvidia-smi board power + estimated host overhead' : 'estimate' };
  } catch { return { gpuWatts: null, gpuLimitWatts: null, source: 'estimate' }; }
}

export class EnergyMeter {
  constructor(path, readPower = scanPower, now = () => Date.now()) {
    this.db = new DatabaseSync(path); this.readPower = readPower; this.now = now;
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, model TEXT, started INTEGER, ended INTEGER, kwh REAL, cost REAL, currency TEXT, method TEXT);`);
    this.settings = JSON.parse(this.db.prepare('SELECT value FROM settings WHERE id=1').get()?.value ?? '{"rate":0.15,"currency":"USD","estimatedWatts":150,"hostWatts":50,"wallWatts":null}');
    this.db.prepare('UPDATE sessions SET ended=started WHERE ended IS NULL').run();
    this.timer = setInterval(() => this.sample(), 2000); this.timer.unref();
  }
  configure(settings) {
    const next = { ...this.settings, ...settings };
    if (this.active && next.currency !== this.settings.currency) throw new Error('Stop inference before changing currency');
    if (!Number.isFinite(next.rate) || next.rate < 0 || next.rate > 100 || !/^[A-Z]{3}$/.test(next.currency) ||
      !Number.isFinite(next.estimatedWatts) || next.estimatedWatts < 1 || next.estimatedWatts > 10000 ||
      !Number.isFinite(next.hostWatts) || next.hostWatts < 0 || next.hostWatts > 5000 ||
      (next.wallWatts !== null && (!Number.isFinite(next.wallWatts) || next.wallWatts < 1 || next.wallWatts > 10000))) throw new Error('Invalid electricity settings');
    this.accrue(); this.settings = next;
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (1, ?)').run(JSON.stringify(next)); return this.status();
  }
  async scan() {
    this.power = await this.readPower();
    if (this.power.gpuLimitWatts) this.suggestedWatts = Math.round(this.power.gpuLimitWatts * 0.7 + this.settings.hostWatts);
    return this.status();
  }
  watts() { return this.settings.wallWatts ?? (this.power?.gpuWatts == null ? this.settings.estimatedWatts : this.power.gpuWatts + this.settings.hostWatts); }
  method() { return this.settings.wallWatts != null ? 'user wall-power override' : this.power?.source ?? 'estimate'; }
  start(model) {
    if (this.active) return;
    this.active = { id: randomUUID(), model, started: this.now(), last: this.now(), kwh: 0, cost: 0 };
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, NULL, 0, 0, ?, ?)').run(this.active.id, model, this.active.started, this.settings.currency, this.method());
    void this.sample().catch(()=>{});
  }
  accrue() {
    if (!this.active) return;
    const current = this.now(), elapsed = Math.max(0, current - this.active.last); this.active.last = current;
    const kwh = this.watts() * elapsed / 3600000000;
    this.active.kwh += kwh; this.active.cost += kwh * this.settings.rate;
    this.db.prepare('UPDATE sessions SET kwh=?,cost=?,method=? WHERE id=?').run(this.active.kwh, this.active.cost, this.method(), this.active.id);
  }
  async sample() {
    if (!this.active || this.sampling) return;
    this.sampling = true;
    try { const power = await this.readPower(); if (!this.closed) { this.accrue(); this.power = power; } }
    finally { this.sampling = false; }
  }
  stop() {
    if (!this.active) return; this.accrue();
    this.db.prepare('UPDATE sessions SET ended=? WHERE id=?').run(this.now(), this.active.id); this.active = null;
  }
  status() {
    const totals = this.db.prepare('SELECT currency,SUM(kwh) AS kwh,SUM(cost) AS cost FROM sessions GROUP BY currency').all();
    return { settings: this.settings, power: this.power, suggestedWatts: this.suggestedWatts, watts: this.watts(), method: this.method(),
      estimatedModelWatts: this.settings.wallWatts ?? this.suggestedWatts ?? this.settings.estimatedWatts,
      estimatedCostPerHour: (this.settings.wallWatts ?? this.suggestedWatts ?? this.settings.estimatedWatts) / 1000 * this.settings.rate, totals,
      active: this.active ? { ...this.active } : null,
      sessions: this.db.prepare('SELECT * FROM sessions ORDER BY started DESC LIMIT 20').all() };
  }
  close() { this.closed = true; clearInterval(this.timer); this.stop(); this.db.close(); }
}
