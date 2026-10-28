// Application encryption binds the data channel to the desktop key in the QR.
// PeerJS signaling is never trusted with account keys or inference plaintext.
const encoder=new TextEncoder(),decoder=new TextDecoder();
const b64=bytes=>btoa(String.fromCharCode(...bytes));
const un64=value=>Uint8Array.from(atob(value),char=>char.charCodeAt(0));
export async function ephemeralKey(){
  return crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveKey']);
}
export async function publicKey(key){return crypto.subtle.exportKey('jwk',key.publicKey);}
export async function secureChannel(local,remote,session,send){
  const imported=await crypto.subtle.importKey('jwk',remote,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const key=await crypto.subtle.deriveKey({name:'ECDH',public:imported},local.privateKey,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  let sent=0,received=0,out=Promise.resolve();
  return {
    send(body){out=out.then(async()=>{const iv=crypto.getRandomValues(new Uint8Array(12));const bytes=encoder.encode(JSON.stringify({seq:++sent,body}));
      if(bytes.length>524288)throw new Error('Frame too large');
      const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(session)},key,bytes);
      await send({iv:b64(iv),data:b64(new Uint8Array(cipher))});});return out;},
    async receive(frame){if(typeof frame?.iv!=='string'||typeof frame.data!=='string'||frame.data.length>710000)throw new Error('Invalid encrypted frame');
      const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(frame.iv),additionalData:encoder.encode(session)},key,un64(frame.data));
      const value=JSON.parse(decoder.decode(bytes));if(value.seq!==received+1)throw new Error('Replayed/out-of-order frame');received=value.seq;return value.body;}
  };
}
export async function sendData(connection,body){
  const until=Date.now()+10000;
  while(connection.dataChannel?.bufferedAmount>262144){if(Date.now()>until||!connection.open)throw new Error('Slow/disconnected device');await new Promise(resolve=>setTimeout(resolve,10));}
  if(!connection.open)throw new Error('Device disconnected');
  const serialized=JSON.stringify(body);if(serialized.length>710000)throw new Error('Transport frame too large');
  if(encoder.encode(serialized).length<=24000){connection.send(body);return;}
  const id=crypto.randomUUID(),parts=[];
  for(let offset=0;offset<serialized.length;offset+=8000)parts.push(serialized.slice(offset,offset+8000));
  for(let index=0;index<parts.length;index++){
    while(connection.dataChannel?.bufferedAmount>262144){if(Date.now()>until||!connection.open)throw new Error('Slow/disconnected device');await new Promise(resolve=>setTimeout(resolve,10));}
    connection.send({type:'fragment',id,index,total:parts.length,text:parts[index]});
  }
}
export function reassemble(){let active;
  return frame=>{if(frame?.type!=='fragment')return frame;
    if(typeof frame.id!=='string'||frame.id.length>64||!Number.isInteger(frame.index)||!Number.isInteger(frame.total)||frame.total<1||frame.total>90||typeof frame.text!=='string'||frame.text.length>8000)throw new Error('Invalid transport fragment');
    if(frame.index===0){if(active)throw new Error('Interleaved transport fragments');active={id:frame.id,total:frame.total,parts:[],size:0,started:Date.now()};}
    if(!active||active.id!==frame.id||active.total!==frame.total||frame.index!==active.parts.length||Date.now()-active.started>10000||(active.size+=frame.text.length)>710000)throw new Error('Out-of-order/oversized transport fragment');
    active.parts.push(frame.text);if(active.parts.length!==active.total)return null;const value=JSON.parse(active.parts.join(''));active=null;return value;
  };
}
