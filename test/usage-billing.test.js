import test from 'node:test';
import assert from 'node:assert/strict';
import { usageCredits, quoteWork, creditAtomsPerToken, STARTER_CREDITS, CREDIT_SCALE } from '../src/core/pricing.js';
import { Ledger } from '../src/core/ledger.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('token rates are half a credit for 0.8B and web, one through 9B, and 1.5 above that',()=>{
  assert.equal(creditAtomsPerToken({parametersB:0.8}),1);
  assert.equal(creditAtomsPerToken({parametersB:27},{instanceId:'web-phone',source:'web'}),1);
  assert.equal(creditAtomsPerToken({parametersB:2}),2);
  assert.equal(creditAtomsPerToken({parametersB:4}),2);
  assert.equal(creditAtomsPerToken({parametersB:9}),2);
  assert.equal(creditAtomsPerToken({parametersB:27}),3);
  assert.equal(creditAtomsPerToken({parametersB:70}),3);
  assert.equal(usageCredits(100,35,100000,1),135);assert.equal(usageCredits(100,35,100000,2),270);assert.equal(usageCredits(100,35,100000,3),405);
  assert.equal(usageCredits(0,0),0);assert.equal(usageCredits(1,0,10,1),1);
  for(const [input,output] of [[-1,2],[1.5,2],[1,2049],[NaN,1],[32769,0]])assert.throws(()=>usageCredits(input,output));
  assert.throws(()=>usageCredits(100,35,134));
  const small=quoteWork({parametersB:0.8},[{role:'user',content:'hello'}],512);
  const medium=quoteWork({parametersB:4},[{role:'user',content:'hello'}],512);
  const large=quoteWork({parametersB:27},[{role:'user',content:'hello'}],512);
  const web=quoteWork({parametersB:4},[{role:'user',content:'hello'}],512,[],undefined,{instanceId:'web-1'});
  assert.equal(small.reservedCredits,4608);assert.equal(small.creditsPerToken,0.5);
  assert.equal(medium.reservedCredits,9216);assert.equal(medium.creditsPerToken,1);
  assert.equal(large.reservedCredits,13824);assert.equal(large.creditsPerToken,1.5);
  assert.equal(web.creditsPerToken,0.5);assert.equal(web.reservedCredits,4608);
});
test('old local grants are topped up once without resetting spent or earned credits',()=>{
 const directory=mkdtempSync(join(tmpdir(),'llmesh-billing-migration-')),path=join(directory,'ledger.sqlite'),payer='a'.repeat(64),worker='b'.repeat(64);
 let ledger=new Ledger(path,100);
 try{ledger.register(payer);ledger.settle(ledger.reserve(payer,20),worker,7);ledger.close();
   ledger=new Ledger(path);assert.equal(ledger.account(payer).balance,199986);assert.equal(ledger.account(worker).balance,14);ledger.close();
   ledger=new Ledger(path);assert.equal(ledger.account(payer).balance,199986);ledger.register(worker);assert.equal(ledger.account(worker).balance,200014);
 }finally{ledger.close();rmSync(directory,{recursive:true,force:true});}
});
test('reservation refunds unused credits and pays exactly actual usage once',()=>{
  const ledger=new Ledger(':memory:');const payer='a'.repeat(64),worker='b'.repeat(64);
  const grant=STARTER_CREDITS*CREDIT_SCALE;
  try{ledger.register(payer);ledger.register(payer);assert.equal(ledger.account(payer).balance,grant);
    const id=ledger.reserve(payer,4096);assert.equal(ledger.account(payer).balance,grant-4096);
    assert.throws(()=>ledger.settle(id,worker,4097));assert.equal(ledger.account(payer).balance,grant-4096);
    assert.equal(ledger.settle(id,worker,135),true);assert.equal(ledger.settle(id,worker,135),false);
    assert.equal(ledger.account(payer).balance,grant-135);assert.equal(ledger.account(worker).balance,135);
    const zero=ledger.reserve(payer,100);ledger.settle(zero,worker,0);assert.equal(ledger.account(worker).balance,135);
    const failed=ledger.reserve(payer,1000);ledger.cancel(failed);assert.equal(ledger.account(payer).balance,grant-135);
  }finally{ledger.close();}
});
