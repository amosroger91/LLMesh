import {randomUUID} from 'node:crypto';
import {usageCredits} from './pricing.js';

export const PROVIDER_BASES={openrouter:'https://openrouter.ai/api/v1',groq:'https://api.groq.com/openai/v1'};
function baseUrl(value){const url=new URL(value);if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('Use HTTPS or a loopback API URL without embedded credentials');return url.href.replace(/\/$/,'');}
function validate(value){
  const kind=['openrouter','groq','custom'].includes(value.kind)?value.kind:'custom';
  const base=baseUrl(PROVIDER_BASES[kind]??value.baseUrl);
  if(typeof value.apiKey!=='string'||value.apiKey.length>4096||typeof value.model!=='string'||!value.model.length||value.model.length>200)throw new Error('API key and model ID are required');
  if(value.freeTierConfirmed!==true)throw new Error('Confirm a free-tier key and configure the provider account spend limit before donating');
  if(kind==='openrouter'&&!value.model.endsWith(':free')&&value.model!=='openrouter/free')throw new Error('OpenRouter donations require a :free model or openrouter/free');
  const dailyLimit=Number(value.dailyLimit??100000);if(!Number.isSafeInteger(dailyLimit)||dailyLimit<4096||dailyLimit>10000000)throw new Error('Daily donation limit must be 4096–10000000 model tokens');
  if(value.id!=null&&(typeof value.id!=='string'||!/^[a-z0-9-]{1,80}$/.test(value.id)))throw new Error('Invalid donor ID');
  const size=Number(value.model.match(/(?:^|\D)(\d+(?:\.\d+)?)b(?:\b|_)/i)?.[1]??4);
  const rank=size<=2?1:size<4?2:size<=4?3:size<=9?4:5;
  return {id:value.id??randomUUID(),kind,baseUrl:base,apiKey:value.apiKey,model:value.model,dailyLimit,enabled:value.enabled!==false,
    parametersB:size,rank,freeTierConfirmed:true,maxTokensField:value.maxTokensField==='max_completion_tokens'?'max_completion_tokens':'max_tokens'};
}
export async function discoverProvider(value){
  const base=baseUrl(PROVIDER_BASES[value.kind]??value.baseUrl);
  const response=await fetch(base+'/models',{headers:{Authorization:'Bearer '+String(value.apiKey??'')},signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok)throw new Error('Model discovery failed (HTTP '+response.status+')');
  const text=await response.text();if(text.length>4000000)throw new Error('Provider model list is too large');
  return (JSON.parse(text).data??[]).filter(model=>typeof model.id==='string'&&model.id.length<=200)
    .filter(model=>value.kind!=='openrouter'||model.id.endsWith(':free')||model.id==='openrouter/free')
    .slice(0,1000).map(model=>({id:model.id,name:String(model.name??model.id).slice(0,200)}));
}
export class ProviderPool {
  constructor(db){this.db=db;this.providers=new Map();
    db.exec(`CREATE TABLE IF NOT EXISTS provider_usage (provider TEXT NOT NULL,day TEXT NOT NULL,input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,requests INTEGER NOT NULL DEFAULT 0,errors INTEGER NOT NULL DEFAULT 0,uncertain_tokens INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(provider,day));`);
    if(!db.prepare('PRAGMA table_info(provider_usage)').all().some(column=>column.name==='uncertain_tokens'))db.exec('ALTER TABLE provider_usage ADD COLUMN uncertain_tokens INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE TABLE IF NOT EXISTS provider_calls (id TEXT PRIMARY KEY,provider TEXT NOT NULL,configured_model TEXT NOT NULL,reported_model TEXT,input_tokens INTEGER,output_tokens INTEGER,created INTEGER NOT NULL)');
  }
  configure(values){if(this.snapshot().some(provider=>provider.busy))throw new Error('Finish active API requests before changing donations');if(!Array.isArray(values)||values.length>8)throw new Error('Use up to eight donated API models');
    const checked=values.map(validate);this.providers=new Map(checked.map(provider=>[provider.id,{...provider,busy:0,reserved:0,cooldown:0,metrics:{}}]));}
  configuration(){return [...this.providers.values()].map(({busy:_busy,reserved:_reserved,cooldown:_cooldown,metrics:_metrics,error:_error,controller:_controller,...provider})=>provider);}
  usage(id){return this.db.prepare('SELECT * FROM provider_usage WHERE provider=? AND day=?').get(id,new Date().toISOString().slice(0,10))??{input_tokens:0,output_tokens:0,requests:0,errors:0};}
  model(id){const provider=[...this.providers.values()].find(provider=>'donated:'+provider.id===id);return provider?{id,parametersB:provider.parametersB,rank:provider.rank,source:'third-party',provider:provider.kind,upstreamModel:provider.model}:null;}
  snapshot(){return [...this.providers.values()].map(provider=>{const usage=this.usage(provider.id),remaining=Math.max(0,provider.dailyLimit-usage.input_tokens-usage.output_tokens-(usage.uncertain_tokens??0)-provider.reserved),model=this.model('donated:'+provider.id);
    return {id:'api-'+provider.id,providerId:provider.id,provider:provider.kind,upstreamModel:provider.model,model:model.id,modelInfo:model,source:'third-party',state:!provider.enabled?'disabled':provider.cooldown>Date.now()?'cooldown':remaining<4096?'quota':'ready',busy:provider.busy,
      slots:1,free:provider.enabled&&!provider.busy&&provider.cooldown<=Date.now()&&remaining>=4096?1:0,remainingCredits:remaining,dailyLimit:provider.dailyLimit,usage,calls:this.db.prepare('SELECT configured_model,reported_model,input_tokens,output_tokens,created FROM provider_calls WHERE provider=? ORDER BY created DESC LIMIT 10').all(provider.id),metrics:provider.metrics,error:provider.error??null};});}
  async *chat(job,signal){
    if(job.privacy!=='allow-third-party')throw new Error('Third-party inference was not authorized by the requester');
    const provider=this.providers.get(job.instanceId?.slice(4));if(!provider||'donated:'+provider.id!==job.model)throw new Error('Unknown donated model');
    const reserve=job.contextTokens+job.maxTokens,slot=this.snapshot().find(slot=>slot.id===job.instanceId);
    if(!slot?.free||slot.remainingCredits<reserve)throw new Error('Donated API quota is busy or insufficient');
    provider.busy=1;provider.reserved=reserve;provider.controller=new AbortController();const combined=AbortSignal.any([signal,provider.controller.signal,AbortSignal.timeout(180000)]);
    const day=new Date().toISOString().slice(0,10),started=performance.now();let usage,firstAt,reportedModel,finishReason='stop',outputBytes=0;const calls=new Map();
    this.db.prepare('INSERT OR IGNORE INTO provider_usage(provider,day) VALUES (?,?)').run(provider.id,day);
    try{
      const payload={model:provider.model,messages:job.messages,stream:true,stream_options:{include_usage:true},[provider.maxTokensField]:job.maxTokens,...(job.tools.length?{tools:job.tools,tool_choice:job.tool_choice}:{})};
      const response=await fetch(provider.baseUrl+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+provider.apiKey,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:combined,redirect:'error'});
      if(!response.ok){provider.cooldown=Date.now()+(response.status===429?60000:15000);throw new Error('Donated API HTTP '+response.status+'; donation temporarily paused');}
      const decoder=new TextDecoder();let buffer='';
      for await(const bytes of response.body){buffer+=decoder.decode(bytes,{stream:true});if(buffer.length>1048576)throw new Error('Provider frame too large');let end;
        while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]')continue;
          const chunk=JSON.parse(data);if(chunk.error)throw new Error('Provider failed inference');if(typeof chunk.model==='string')reportedModel=chunk.model.slice(0,200);if(chunk.usage??chunk.x_groq?.usage)usage=chunk.usage??chunk.x_groq?.usage;
          const choice=chunk.choices?.[0];if(choice?.finish_reason)finishReason=choice.finish_reason;
          const text=choice?.delta?.content;if(typeof text==='string'&&text){outputBytes+=Buffer.byteLength(text);if(outputBytes>262144)throw new Error('Provider response too large');if(!firstAt){firstAt=performance.now();provider.metrics.firstTokenMs=firstAt-started;}yield{type:'delta',text};}
          for(const call of choice?.delta?.tool_calls??[]){if(!Number.isInteger(call.index)||call.index<0||call.index>=128)throw new Error('Invalid provider tool calls');const current=calls.get(call.index)??{index:call.index,id:'',type:'function',function:{name:'',arguments:''}};
            current.id+=call.id??'';current.function.name+=call.function?.name??'';current.function.arguments+=call.function?.arguments??'';if(JSON.stringify(current).length>131072)throw new Error('Provider tool call too large');calls.set(call.index,current);}
        }
      }
      if(!usage)throw new Error('Provider did not report token usage; donation paused');
      usageCredits(usage.prompt_tokens,usage.completion_tokens,reserve);if(usage.completion_tokens>job.maxTokens||usage.prompt_tokens>job.contextTokens)throw new Error('Provider exceeded authorized token budget');
      this.db.prepare('UPDATE provider_usage SET input_tokens=input_tokens+?,output_tokens=output_tokens+?,requests=requests+1 WHERE provider=? AND day=?').run(usage.prompt_tokens,usage.completion_tokens,provider.id,day);
      this.db.prepare('INSERT INTO provider_calls VALUES (?,?,?,?,?,?,?)').run(randomUUID(),provider.id,provider.model,reportedModel??null,usage.prompt_tokens,usage.completion_tokens,Date.now());
      if(calls.size)yield{type:'tool_calls',calls:[...calls.values()]};
      provider.metrics.tokensPerSecond=usage.completion_tokens/Math.max(.001,(performance.now()-(firstAt??started))/1000);provider.error=null;
      yield{type:'done',tokens:usage.completion_tokens,promptTokens:usage.prompt_tokens,finishReason};
    }catch(error){provider.error=error.message;provider.cooldown=Math.max(provider.cooldown,Date.now()+60000);
      // Failed/unknown usage consumes its full local authorization conservatively.
      // No inference credits are earned without a completed metered response.
      this.db.prepare('UPDATE provider_usage SET uncertain_tokens=uncertain_tokens+?,errors=errors+1 WHERE provider=? AND day=?').run(reserve,provider.id,day);throw error;
    }finally{provider.busy=0;provider.reserved=0;provider.controller=null;}
  }
  close(){for(const provider of this.providers.values())provider.controller?.abort();}
}
