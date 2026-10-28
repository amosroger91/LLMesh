import {readFile,writeFile,appendFile,unlink,open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';import {createHash} from 'node:crypto';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
const vault=JSON.parse(await readFile('models/vault.json','utf8')),mode=process.argv[2],repo=vault.repository,api='https://api.github.com/repos/'+repo;
let token=process.env.GITHUB_TOKEN;
if(!token&&['init','upload','complete'].includes(mode)){const credential=execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',windowsHide:true});token=credential.match(/^password=(.+)$/m)?.[1];}
const headers={Accept:'application/vnd.github+json',...(token?{Authorization:'Bearer '+token}:{})};
async function request(path,options={}){const r=await fetch(api+path,{...options,headers:{...headers,...options.headers}});if(!r.ok)throw new Error('GitHub vault API HTTP '+r.status);return r.status===204?null:r.json();}
async function release(){return request('/releases/tags/'+vault.releaseTag);}
async function assetList(id){const all=[];for(let page=1;;page++){const next=await request(`/releases/${id}/assets?per_page=100&page=${page}`);all.push(...next);if(next.length<100)return all;}}
async function upload(id,name,file,size,digest){
 const existing=(await assetList(id)).find(asset=>asset.name===name);
 if(existing?.size===size&&existing.state==='uploaded'&&existing.digest==='sha256:'+digest)return;
 if(existing)await request('/releases/assets/'+existing.id,{method:'DELETE'});
 for(let attempt=0;attempt<3;attempt++){
  const r=await fetch(`https://uploads.github.com/repos/${repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`,{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream','Content-Length':String(size)},body:createReadStream(file),duplex:'half'});
  if(r.ok)return;if(attempt===2||r.status<500)throw new Error('Vault upload HTTP '+r.status);await new Promise(resolve=>setTimeout(resolve,2000*(attempt+1)));
 }
}
async function uploadJson(id,name,value){const file=join(tmpdir(),'llmesh-'+name),data=JSON.stringify(value,null,2)+'\n';await writeFile(file,data);try{await upload(id,name,file,Buffer.byteLength(data),createHash('sha256').update(data).digest('hex'));}finally{await unlink(file);}}
if(mode==='init'){
 let current;try{current=await release();}catch{current=await request('/releases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag_name:vault.releaseTag,target_commitish:process.env.GITHUB_SHA??'main',name:'LLMesh model vault',prerelease:true,make_latest:'false',body:'Recoverable model backups. Archive build in progress; only checksum-verified per-asset descriptors are usable. Model licenses and pinned source metadata are in the repository.'})});}
 if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,'release_id='+current.id+'\nmatrix='+JSON.stringify({asset:vault.assets.map(asset=>asset.sha256)})+'\n');
 console.log('Vault release '+current.id+' prepared for '+vault.assets.length+' pinned assets');
}else if(mode==='upload'){
 const asset=vault.assets.find(asset=>asset.sha256===process.argv[3]);if(!asset)throw new Error('Unknown pinned asset');const current=await release();
 const hash=createHash('sha256'),parts=[];let total=0,file,partHash,size=0,path;
 const finish=async()=>{if(!file)return;await file.close();file=null;const sha256=partHash.digest('hex'),name=asset.sha256+'.part'+String(parts.length).padStart(4,'0');await upload(current.id,name,path,size,sha256);await unlink(path);parts.push({name,size,sha256});console.log(asset.sha256.slice(0,12)+': archived part '+parts.length);};
 const source=asset.localPath?createReadStream(asset.localPath):(await fetch(asset.url,{signal:AbortSignal.timeout(2*60*60*1000)}));
 if(!asset.localPath&&!source.ok)throw new Error('Pinned model source HTTP '+source.status);
 try{for await(const chunk of asset.localPath?source:source.body){hash.update(chunk);total+=chunk.length;if(total>asset.size)throw new Error('Native asset exceeds pinned size');let offset=0;
   while(offset<chunk.length){if(!file){path=join(tmpdir(),'llmesh-'+asset.sha256+'-'+parts.length+'.part');file=await open(path,'w');partHash=createHash('sha256');size=0;}const bytes=chunk.subarray(offset,offset+Math.min(1024**3-size,chunk.length-offset));await file.writeFile(bytes);partHash.update(bytes);size+=bytes.length;offset+=bytes.length;if(size===1024**3)await finish();}}
  await finish();if(total!==asset.size||hash.digest('hex')!==asset.sha256)throw new Error('Native source checksum mismatch');await uploadJson(current.id,asset.sha256+'.json',{version:1,sha256:asset.sha256,size:total,parts});
 }finally{await file?.close();if(file)await unlink(path).catch(()=>{});}
}else if(mode==='complete'){
 const current=await release(),files=await assetList(current.id);for(const asset of vault.assets)if(!files.some(file=>file.name===asset.sha256+'.json'&&file.state==='uploaded'))throw new Error('Missing verified vault asset descriptor');
 await uploadJson(current.id,'vault.json',vault);await request('/releases/'+current.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:`Complete pinned backup: ${vault.models.length} model variants, ${vault.assets.length} unique assets, ${vault.assets.reduce((sum,asset)=>sum+asset.size,0)} bytes. Each part and assembled asset is SHA-256 verified. Restore instructions and model licenses are in the repository.`,make_latest:'false'})});console.log('Model vault backup complete');
}else throw new Error('Use init, upload <pinned sha256>, or complete');
