import test from 'node:test';import assert from 'node:assert/strict';
import {RelayPeer} from '../src/browser/relay-peer.js';
import {ephemeralKey,publicKey,secureChannel,sendData,reassemble} from '../src/browser/secure-channel.js';

test('encrypted relay fallback streams ordered inference frames despite duplicate relay delivery',{timeout:10000},async()=>{
 const sockets=[];const wire=[];
 class Socket{constructor(){this.readyState=1;sockets.push(this);queueMicrotask(()=>this.onopen?.());}send(raw){const value=JSON.parse(raw);if(value[0]!=='EVENT')return;wire.push(raw);for(const socket of sockets)queueMicrotask(()=>{socket.onmessage?.({data:JSON.stringify(['EVENT','channel',value[1]])});socket.onmessage?.({data:JSON.stringify(['EVENT','channel',value[1]])});});}close(){this.readyState=3;}}
 const host=new RelayPeer({Socket,relays:['test']}),worker=new RelayPeer({Socket,relays:['test']});const a=await ephemeralKey(),b=await ephemeralKey(),hostPublic=await publicKey(a),workerPublic=await publicKey(b);
 let resolve,reject;const result=new Promise((yes,no)=>{resolve=yes;reject=no;});let server;
 host.on('connection',connection=>{server=connection;const assemble=reassemble();let channel,chain=Promise.resolve();connection.on('data',frame=>{chain=chain.then(async()=>{channel??=await secureChannel(a,workerPublic,'public-nonce',body=>sendData(connection,body));const whole=assemble(frame);if(whole===null)return;const value=await channel.receive(whole);assert.equal(value.type,'job');assert.equal(value.text,'private prompt');await channel.send({type:'delta',text:'first'});await channel.send({type:'delta',text:' second'});await channel.send({type:'done',tokens:2,promptTokens:2});}).catch(reject);});});
 const connection=worker.connect(host.id);const channel=await secureChannel(b,hostPublic,'public-nonce',body=>sendData(connection,body));let text='',serial=Promise.resolve();const assemble=reassemble();
 connection.on('open',()=>{void channel.send({type:'job',text:'private prompt'}).catch(reject);});connection.on('error',reject);connection.on('data',frame=>{serial=serial.then(async()=>{const whole=assemble(frame);if(whole===null)return;const value=await channel.receive(whole);if(value.type==='delta')text+=value.text;if(value.type==='done')resolve(value);}).catch(reject);});
 try{assert.equal((await result).tokens,2);assert.equal(text,'first second');assert.equal(wire.some(raw=>raw.includes('private prompt')),false);assert.ok(server.open);}finally{worker.destroy();host.destroy();}
});
