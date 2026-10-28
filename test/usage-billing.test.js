import test from 'node:test';
import assert from 'node:assert/strict';
import { usageCredits, quoteWork, STARTER_CREDITS } from '../src/core/pricing.js';
import { Ledger } from '../src/core/ledger.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('one credit per actual input and output token, independent of model',()=>{
  assert.equal(usageCredits(100,35),135);assert.equal(usageCredits(0,0),0);
  for(const [input,output] of [[-1,2],[1.5,2],[1,2049],[NaN,1],[32769,0]])assert.throws(()=>usageCredits(input,output));
  assert.throws(()=>usageCredits(100,35,134));
  const small=quoteWork({parametersB:0.8},[{role:'user',content:'hello'}],512);
  const large=quoteWork({parametersB:27},[{role:'user',content:'hello'}],512);
  assert.equal(small.reservedCredits,large.reservedCredits);assert.equal(small.reservedCredits,4608);
  assert.equal(small.creditsPerToken,1);
});
test('old local grants are topped up once without resetting spent or earned credits',()=>{
 const directory=mkdtempSync(join(tmpdir(),'llmesh-billing-migration-')),path=join(directory,'ledger.sqlite'),payer='a'.repeat(64),worker='b'.repeat(64);
 let ledger=new Ledger(path,100);
 try{ledger.register(payer);ledger.settle(ledger.reserve(payer,20),worker,7);ledger.close();
   ledger=new Ledger(path);assert.equal(ledger.account(payer).balance,99993);assert.equal(ledger.account(worker).balance,7);ledger.close();
   ledger=new Ledger(path);assert.equal(ledger.account(payer).balance,99993);ledger.register(worker);assert.equal(ledger.account(worker).balance,100007);
 }finally{ledger.close();rmSync(directory,{recursive:true,force:true});}
});
test('reservation refunds unused credits and pays exactly actual usage once',()=>{
  const ledger=new Ledger(':memory:');const payer='a'.repeat(64),worker='b'.repeat(64);
  try{ledger.register(payer);ledger.register(payer);assert.equal(ledger.account(payer).balance,STARTER_CREDITS);
    const id=ledger.reserve(payer,4096);assert.equal(ledger.account(payer).balance,STARTER_CREDITS-4096);
    assert.throws(()=>ledger.settle(id,worker,4097));assert.equal(ledger.account(payer).balance,STARTER_CREDITS-4096);
    assert.equal(ledger.settle(id,worker,135),true);assert.equal(ledger.settle(id,worker,135),false);
    assert.equal(ledger.account(payer).balance,STARTER_CREDITS-135);assert.equal(ledger.account(worker).balance,135);
    const zero=ledger.reserve(payer,100);ledger.settle(zero,worker,0);assert.equal(ledger.account(worker).balance,135);
    const failed=ledger.reserve(payer,1000);ledger.cancel(failed);assert.equal(ledger.account(payer).balance,STARTER_CREDITS-135);
  }finally{ledger.close();}
});
