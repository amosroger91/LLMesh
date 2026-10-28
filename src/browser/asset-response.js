import {sha256} from '@noble/hashes/sha2.js';
const hex=bytes=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
export function assetResponse(record,base,Fetch=fetch){
 const body=new ReadableStream({async start(controller){const full=sha256.create();let total=0;
  try{for(const part of record.parts){if(!/^[\w./-]+$/.test(part.path)||part.path.split('/').includes('..'))throw new Error('Invalid model part path');const response=await Fetch(base+part.path,{cache:'no-store'});if(!response.ok)throw new Error('Repository asset HTTP '+response.status);const hash=sha256.create();let size=0;
    for await(const chunk of response.body){size+=chunk.length;total+=chunk.length;if(size>part.size||total>record.size)throw new Error('Repository asset exceeds pinned size');hash.update(chunk);full.update(chunk);controller.enqueue(chunk);}
    if(size!==part.size||hex(hash.digest())!==part.sha256)throw new Error('Repository asset part checksum mismatch');}
   if(total!==record.size||hex(full.digest())!==record.sha256)throw new Error('Repository model checksum mismatch');controller.close();
  }catch(error){controller.error(error);}
 }});
 return new Response(body,{headers:{'Content-Type':record.path.endsWith('.json')?'application/json':record.path.endsWith('.wasm')?'application/wasm':'application/octet-stream','Content-Length':String(record.size),'Cache-Control':'no-store'}});
}
