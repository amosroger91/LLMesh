import {prebuiltAppConfig} from '@mlc-ai/web-llm';
import {mkdir,writeFile,open,rename,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,dirname} from 'node:path';
const root='vendor/browser',limit=64*1024*1024;
await mkdir(root,{recursive:true});
const manifest={version:1,createdAt:new Date().toISOString(),files:[],models:[]};
async function download(url,path,expectedSize,expectedHash){
 const response=await fetch(url,{signal:AbortSignal.timeout(20*60*1000)});if(!response.ok)throw new Error(`Asset HTTP ${response.status}: ${path}`);
 await mkdir(dirname(join(root,path)),{recursive:true});const hash=createHash('sha256'),parts=[];let file,partHash,partSize=0,total=0;
 const finish=async()=>{if(!file)return;await file.close();const name=path+'.part'+String(parts.length).padStart(3,'0');await rename(join(root,name+'.tmp'),join(root,name));parts.push({path:name,size:partSize,sha256:partHash.digest('hex')});file=null;};
 try{for await(const chunk of response.body){hash.update(chunk);total+=chunk.length;if(expectedSize!=null&&total>expectedSize)throw new Error('Asset exceeded pinned size');let offset=0;while(offset<chunk.length){if(!file){const name=path+'.part'+String(parts.length).padStart(3,'0');file=await open(join(root,name+'.tmp'),'w');partHash=createHash('sha256');partSize=0;}const bytes=chunk.subarray(offset,offset+Math.min(limit-partSize,chunk.length-offset));await file.writeFile(bytes);partHash.update(bytes);partSize+=bytes.length;offset+=bytes.length;if(partSize===limit)await finish();}}await finish();}
 finally{await file?.close();}
 const sha256=hash.digest('hex');if(expectedSize!=null&&total!==expectedSize||expectedHash&&sha256!==expectedHash)throw new Error(`Pinned asset mismatch: ${path}`);
 manifest.files.push({path,url,size:total,sha256,parts});console.log(`${path}: ${total} bytes verified`);
}
for(const record of prebuiltAppConfig.model_list.filter(model=>/^Qwen3\.5-0\.8B-q4f(?:16|32)_1-MLC$/.test(model.model_id))){
 const repo=new URL(record.model).pathname.slice(1),metadata=await(await fetch('https://huggingface.co/api/models/'+repo+'?blobs=true')).json();
 if(!/^[a-f0-9]{40}$/.test(metadata.sha))throw new Error('No immutable model revision');
 const base=`https://huggingface.co/${repo}/resolve/${metadata.sha}/`,config=await(await fetch(base+'mlc-chat-config.json')).json();
 const files=['mlc-chat-config.json','tensor-cache.json',...config.tokenizer_files,...metadata.siblings.filter(file=>/^params_shard_\d+\.bin$/.test(file.rfilename)).map(file=>file.rfilename)];
 for(let i=0;i<files.length;i+=2)await Promise.all(files.slice(i,i+2).map(name=>{const file=metadata.siblings.find(file=>file.rfilename===name);return download(base+name,record.model_id+'/'+name,file?.size,file?.lfs?.sha256);}));
 const libraryPath=new URL(record.model_lib).pathname.split('/main/')[1],commits=await(await fetch('https://api.github.com/repos/mlc-ai/binary-mlc-llm-libs/commits?path='+encodeURIComponent(libraryPath)+'&per_page=1')).json(),revision=commits[0]?.sha;
 if(!/^[a-f0-9]{40}$/.test(revision))throw new Error('No immutable WASM revision');
 const library='wasm/'+record.model_id+'.wasm';await download(record.model_lib.replace('/main/','/'+revision+'/'),library);
 manifest.models.push({...record,modelRevision:metadata.sha,model:record.model_id+'/',model_lib:library});
}
await copyFile('node_modules/@mlc-ai/web-llm/LICENSE',join(root,'WEBLLM-LICENSE'));
await writeFile(join(root,'README.md'),'# Vendored browser inference assets\n\nQwen3.5 0.8B weights in both WebGPU quantizations, tokenizers, model configs and compiled WebLLM WASM. SHA-256 checksums and immutable source revisions are in manifest.json. Files are split into <=64 MiB parts for GitHub; the web build verifies and reassembles them. Model weights retain Qwen Apache-2.0 terms; compiled WebLLM libraries retain upstream terms in WEBLLM-LICENSE. No model code is executed by this download script.\n');
await writeFile(join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Browser backup complete: '+manifest.files.reduce((sum,file)=>sum+file.size,0)+' bytes');
