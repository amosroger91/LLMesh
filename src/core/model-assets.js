import {createReadStream} from 'node:fs';
import {mkdir,stat,rename,unlink,open} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {restoreMirroredAsset} from './model-vault.js';
export async function fileDigest(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export async function modelAsset(asset,directory,progress=()=>{},signal){
 if(!/^[a-f0-9]{64}$/.test(asset.sha256)||!Number.isSafeInteger(asset.size)||asset.size<1||new URL(asset.url).protocol!=='https:')throw new Error('Invalid pinned model asset');
 await mkdir(directory,{recursive:true});const target=join(directory,asset.sha256+'.gguf');
 if(await stat(target).then(info=>info.size===asset.size).catch(()=>false)&&await fileDigest(target)===asset.sha256)return target;
 if(await restoreMirroredAsset(asset,target,progress,signal))return target;
 const temporary=target+'.'+randomUUID()+'.tmp',file=await open(temporary,'wx');let total=0,last=0;const hash=createHash('sha256');
 try{const response=await fetch(asset.url,{signal});if(!response.ok)throw new Error('Model asset HTTP '+response.status);
  for await(const chunk of response.body){signal?.throwIfAborted();total+=chunk.length;if(total>asset.size)throw new Error('Model asset exceeds pinned size');hash.update(chunk);await file.writeFile(chunk);if(Date.now()-last>500){progress({status:'Downloading pinned GGUF',completed:total,total:asset.size});last=Date.now();}}
  if(total!==asset.size||hash.digest('hex')!==asset.sha256)throw new Error('GGUF checksum mismatch');await file.close();await rename(temporary,target);return target;
 }catch(error){await file.close().catch(()=>{});await unlink(temporary).catch(()=>{});throw error;}
}
