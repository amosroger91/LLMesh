import {generateSecretKey,getPublicKey,finalizeEvent,verifyEvent} from 'nostr-tools/pure';
import {RELAYS} from './presence.js';

class Events {
  constructor(){this.listeners=new Map();}
  on(name,fn){const list=this.listeners.get(name)??[];list.push(fn);this.listeners.set(name,list);return this;}
  emit(name,value){for(const fn of this.listeners.get(name)??[])fn(value);}
}
// Emergency transport for networks where WebRTC cannot establish a data channel.
// Inference frames remain AES-GCM encrypted by secure-channel.js. Public relay
// operators see routing metadata, never the encrypted request/response contents.
export class RelayPeer extends Events {
  constructor({Socket=WebSocket,relays=RELAYS}={}){
    super();this.secret=generateSecretKey();this.id=getPublicKey(this.secret);this.connections=new Map();this.sockets=[];this.closed=false;
    const open=url=>{if(this.closed)return;const socket=new Socket(url);this.sockets.push(socket);
      socket.onopen=()=>socket.send(JSON.stringify(['REQ','channel',{kinds:[20079],'#p':[this.id],'#d':['llmesh-channel-v1'],since:Math.floor(Date.now()/1000)-30}]));
      socket.onmessage=message=>{try{if(typeof message.data!=='string'||message.data.length>50000)return;const frame=JSON.parse(message.data),event=frame[2];
        if(frame[0]!=='EVENT'||event?.kind!==20079||Math.abs(Date.now()/1000-event.created_at)>45||!event.tags?.some(tag=>tag[0]==='p'&&tag[1]===this.id)||!event.tags.some(tag=>tag[0]==='d'&&tag[1]==='llmesh-channel-v1')||!verifyEvent(event))return;
        const body=JSON.parse(event.content);if(!/^[a-f0-9-]{36}$/.test(body.sid))return;
        const key=event.pubkey+':'+body.sid;let connection=this.connections.get(key);
        if(!connection){if(!body.syn||this.connections.size>=16)return;connection=this.make(event.pubkey,body.sid,false);this.emit('connection',connection);}
        connection.receive(body);
      }catch{/* Ignore malformed public traffic. */}};
      socket.onerror=()=>{};socket.onclose=()=>{this.sockets=this.sockets.filter(item=>item!==socket);if(!this.closed){const timer=setTimeout(()=>open(url),5000);this.retries.push(timer);}};
    };this.retries=[];for(const url of relays)open(url);
    this.timer=setInterval(()=>{for(const connection of this.connections.values())connection.flush();},250);
  }
  publish(target,body){const event=finalizeEvent({kind:20079,created_at:Math.floor(Date.now()/1000),tags:[['d','llmesh-channel-v1'],['p',target],['expiration',String(Math.floor(Date.now()/1000)+45)]],content:JSON.stringify(body)},this.secret);
    for(const socket of this.sockets)if(socket.readyState===1)socket.send(JSON.stringify(['EVENT',event]));
  }
  connect(target){if(!/^[a-f0-9]{64}$/.test(target))throw new Error('Invalid relay gateway');return this.make(target,crypto.randomUUID(),true);}
  make(target,sid,initiator){const owner=this,key=target+':'+sid,connection=new Events();let sent=0,received=0,ack=0,dirty=false,last=0,opened=!initiator;
    const pending=new Map(),incoming=new Map();connection.open=!initiator;connection.transport='encrypted-relay';
    connection.send=body=>{if(!connection.open)throw new Error('Relay device disconnected');const serialized=JSON.stringify(body);if(serialized.length>24000||pending.size>=128)throw new Error('Relay transport overloaded');if(!pending.size)connection.lastProgress=Date.now();pending.set(++sent,{seq:sent,body,bytes:serialized.length});dirty=true;};
    connection.close=()=>{if(!owner.connections.has(key))return;owner.publish(target,{sid,close:true});owner.connections.delete(key);connection.open=false;connection.emit('close');};
    connection.receive=body=>{if(body.close){owner.connections.delete(key);connection.open=false;connection.emit('close');return;}
      if(Number.isInteger(body.ack)&&body.ack>=ack&&body.ack<=sent){ack=body.ack;for(const seq of pending.keys())if(seq<=ack)pending.delete(seq);}
      if(!opened){opened=true;connection.open=true;connection.emit('open');}
      if(body.syn)dirty=true;
      if(body.frames!=null){if(!Array.isArray(body.frames)||body.frames.length>64)throw new Error('Invalid relay batch');for(const frame of body.frames){dirty=true;if(!Number.isInteger(frame.seq)||frame.seq<=received||frame.seq>received+128)continue;incoming.set(frame.seq,frame.body);dirty=true;}
        while(incoming.has(received+1)){const value=incoming.get(++received);incoming.delete(received);connection.emit('data',value);}}
    };
    connection.flush=()=>{if(!owner.connections.has(key))return;const now=Date.now();if(pending.size&&now-(connection.lastProgress??now)>30000){connection.emit('error',new Error('Encrypted relay stalled; retry connection'));connection.close();return;}
      if(!opened){if(now-last>1500){owner.publish(target,{sid,syn:true,ack:received});last=now;}return;}
      if(!pending.size&&!dirty)return;if(pending.size&&now-last<1000&&!dirty&&pending.values().next().value?.sentAt)return;
      const frames=[];let size=0;for(const entry of pending.values()){if(size+entry.bytes>30000)break;size+=entry.bytes;frames.push({seq:entry.seq,body:entry.body});entry.sentAt=now;if(frames.length>=64)break;}
      owner.publish(target,{sid,ack:received,frames});dirty=false;last=now;
    };
    connection.lastProgress=Date.now();const receive=connection.receive;connection.receive=body=>{const previous=ack;receive(body);if(ack>previous)connection.lastProgress=Date.now();};
    this.connections.set(key,connection);return connection;
  }
  destroy(){this.closed=true;clearInterval(this.timer);for(const timer of this.retries)clearTimeout(timer);for(const connection of [...this.connections.values()])connection.close();for(const socket of this.sockets)socket.close();}
}
