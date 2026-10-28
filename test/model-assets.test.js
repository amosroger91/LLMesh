import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {modelAsset} from '../src/core/model-assets.js';
const hash=text=>createHash('sha256').update(text).digest('hex');
test('pinned model assets use a verified mirror, reuse local bytes, and reject altered downloads',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'llmesh-assets-')),original=globalThis.fetch,asset={url:'https://source.invalid/model.gguf',size:3,sha256:hash('abc')};let requests=0;
 globalThis.fetch=async url=>{requests++;return String(url).endsWith('.json')?Response.json({sha256:asset.sha256,size:3,parts:[{name:asset.sha256+'.part0000',size:3,sha256:asset.sha256}]}):new Response('abc');};
 try{const path=await modelAsset(asset,directory);assert.equal(await readFile(path,'utf8'),'abc');assert.equal(requests,2);await modelAsset(asset,directory);assert.equal(requests,2,'An existing verified local model needs no upstream');
  const bad={...asset,sha256:hash('xyz')};globalThis.fetch=async url=>String(url).endsWith('.json')?new Response('',{status:404}):new Response('abc');await assert.rejects(modelAsset(bad,directory),/checksum mismatch/);
 }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});
