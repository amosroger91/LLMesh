import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {assetResponse} from '../src/browser/asset-response.js';
const digest=text=>createHash('sha256').update(text).digest('hex');
test('repository model parts reassemble exactly and reject corrupted or truncated bytes',async()=>{
 const record={path:'model.wasm',size:6,sha256:digest('abcdef'),parts:[{path:'a.part000',size:3,sha256:digest('abc')},{path:'a.part001',size:3,sha256:digest('def')}]};
 const response=assetResponse(record,'https://example/',async url=>new Response(url.endsWith('000')?'abc':'def'));
 assert.equal(await response.text(),'abcdef');assert.equal(response.headers.get('content-type'),'application/wasm');
 await assert.rejects(assetResponse(record,'https://example/',async()=>new Response('bad')).arrayBuffer(),/checksum/);
 await assert.rejects(assetResponse(record,'https://example/',async()=>new Response('a')).arrayBuffer(),/checksum/);
 await assert.rejects(assetResponse({...record,parts:[{...record.parts[0],path:'../secret'}]},'https://example/').arrayBuffer(),/Invalid model part/);
});
