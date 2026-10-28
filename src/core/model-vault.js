import vault from '../../models/vault.json' with {type:'json'};
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';import {mkdir,open,rename,unlink,readFile,link,copyFile,stat} from 'node:fs/promises';import {join,dirname} from 'node:path';
async function digestFile(path){const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');}
const base=`https://github.com/${vault.repository}/releases/download/${vault.releaseTag}/`;
export function nativeAsset(model){const item=vault.models.find(item=>item.id===model);return vault.assets.find(asset=>asset.sha256===item?.gguf);}
export async function restoreMirroredAsset(asset,target,progress=()=>{},signal){
 let descriptor;try{const response=await fetch(base+asset.sha256+'.json',{signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(10000)])});if(!response.ok)return false;descriptor=await response.json();}catch(error){if(signal?.aborted)throw error;return false;}
 if(descriptor.sha256!==asset.sha256||descriptor.size!==asset.size||!Array.isArray(descriptor.parts)||descriptor.parts.length>100)throw new Error('Invalid repository model descriptor');
 await mkdir(dirname(target),{recursive:true});const temp=target+'.'+randomUUID()+'.tmp',file=await open(temp,'wx'),hash=createHash('sha256');let total=0,last=0;
 try{for(const [index,part]of descriptor.parts.entries()){
   if(part.name!==asset.sha256+'.part'+String(index).padStart(4,'0')||!Number.isSafeInteger(part.size)||part.size<1||part.size>1024**3||!/^[a-f0-9]{64}$/.test(part.sha256))throw new Error('Invalid repository model part');
   const response=await fetch(base+part.name,{signal});if(!response.ok)throw new Error('Repository model HTTP '+response.status);const partial=createHash('sha256');let size=0;
   for await(const bytes of response.body){signal?.throwIfAborted();total+=bytes.length;size+=bytes.length;if(size>part.size||total>asset.size)throw new Error('Model mirror exceeds pinned size');hash.update(bytes);partial.update(bytes);await file.writeFile(bytes);if(Date.now()-last>500){progress({status:'Downloading verified repository model backup',completed:total,total:asset.size});last=Date.now();}}
   if(size!==part.size||partial.digest('hex')!==part.sha256)throw new Error('Repository model part checksum mismatch');
  }
  if(total!==asset.size||hash.digest('hex')!==asset.sha256)throw new Error('Repository model checksum mismatch');await file.close();await rename(temp,target);return true;
 }catch(error){await file.close().catch(()=>{});await unlink(temp).catch(()=>{});throw error;}
}
export async function restoreOllamaModel(model,cache,progress,signal){
 const item=vault.models.find(item=>item.id===model);if(!item?.manifest)return false;
 const asset=vault.assets.find(asset=>asset.sha256===item.manifest),manifestFile=join(cache,'llmesh-assets',item.manifest+'.manifest');
 if(!await restoreMirroredAsset(asset,manifestFile,progress,signal))return false;
 const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
 await mkdir(join(cache,'blobs'),{recursive:true});
 for(const layer of [manifest.config,...manifest.layers]){const digest=layer.digest?.replace('sha256:',''),known=vault.assets.find(asset=>asset.sha256===digest&&asset.size===layer.size);if(!known)throw new Error('Unknown mirrored model layer');const path=join(cache,'blobs','sha256-'+digest);if(await stat(path).then(info=>info.size===known.size).catch(()=>false)&&await digestFile(path)===known.sha256)continue;if(!await restoreMirroredAsset(known,path,progress,signal))throw new Error('Model backup is incomplete');}
 const [name,tag]=model.split(':'),target=join(cache,'manifests','registry.ollama.ai','library',name,tag);await mkdir(dirname(target),{recursive:true});await unlink(target).catch(()=>{});await link(manifestFile,target).catch(()=>copyFile(manifestFile,target));return true;
}
