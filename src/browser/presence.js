import {generateSecretKey,finalizeEvent,verifyEvent,getPublicKey} from 'nostr-tools/pure';
export const RELAYS=['wss://relay.damus.io','wss://nos.lol'];
const TOPIC='llmesh-presence-v1';
export class Presence {
  constructor(describe,change,{relays=RELAYS,Socket=WebSocket,now=()=>Date.now()}={}){
    this.describe=describe;this.change=change;this.now=now;this.secret=generateSecretKey();this.id=getPublicKey(this.secret);this.entries=new Map();this.sockets=[];this.closed=false;this.retries=[];
    const connect=url=>{if(this.closed)return;const socket=new Socket(url);this.sockets.push(socket);
      socket.onopen=()=>{socket.send(JSON.stringify(['REQ','presence',{kinds:[20078],'#d':[TOPIC],since:Math.floor(now()/1000)-60}]));this.publish();};
      socket.onmessage=message=>{try{if(typeof message.data!=='string'||message.data.length>12000)return;const data=JSON.parse(message.data);if(data[0]==='EVENT')this.accept(data[2]);}catch{/* Ignore malformed public advertisements. */}};
      socket.onerror=()=>{};socket.onclose=()=>{this.sockets=this.sockets.filter(item=>item!==socket);if(!this.closed)this.retries.push(setTimeout(()=>connect(url),10000));};};
    for(const url of relays)connect(url);this.timer=setInterval(()=>{this.publish();this.refresh();},15000);this.refresh();
  }
  accept(event){if(!event||event.kind!==20078||event.content?.length>4000||Math.abs(this.now()/1000-event.created_at)>60||!event.tags?.some(tag=>tag[0]==='d'&&tag[1]===TOPIC)||!verifyEvent(event))return;
    const value=JSON.parse(event.content);if(!['browser','desktop'].includes(value.kind)||typeof value.name!=='string'||value.name.length>60)return;
    if(value.gateway&&(typeof value.gateway.peerId!=='string'||value.gateway.peerId.length>100||!/^[a-f0-9]{64}$/.test(value.gateway.nonce)||value.gateway.publicKey?.crv!=='P-256'))return;
    const old=this.entries.get(event.pubkey);if(old&&old.time>=event.created_at)return;
    if(!old&&this.entries.size>=500)return;this.entries.set(event.pubkey,{...value,id:event.pubkey,time:event.created_at});this.refresh();
  }
  publish(){const value=this.describe();const event=finalizeEvent({kind:20078,created_at:Math.floor(this.now()/1000),tags:[['d',TOPIC],['expiration',String(Math.floor(this.now()/1000)+60)]],content:JSON.stringify(value)},this.secret);
    for(const socket of this.sockets)if(socket.readyState===1)socket.send(JSON.stringify(['EVENT',event]));
  }
  refresh(){for(const [id,value]of this.entries)if(this.now()/1000-value.time>60)this.entries.delete(id);this.change([{...this.describe(),id:this.id},...[...this.entries.values()].filter(value=>value.id!==this.id)]);}
  close(){this.closed=true;clearInterval(this.timer);for(const timer of this.retries)clearTimeout(timer);for(const socket of this.sockets)socket.close();}
}
