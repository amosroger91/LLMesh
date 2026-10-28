import { isAddress } from 'ethers';
export class GrantAdmission {
  constructor(db, { owner, allowed = [], policy = 'allowlist', hook } = {}) {
    if (!['allowlist', 'open'].includes(policy)) throw new Error('Grant policy must be allowlist or open');
    Object.assign(this, { db, owner, allowed, policy, hook });
    db.exec(`CREATE TABLE IF NOT EXISTS account_wallets (pubkey TEXT PRIMARY KEY, wallet TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grant_requests (pubkey TEXT, ip TEXT, created INTEGER);`);
  }
  check(pubkey, wallet, ip) {
    if (!isAddress(wallet)) throw new Error('Invalid receiving wallet');
    if (this.policy !== 'open' && pubkey !== this.owner && !this.allowed.includes(pubkey)) throw new Error('Account is not admitted for a starter grant');
    if (this.hook && this.hook({ pubkey, wallet, ip }) !== true) throw new Error('Grant admission policy rejected account');
    const bound = this.db.prepare('SELECT wallet FROM account_wallets WHERE pubkey=?').get(pubkey);
    if (bound && bound.wallet.toLowerCase() !== wallet.toLowerCase()) throw new Error('Nostr account is already bound to another wallet');
    this.db.prepare('DELETE FROM grant_requests WHERE created<?').run(Date.now() - 600000);
    const keyCount = this.db.prepare('SELECT COUNT(*) AS count FROM grant_requests WHERE pubkey=?').get(pubkey).count;
    const ipCount = this.db.prepare('SELECT COUNT(*) AS count FROM grant_requests WHERE ip=?').get(ip).count;
    if (keyCount >= 5 || ipCount >= 20) throw new Error('Starter grant rate limit reached; retry in ten minutes');
    this.db.prepare('INSERT INTO grant_requests VALUES (?,?,?)').run(pubkey, ip, Date.now());
    this.db.prepare('INSERT OR IGNORE INTO account_wallets VALUES (?,?)').run(pubkey, wallet.toLowerCase());
  }
}
