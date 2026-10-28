import {catalog} from '../src/core/catalog.js';
import {mkdir,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const manifest={version:1,repository:'amosroger91/LLMesh',releaseTag:'model-vault-v1',models:[],assets:[]},assets=new Map();
await mkdir('vendor/native/manifests',{recursive:true});
for(const model of catalog.models){
 if(model.gguf){const asset={...model.gguf,type:'gguf'};assets.set(asset.sha256,asset);manifest.models.push({id:model.id,gguf:asset.sha256,abliterated:Boolean(model.abliterated)});continue;}
 const [name,tag]=model.id.split(':'),url=`https://registry.ollama.ai/v2/library/${name}/manifests/${tag}`,response=await fetch(url);if(!response.ok)throw new Error('Manifest HTTP '+response.status+': '+model.id);
 const raw=await response.text(),data=JSON.parse(raw),digest=createHash('sha256').update(raw).digest('hex');
 await writeFile('vendor/native/manifests/'+model.id.replace(':','-')+'.json',raw);
 assets.set(digest,{sha256:digest,size:Buffer.byteLength(raw),url,type:'manifest'});
 for(const layer of [data.config,...data.layers]){const sha256=layer.digest.replace('sha256:','');if(!/^[a-f0-9]{64}$/.test(sha256))throw new Error('Invalid native asset digest');assets.set(sha256,{sha256,size:layer.size,url:`https://registry.ollama.ai/v2/library/${name}/blobs/sha256:${sha256}`,type:layer.mediaType});}
 manifest.models.push({id:model.id,manifest:digest,gguf:data.layers.find(layer=>layer.mediaType==='application/vnd.ollama.image.model').digest.slice(7)});
}
manifest.assets=[...assets.values()];await writeFile('models/vault.json',JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({models:manifest.models.length,uniqueAssets:manifest.assets.length,totalBytes:manifest.assets.reduce((sum,asset)=>sum+asset.size,0)}));
