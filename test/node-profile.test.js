import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {nodeProfile} from '../src/shared/node-profile.js';import {Service} from '../src/core/service.js';import {generateSecretKey} from '../src/core/identity.js';
test('public node profiles bound metadata and reject remote/active image formats and CSS injection',()=>{
 const p=nodeProfile({name:'My phone',bio:'Spare compute',ringColor:'#aabbcc',avatar:'data:image/jpeg;base64,aGVsbG8='});assert.equal(p.name,'My phone');assert.equal(p.ringColor,'#aabbcc');
 for(const avatar of ['https://tracker.example/avatar.png','data:image/svg+xml;base64,PHN2Zz4=','data:image/jpeg;base64,'+'A'.repeat(9000)])assert.throws(()=>nodeProfile({avatar}));
 assert.throws(()=>nodeProfile({bio:'x'.repeat(161)}));assert.throws(()=>nodeProfile({ringColor:'red;display:none'}));
});
test('desktop node profile persists across restart and reaches topology without changing account identity',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'llmesh-profile-')),secret=generateSecretKey();let service=new Service({directory,secret,network:false,ollama:{close(){}}});
 try{const original=service.pubkey;service.configureNodeProfile({name:'Roger desktop',bio:'My compute node',ringColor:'#ff8800'});assert.equal(service.topology().nodes[0].name,'Roger desktop');assert.equal(service.topology().nodes[0].profile.ringColor,'#ff8800');await service.close();service=new Service({directory,secret,network:false,ollama:{close(){}}});assert.equal(service.status().nodeProfile.bio,'My compute node');assert.equal(service.pubkey,original);
 const id='7'.repeat(64);service.browserWorkers.register(id,'Old name');service.browserWorkers.report(id,{type:'state',state:'ready',profile:{name:'My phone',bio:'Worker',ringColor:'#00ff00'}});assert.equal(service.browserWorkers.snapshot()[0].name,'My phone');assert.equal(service.topology().nodes[1].profile.ringColor,'#00ff00');
 }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});
