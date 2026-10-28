import {finalizeEvent,verifyEvent} from 'nostr-tools/pure';
// A receipt confirms a balance at its issuer. It never mints spendable local money.
export class CreditReceipts{
 constructor(db,secret,owner){this.db=db;this.secret=secret;this.owner=owner;db.exec(`
 CREATE TABLE IF NOT EXISTS expected_credits(issuer TEXT,id TEXT,model TEXT,atoms INTEGER,prompt INTEGER,output INTEGER,PRIMARY KEY(issuer,id));
 CREATE TABLE IF NOT EXISTS credit_receipts(issuer TEXT,id TEXT,sequence INTEGER,balance INTEGER,atoms INTEGER,event TEXT,PRIMARY KEY(issuer,id));
 CREATE TABLE IF NOT EXISTS credit_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,worker TEXT,event TEXT,acknowledged INTEGER NOT NULL DEFAULT 0);`);}
 expect(issuer,id,model,usage,atoms){if(!/^[a-f0-9-]{36}$/.test(id??'')||!Number.isSafeInteger(atoms)||atoms<0)throw new Error('Invalid credit job');this.db.prepare('INSERT OR IGNORE INTO expected_credits VALUES (?,?,?,?,?,?)').run(issuer,id,model,atoms,usage.promptTokens??0,usage.tokens??0);}
 issue(worker,id,model,usage,atoms,balance,api){
  this.db.prepare('INSERT OR IGNORE INTO credit_outbox(id,worker) VALUES (?,?)').run(id,worker);const row=this.db.prepare('SELECT * FROM credit_outbox WHERE id=?').get(id);if(row.event)return JSON.parse(row.event);
  const event=finalizeEvent({kind:27236,created_at:Math.floor(Date.now()/1000),tags:[['d','llmesh-credit-receipt-v1']],content:JSON.stringify({v:1,id,sequence:row.sequence,worker,model,promptTokens:usage.promptTokens,outputTokens:usage.tokens,atoms,balance,api:api??null})},this.secret);this.db.prepare('UPDATE credit_outbox SET event=? WHERE id=?').run(JSON.stringify(event),id);return event;
 }
 receive(issuer,event){
  if(!event||event.pubkey!==issuer||event.kind!==27236||event.content?.length>4000||!verifyEvent(JSON.parse(JSON.stringify(event)))||!event.tags.some(tag=>tag[0]==='d'&&tag[1]==='llmesh-credit-receipt-v1'))throw new Error('Invalid signed credit receipt');
  const value=JSON.parse(event.content);if(value.v!==1||value.worker!==this.owner||!Number.isSafeInteger(value.sequence)||value.sequence<1||!Number.isSafeInteger(value.balance)||value.balance<0)throw new Error('Invalid credit receipt balance');
  const old=this.db.prepare('SELECT event FROM credit_receipts WHERE issuer=? AND id=?').get(issuer,value.id);if(old){if(JSON.parse(old.event).id!==event.id)throw new Error('Conflicting credit receipt');return event.id;}
  const expected=this.db.prepare('SELECT * FROM expected_credits WHERE issuer=? AND id=?').get(issuer,value.id);if(!expected||value.model!==expected.model||value.atoms!==expected.atoms||value.promptTokens!==expected.prompt||value.outputTokens!==expected.output)throw new Error('Credit receipt does not match completed work');
  const previous=this.db.prepare('SELECT MAX(sequence) AS sequence FROM credit_receipts WHERE issuer=?').get(issuer);
  if(previous?.sequence!=null&&value.sequence<=previous.sequence)throw new Error('Credit receipt sequence is not newer');
  this.db.prepare('INSERT INTO credit_receipts VALUES (?,?,?,?,?,?)').run(issuer,value.id,value.sequence,value.balance,value.atoms,JSON.stringify(event));return event.id;
 }
 acknowledge(worker,eventId){const row=this.db.prepare('SELECT id,event FROM credit_outbox WHERE worker=? AND acknowledged=0').all(worker).find(row=>row.event&&JSON.parse(row.event).id===eventId);if(row)this.db.prepare('UPDATE credit_outbox SET acknowledged=1 WHERE id=?').run(row.id);}
 async flush(mesh){if(!mesh?.sendCredit)return;for(const row of this.db.prepare('SELECT worker,event FROM credit_outbox WHERE acknowledged=0 AND event IS NOT NULL ORDER BY sequence LIMIT 100').all())await mesh.sendCredit(row.worker,JSON.parse(row.event)).catch(()=>false);}
 summary(){const results=new Map();for(const row of this.db.prepare('SELECT * FROM credit_receipts ORDER BY sequence DESC').all()){const body=JSON.parse(JSON.parse(row.event).content);const item=results.get(row.issuer)??{issuer:row.issuer,balance:row.balance,earned:0,receipts:0,api:body.api??null};item.earned+=row.atoms;item.receipts++;results.set(row.issuer,item);}return [...results.values()];}
}
