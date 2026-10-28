#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync,readFileSync,writeFileSync,existsSync,accessSync,constants } from 'node:fs';
import { join,resolve,dirname } from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { loadConfig,secretEnv } from './config.js';
import { startAdmin,adminRequest } from './admin.js';
import { FileKeyStore } from './key-store.js';
import { Service } from '../core/service.js';
import { Payments } from '../core/payments.js';
import { generateSecretKey } from '../core/identity.js';
import { detectHardware } from '../core/hardware.js';
import { planPlacement } from '../core/placement.js';
import { catalog } from '../core/catalog.js';
import { loadKey } from '../core/key-store.js';
import { Ollama } from '../core/ollama.js';
import { OLLAMA_VERSION } from '../core/runtime/pool.js';
import { startApi } from '../core/api.js';
import { createNodeFunnel, FunnelRelay, funnelDoctor } from '../core/funnel/index.js';
import { logger } from '../core/log.js';
import version from '../../package.json' with {type:'json'};
const execute=promisify(execFile);
const print=(value,json)=>console.log(json?JSON.stringify(value,null,2):typeof value==='string'?value:JSON.stringify(value,null,2));
const executable=()=>process.platform==='win32'&&existsSync(join(process.env.LOCALAPPDATA??'','Programs','Ollama','ollama.exe'))?join(process.env.LOCALAPPDATA,'Programs','Ollama','ollama.exe'):'ollama';
const placementOptions=config=>({level:config.level,gpuSelection:config.gpus,mode:config.placement,parallel:config.parallel});
async function doctor(config){const checks=[];const add=(name,ok,detail)=>checks.push({name,ok,detail});
  add('node',Number(process.versions.node.split('.')[0])>=24,process.version);
  const hardware=await detectHardware();add('hardware',true,{gpus:hardware.gpus,placement:planPlacement(hardware,placementOptions(config))});
  try { let parent=config.dataDir;while(!existsSync(parent)&&dirname(parent)!==parent)parent=dirname(parent);accessSync(parent,constants.R_OK|constants.W_OK);add('data-directory',true,config.dataDir); }
  catch(error){add('data-directory',false,error.message);}
  if(!config.offline){try{const result=await execute(executable(),['--version'],{windowsHide:true,timeout:5000});add('ollama',true,result.stdout.trim());}catch{add('ollama',config.runtime==='external',`Install Ollama ${OLLAMA_VERSION}: https://ollama.com/download/linux or use --runtime external --ollama-url URL`);}
    for(const url of config.urls.length?config.urls:['http://127.0.0.1:11434'])add('runtime '+url,await new Ollama(url).available(),'API health');
    try{const status=await adminRequest(config.adminSocket,{command:'status'});add('daemon',true,{instances:status.instances,payments:status.payments?.configured,settlements:status.payments?.jobs?.filter(job=>job.state==='settle-pending').length});}catch{add('daemon',false,'No daemon at '+config.adminSocket);}
  }
  checks.push(...await funnelDoctor(config));
  return {ok:checks.every(check=>check.ok),checks,notes:['Clock/NAT and physical multi-GPU checks require an online deployment.','No runtime is installed by doctor.','A verified funnel publishes this OpenAI-compatible API for a phone, a cloud job, or another client. Mesh jobs stay on the peer connection.']};
}
async function main(){const config=loadConfig();
  if(config.help){print('llmesh serve | status | gpus | models list|install|remove | group create|invite|join|members|revoke | wallet address|balance|claim|refund | keys export|import | funnel status|probe | funnel relay | doctor | --version');return;}
  if(config.command==='version'){print(version.version);return;}
  if(config.command==='funnel'&&config.args[0]==='relay'){
    const log=logger(config.logFormat);
    const loopback=['127.0.0.1','::1','localhost'].includes(config.host);
    if(!loopback&&!(config.tlsCert&&config.tlsKey))log('warning',{message:'Funnel relay is listening without TLS by explicit request. Terminate TLS at a proxy if this process is plain HTTP.'});
    if(config.funnelOpen)log('warning',{message:'Funnel relay is open. Any node that can sign an announcement can publish through it.'});
    const tls=config.tlsCert&&config.tlsKey?{cert:readFileSync(config.tlsCert),key:readFileSync(config.tlsKey)}:undefined;
    const relay=new FunnelRelay({token:config.funnelToken,allow:config.funnelAllow,publicBase:config.funnelPublicBase,tls});
    await relay.listen(config.port,config.host);
    log('funnel-relay',relay.status());
    const stop=()=>relay.close().then(()=>process.exit(0),error=>{log('shutdown-error',{error:error.message});process.exit(1);});
    process.on('SIGTERM',stop);process.on('SIGINT',stop);return;
  }
  if(config.command==='gpus'){const hardware=await detectHardware();print({gpus:hardware.gpus,placement:planPlacement(hardware,placementOptions(config))},config.json);return;}
  if(config.command==='doctor'){const result=await doctor(config);print(result,config.json);if(!result.ok)process.exitCode=1;return;}
  if(config.command==='keys'){
    const passphrase=secretEnv('LLMESH_BACKUP_PASSPHRASE');if(!passphrase)throw new Error('Set LLMESH_BACKUP_PASSPHRASE or LLMESH_BACKUP_PASSPHRASE_FILE');
    mkdirSync(config.dataDir,{recursive:true,mode:0o700});const keys=new FileKeyStore(config.dataDir);
    if(config.args[0]==='export'){if(!config.out)throw new Error('keys export requires --out FILE');if(existsSync(config.out))throw new Error('Backup output already exists');
      loadKey(resolve(config.out),()=>JSON.stringify({format:'llmesh-backup-v1',identity:keys.load('identity',()=>{throw new Error('No identity yet');}),wallet:keys.load('wallet',()=>{throw new Error('No wallet yet');}),api:keys.load('api',()=>{throw new Error('No API key yet');})}),passphrase);print('Encrypted backup written');return;}
    if(config.args[0]==='import'){const file=config.args[1];if(!file||!existsSync(file))throw new Error('keys import requires an existing backup');
      const running=await adminRequest(config.adminSocket,{command:'status'}).then(()=>true,()=>false);if(running)throw new Error('Stop the daemon before importing keys');
      const backup=JSON.parse(loadKey(file,()=>'',passphrase));if(backup.format!=='llmesh-backup-v1'||!/^[a-f0-9]{64}$/.test(backup.identity)||!/^0x[a-f0-9]{64}$/i.test(backup.wallet)||!/^[a-f0-9]{64}$/.test(backup.api))throw new Error('Invalid encrypted backup');
      for(const name of ['identity','wallet','api']){const path=join(config.dataDir,name+'.key');writeFileSync(path,backup[name],{mode:0o600});loadKey(path,()=>'',secretEnv('LLMESH_KEY_PASSPHRASE')??passphrase);}print('Keys imported; use the configured key passphrase to start the daemon');return;}
    throw new Error('Use keys export --out FILE or keys import FILE');
  }
  if(config.command!=='serve'){print(await adminRequest(config.adminSocket,{command:config.command,args:config.args}),config.json);return;}
  const log=logger(config.logFormat);
  if(!['127.0.0.1','::1','localhost'].includes(config.host)&&config.insecureListen)log('warning',{message:'Public API is listening without TLS by explicit request'});
  mkdirSync(config.dataDir,{recursive:true,mode:0o700});
  if(process.platform==='win32'&&!secretEnv('LLMESH_KEY_PASSPHRASE'))log('warning',{message:'Headless plaintext keys require Windows ACL protection; use LLMESH_KEY_PASSPHRASE_FILE'});
  if(config.runtime==='managed'){
    const existing=!config.explicitRuntime&&await new Ollama().available();
    if(!existing)try{await execute(executable(),['--version'],{windowsHide:true,timeout:5000});}catch{
      if(!config.installRuntime)throw new Error(`Ollama is missing. Install ${OLLAMA_VERSION} from https://ollama.com/download/linux, or opt in with --install-runtime`);
      if(process.platform!=='linux')throw new Error('CLI automatic runtime installation is Linux-only; install Ollama manually');
      await execute('sh',['-c',`curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION=${OLLAMA_VERSION} sh`],{timeout:300000});
    }
  }
  const keys=new FileKeyStore(config.dataDir),secret=Buffer.from(keys.load('identity',()=>Buffer.from(generateSecretKey()).toString('hex')),'hex');
  const payments=new Payments(keys.load('wallet',()=>Wallet.createRandom().privateKey),{rpc:process.env.LLMESH_RPC,chainId:Number(process.env.LLMESH_CHAIN_ID??84532),token:process.env.LLMESH_TOKEN,escrow:process.env.LLMESH_ESCROW});
  await payments.startConnection();
  let group=existsSync(join(config.dataDir,'group.json'))?JSON.parse(readFileSync(join(config.dataDir,'group.json'),'utf8')):{};
  const groupTopic=existsSync(join(config.dataDir,'group.key'))?keys.load('group',()=>{throw new Error('Missing group key');}):config.topic;
  const service=new Service({directory:config.dataDir,secret,apiKey:keys.load('api',()=>randomBytes(32).toString('hex')),payments,topic:groupTopic,
    allowedWorkers:[...new Set([...config.allowedWorkers,...(group.workers??[])])],trustedCoordinators:[...new Set([...config.trustedCoordinators,...(group.coordinators??[])])],
    runtime:{engine:config.engine,executable:config.llamaServer,runtime:config.runtime,explicitRuntime:config.explicitRuntime,urls:config.urls},placement:placementOptions(config)});
  service.drainTimeoutMs=config.drainTimeout*1000;service.on('progress',item=>log('setup',item));service.on('log',entry=>log('runtime',entry));
  await service.initialize();if(Object.keys(config.energy).length)service.energy.configure(config.energy);
  const tls=config.tlsCert&&config.tlsKey?{cert:readFileSync(config.tlsCert),key:readFileSync(config.tlsKey)}:undefined;
  const api=await startApi(service,{host:config.host,port:config.port,tls});let metrics;
  if(config.metricsListen){const url=new URL('http://'+config.metricsListen);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Metrics listener must be loopback');
    metrics=http.createServer((_req,res)=>{const instances=service.status().instances;const funnel=service.funnel?.status?.()??{provider:'off',state:'off',requests:0};const lines=['# TYPE llmesh_slots_busy gauge',...instances.map(instance=>`llmesh_slots_busy{instance="${instance.id}"} ${instance.inFlight??0}`),...instances.map(instance=>`llmesh_tokens_per_second{instance="${instance.id}"} ${instance.metrics?.tokensPerSecond??0}`),`llmesh_settlement_pending ${service.ledger.db.prepare("SELECT COUNT(*) AS count FROM settlements WHERE state='settle-pending'").get().count}`,'# TYPE llmesh_funnel_up gauge',`llmesh_funnel_up{provider="${funnel.provider??'off'}"} ${funnel.state==='verified'||funnel.state==='pending'?1:0}`,'# TYPE llmesh_funnel_verified gauge',`llmesh_funnel_verified ${funnel.state==='verified'?1:0}`,'# TYPE llmesh_funnel_requests counter',`llmesh_funnel_requests ${Number(funnel.requests)||0}`];res.end(lines.join('\n')+'\n');});metrics.listen(Number(url.port),url.hostname);}
  service.funnel=createNodeFunnel({provider:config.funnel,relay:config.funnelRelay,token:config.funnelToken,cloudflareToken:config.funnelCloudflareToken,publicUrl:config.funnelPublicUrl,publicBase:config.funnelPublicBase,allowInsecure:[true,'true','1'].includes(config.insecureListen),secret,pubkey:service.pubkey,apiHost:'127.0.0.1',apiPort:api.address().port,tls:Boolean(tls)});
  if(config.funnel!=='off'){await service.funnel.start();log('funnel',service.funnel.status());}
  const saveGroup=()=>writeFileSync(join(config.dataDir,'group.json'),JSON.stringify(group,null,2),{mode:0o600});
  const reload=async()=>{const next=loadConfig();if(Object.keys(next.energy).length)service.energy.configure(next.energy);
    if(JSON.stringify(placementOptions(next))!==JSON.stringify(placementOptions(config))){await service.drain(service.drainTimeoutMs);await service.configurePlacement(placementOptions(next));service.draining=false;}
    if(service.mesh){service.mesh.allowedWorkers=[...new Set([...next.allowedWorkers,...(group.workers??[])])];service.mesh.trustedCoordinators=[...new Set([...next.trustedCoordinators,...(group.coordinators??[])])];}return service.status();};
  const admin=await startAdmin(config.adminSocket,async message=>{
    const args=message.args??[];
    if(message.command==='funnel')return args[0]==='probe'?service.funnel.probe():service.funnel?.status()??{provider:'off',state:'off',publicUrl:null};
    if(message.command==='status')return service.status();if(message.command==='drain')return {drained:await service.drain(service.drainTimeoutMs)};if(message.command==='reload')return reload();
    if(message.command==='models'){
      if(!args.length||args[0]==='list')return {catalog:catalog.models,installed:await service.ollama.installed(),instances:service.status().instances};
      const model=catalog.models.find(model=>model.id===args[1]);if(!model)throw new Error('Use a catalog model ID');if(service.busy||service.requests||service.installing)throw new Error('Finish active requests first');
      const instance=service.ollama.instances[0];if(!instance)throw new Error('No runtime is available');
      if(args[0]==='install'){await instance.client.install(model.id,item=>log('download',item));await instance.client.warm(instance.model.id);return {installed:model.id};}
      if(args[0]==='remove'){if(service.servingModels().includes(model.id))throw new Error('Cannot remove a currently assigned model');const response=await fetch(instance.client.base+'/api/delete',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:model.id})});if(!response.ok)throw new Error('Runtime refused model removal');return {removed:model.id};}
    }
    if(message.command==='wallet'){if(args[0]==='address')return {address:payments.wallet.address};if(args[0]==='balance')return payments.refresh();if(args[0]==='claim')return payments.register(service.pubkey);if(args[0]==='refund')return {transaction:await payments.refund({id:args[1]})};}
    if(message.command==='group'){
      if(args[0]==='members')return {owner:service.pubkey,workers:group.workers??[],coordinators:group.coordinators??[]};
      if(args[0]==='revoke'){const key=args[1];group.workers=(group.workers??[]).filter(value=>value!==key);group.coordinators=(group.coordinators??[]).filter(value=>value!==key);saveGroup();service.mesh?.byIdentity.get(key)?.socket.destroy();return reload();}
      if(args[0]==='create'||args[0]==='join'){
        const invite=args[0]==='join'?JSON.parse(Buffer.from(args[1]??'','base64url').toString()):{v:1,topic:randomBytes(32).toString('hex'),coordinator:service.pubkey};
        if(invite.v!==1||!/^[a-f0-9]{64}$/.test(invite.topic)||!/^[a-f0-9]{64}$/.test(invite.coordinator))throw new Error('Invalid group invite');
        writeFileSync(join(config.dataDir,'group.key'),invite.topic,{mode:0o600});loadKey(join(config.dataDir,'group.key'),()=>'',secretEnv('LLMESH_KEY_PASSPHRASE'));
        group={...group,coordinators:[invite.coordinator],workers:group.workers??[]};saveGroup();return {invite:Buffer.from(JSON.stringify(invite)).toString('base64url'),restartRequired:true,note:'Approve worker keys in the config before sharing inference. This invite is a group secret, not a certificate.'};
      }
      if(args[0]==='invite'){const topic=keys.load('group',()=>{throw new Error('Create a group first');});return {invite:Buffer.from(JSON.stringify({v:1,topic,coordinator:group.coordinators?.[0]??service.pubkey})).toString('base64url')};}
    }
    throw new Error('Unsupported admin command');
  });
  service.startContributionManagement(config.level);log('listening',{api:service.apiUrl,admin:config.adminSocket});
  let closing=false;const close=async()=>{if(closing)return;closing=true;log('draining');await service.drain(service.drainTimeoutMs);await service.funnel?.stop?.();api.close();admin.close();metrics?.close();api.closeAllConnections();await service.close();log('stopped');};
  process.on('SIGTERM',()=>{void close().then(()=>process.exit(0),error=>{log('shutdown-error',{error:error.message});process.exit(1);});});
  process.on('SIGINT',()=>{void close().then(()=>process.exit(0),error=>{log('shutdown-error',{error:error.message});process.exit(1);});});
  process.on('SIGHUP',()=>{void reload().then(()=>log('reloaded'),error=>log('reload-error',{error:error.message}));});
}
main().catch(error=>{console.error(JSON.stringify({event:'error',message:error.message}));process.exitCode=1;});
