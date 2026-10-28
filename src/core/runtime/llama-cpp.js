import {OllamaPool} from './pool.js';import {defaultCache} from '../model-bundle.js';
import {nativeAsset} from '../model-vault.js';import {modelAsset,fileDigest} from '../model-assets.js';
import {existsSync} from 'node:fs';import {mkdir,copyFile,readFile,readdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';import {randomUUID} from 'node:crypto';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function llamaExecutable(options={}){
 if(options.executable??process.env.LLMESH_LLAMA_SERVER)return options.executable??process.env.LLMESH_LLAMA_SERVER;
 if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Set runtime.executable to a local llama-server binary for this platform');
 const vendor=fileURLToPath(new URL('../../../vendor/llama.cpp/',import.meta.url)),manifest=JSON.parse(await readFile(join(vendor,'manifest.json'),'utf8')),archive=join(vendor,manifest.archive),directory=join(options.cache??defaultCache(),'llmesh-runtime',manifest.version),ready=join(directory,'llama-server.exe');
 if(existsSync(ready))return ready;
 if(await fileDigest(archive)!==manifest.sha256)throw new Error('Vendored llama.cpp checksum mismatch');await mkdir(directory,{recursive:true});
 const zip=join(directory,'runtime.zip');await copyFile(archive,zip);
 await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:LLMESH_ARCHIVE -DestinationPath $env:LLMESH_RUNTIME -Force'],{windowsHide:true,env:{...process.env,LLMESH_ARCHIVE:zip,LLMESH_RUNTIME:directory}});
 async function find(path){for(const entry of await readdir(path,{withFileTypes:true})){const full=join(path,entry.name);if(entry.isFile()&&entry.name==='llama-server.exe')return full;if(entry.isDirectory()){const result=await find(full);if(result)return result;}}}
 const executable=await find(directory);if(!executable)throw new Error('Vendored runtime does not contain llama-server');return executable;
}
export class LlamaCppClient{
 constructor(base,model){this.base=base;this.model=model;}
 async available(){try{return(await fetch(this.base+'/health',{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}}
 async warm(){if(!await this.available())throw new Error('llama.cpp is not ready');}
 async installed(){return await this.available()?[this.model]:[];}
 cancelInstall(){this.installController?.abort();}
 async unload(){/* The owner pool stops the process before replacing a model. */}
 async *chat(job,signal){
  const response=await fetch(this.base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:job.model,messages:job.messages,stream:true,stream_options:{include_usage:true},max_tokens:job.maxTokens,...(job.tools?.length?{tools:job.tools,tool_choice:job.tool_choice??'auto'}:{})}),signal});
  if(!response.ok)throw new Error('llama.cpp inference HTTP '+response.status);let buffer='',usage,finish='stop',done=false,total=0;const decoder=new TextDecoder(),calls=new Map();
  for await(const bytes of response.body){total+=bytes.length;if(total>1048576)throw new Error('llama.cpp response exceeded limit');buffer+=decoder.decode(bytes,{stream:true});let newline;
   while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]'){done=true;continue;}const chunk=JSON.parse(data);if(chunk.error)throw new Error('llama.cpp generation failed');if(chunk.usage)usage=chunk.usage;const choice=chunk.choices?.[0];if(choice?.finish_reason)finish=choice.finish_reason;if(choice?.delta?.content)yield{type:'delta',text:choice.delta.content};
    for(const call of choice?.delta?.tool_calls??[]){if(!Number.isInteger(call.index)||call.index<0||call.index>=128)throw new Error('Invalid llama.cpp tool index');const current=calls.get(call.index)??{index:call.index,id:call.id??'call_'+randomUUID(),type:'function',function:{name:'',arguments:''}};if(call.id)current.id=call.id;current.function.name+=call.function?.name??'';current.function.arguments+=call.function?.arguments??'';calls.set(call.index,current);}
   }
  }
  if(!done||!Number.isSafeInteger(usage?.prompt_tokens)||!Number.isSafeInteger(usage?.completion_tokens))throw new Error('llama.cpp did not report completed metered usage');
  if(calls.size){const values=[...calls.values()];for(const call of values){const args=JSON.parse(call.function.arguments);if(!call.function.name||!args||typeof args!=='object'||Array.isArray(args)||call.function.arguments.length>90000)throw new Error('Invalid llama.cpp tool call');}yield{type:'tool_calls',calls:values};}
  yield{type:'done',promptTokens:usage.prompt_tokens,tokens:usage.completion_tokens,finishReason:calls.size?'tool_calls':finish==='length'?'length':'stop'};
 }
}
export function llamaArguments(instance,path){return['--model',path,'--host','127.0.0.1','--port',String(instance.port),'--alias',instance.model.id,'--ctx-size',String(instance.contextTokens??4096),'--parallel','1','--threads',String(instance.threads),'--batch-size',String(instance.batch),'--n-gpu-layers',instance.backend==='cpu'?'0':'99','--jinja','--chat-template-kwargs','{"enable_thinking":false}','--reasoning-budget','0','--no-webui'];}
export class LlamaCppPool extends OllamaPool{
 constructor(options={}){super({...options,runtime:'managed',explicitRuntime:true});}
 async start(instance){instance.slots=1;instance.contextTokens=this.options.contextTokens??4096;if(!Number.isInteger(instance.contextTokens)||instance.contextTokens<512||instance.contextTokens>32768)throw new Error('llama.cpp context must be 512-32768');instance.client=new LlamaCppClient('http://127.0.0.1:'+instance.port,instance.model.id);}
 async installOnce(instance,progress=()=>{}){
  await this.stopChild(instance);const client=instance.client;client.installController=new AbortController();const signal=AbortSignal.any([client.installController.signal,AbortSignal.timeout(2*60*60*1000)]);
  const asset=instance.model.gguf??nativeAsset(instance.model.id);if(!asset)throw new Error('No pinned GGUF for '+instance.model.id);
  const cached=join(this.cache,'blobs','sha256-'+asset.sha256),path=existsSync(cached)&&await fileDigest(cached)===asset.sha256?cached:await modelAsset(asset,join(this.cache,'llmesh-assets'),progress,signal),executable=await llamaExecutable(this.options);
  progress({status:'Loading GGUF directly with llama.cpp'});
  const env={...process.env,...this.options.env,GGML_VK_VISIBLE_DEVICES:instance.backend==='cpu'?'-1':instance.gpuIndexes.join(',')};
  const child=instance.child=spawn(executable,llamaArguments(instance,path),{env,cwd:dirname(executable),windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','ignore','pipe']});let failure;
  child.once('error',error=>{failure=error;});child.stderr?.on('data',bytes=>this.emit('log',{instance:instance.id,message:bytes.toString().slice(0,4000)}));
  try{for(let i=0;i<1800;i++){signal.throwIfAborted();if(failure)throw failure;if(child.exitCode!=null)throw new Error('llama.cpp exited while loading the GGUF');if(await client.available()){client.model=instance.model.id;return;}await pause(100);}throw new Error('llama.cpp load timed out');}catch(error){await this.stopChild(instance);throw error;}
 }
 async restart(id){const instance=this.instances.find(item=>item.id===id);if(!instance||instance.inFlight)throw new Error('Drain active requests before restarting');clearTimeout(instance.restartTimer);instance.restartTimer=null;instance.state='starting';await this.installOnce(instance);instance.state='ready';instance.error=null;}
}
