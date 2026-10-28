import test from 'node:test';
import assert from 'node:assert/strict';
import {Presence} from '../src/browser/presence.js';
import {generateSecretKey,finalizeEvent} from 'nostr-tools/pure';
import {sendData,reassemble} from '../src/browser/secure-channel.js';

test('independent anonymous sessions discover each other, deduplicate and expire',()=>{
 let now=Date.now();const sockets=[];
 class Socket{constructor(){this.readyState=1;sockets.push(this);}send(raw){const frame=JSON.parse(raw);if(frame[0]==='EVENT')for(const socket of sockets)socket.onmessage?.({data:JSON.stringify(['EVENT','presence',frame[1]])});}close(){}}
 let left,right;const a=new Presence(()=>({kind:'browser',name:'Phone'}),nodes=>{left=nodes;},{relays:['test'],Socket,now:()=>now});
 const b=new Presence(()=>({kind:'browser',name:'Desktop browser'}),nodes=>{right=nodes;},{relays:['test'],Socket,now:()=>now});
 try{a.publish();b.publish();assert.equal(left.length,2);assert.equal(right.length,2);b.publish();assert.equal(left.length,2);
   a.accept(finalizeEvent({kind:20078,created_at:Math.floor(now/1000),tags:[['d','wrong-network']],content:JSON.stringify({kind:'browser',name:'Fake'})},generateSecretKey()));assert.equal(left.length,2);
   now+=61000;a.refresh();assert.equal(left.length,1);
 }finally{a.close();b.close();}
});
test('large encrypted transport payloads fit data-channel fragments and reassemble',async()=>{
 const frames=[],value={data:'多'.repeat(60000)};await sendData({open:true,send:frame=>frames.push(frame)},value);assert.ok(frames.length>1);
 const assemble=reassemble();let result;for(const frame of frames){assert.ok(Buffer.byteLength(JSON.stringify(frame))<25000);result=assemble(frame);}assert.deepEqual(result,value);
 assert.throws(()=>reassemble()(frames[1]),/Out-of-order/);
});
