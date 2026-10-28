import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { funnelSettings } from '../core/funnel/protocol.js';
export const defaultData = () => process.env.LLMESH_HOME ?? (process.platform==='win32'?join(process.env.APPDATA??homedir(),'llmesh-headless'):join(process.env.XDG_DATA_HOME??join(homedir(),'.local','share'),'llmesh'));
export const defaultConfig = () => join(process.env.XDG_CONFIG_HOME??join(homedir(),'.config'),'llmesh','config.json');
const list = value => Array.isArray(value)?value:String(value??'').split(',').filter(Boolean);
export function secretEnv(name, env=process.env){return env[name+'_FILE']?readFileSync(env[name+'_FILE'],'utf8').trim():env[name];}
export function loadConfig(argv=process.argv.slice(2), env=process.env) {
  const {values,positionals}=parseArgs({args:argv,allowPositionals:true,options:{
    config:{type:'string'},listen:{type:'string'},gpus:{type:'string'},placement:{type:'string'},parallel:{type:'string'},runtime:{type:'string'},'ollama-url':{type:'string',multiple:true},level:{type:'string'},
    'data-dir':{type:'string'},'admin-socket':{type:'string'},'metrics-listen':{type:'string'},'tls-cert':{type:'string'},'tls-key':{type:'string'},'insecure-listen':{type:'boolean'},
    'install-runtime':{type:'boolean'},'log-format':{type:'string'},'drain-timeout':{type:'string'},json:{type:'boolean'},offline:{type:'boolean'},version:{type:'boolean'},help:{type:'boolean'},out:{type:'string'},
    funnel:{type:'string'},'funnel-relay':{type:'string'},'funnel-public-url':{type:'string'},'funnel-public-base':{type:'string'}
  }});
  const configPath=values.config??env.LLMESH_CONFIG??defaultConfig();
  const file=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
  if(values.config&&!existsSync(configPath))throw new Error('Config file not found: '+configPath);
  const pick=(flag,variable,key,fallback)=>values[flag]??env[variable]??file[key]??fallback;
  const dataDir=resolve(pick('data-dir','LLMESH_HOME','dataDir',defaultData()));
  const config={ configPath, dataDir,command:values.version?'version':positionals[0]??'serve',args:positionals.slice(1),json:values.json,offline:values.offline,help:values.help,out:values.out,
    listen:pick('listen','LLMESH_LISTEN','listen','127.0.0.1:'+(env.LLMESH_PORT??7337)),
    level:pick('level','LLMESH_LEVEL','level','medium'),placement:pick('placement','LLMESH_PLACEMENT','placement','auto'),parallel:Number(pick('parallel','LLMESH_PARALLEL','parallel',1)),
    gpus:pick('gpus','LLMESH_GPUS','gpus','auto'),runtime:pick('runtime','LLMESH_RUNTIME','runtime','managed'),explicitRuntime:values.runtime!=null||env.LLMESH_RUNTIME!=null||file.runtime!=null,
    urls:list(values['ollama-url']??env.LLMESH_OLLAMA_URLS??file.ollamaUrls??[]),
    adminSocket:pick('admin-socket','LLMESH_ADMIN_SOCKET','adminSocket',process.platform==='win32'?"\\\\.\\pipe\\llmesh-"+createHash('sha256').update(dataDir).digest('hex').slice(0,32):join(env.XDG_RUNTIME_DIR??dataDir,'admin.sock')),
    metricsListen:pick('metrics-listen','LLMESH_METRICS_LISTEN','metricsListen',null),
    tlsCert:pick('tls-cert','LLMESH_TLS_CERT','tlsCert',null),tlsKey:pick('tls-key','LLMESH_TLS_KEY','tlsKey',null),
    insecureListen:pick('insecure-listen','LLMESH_INSECURE_LISTEN','insecureListen',false),installRuntime:values['install-runtime']??false,
    logFormat:pick('log-format','LLMESH_LOG_FORMAT','logFormat','json'),drainTimeout:Number(pick('drain-timeout','LLMESH_DRAIN_TIMEOUT','drainTimeout',30)),
    topic:env.LLMESH_TOPIC??file.topic,allowedWorkers:list(env.LLMESH_WORKERS??file.allowedWorkers),trustedCoordinators:list(env.LLMESH_COORDINATORS??file.trustedCoordinators),energy:file.energy??{},
    funnel:pick('funnel','LLMESH_FUNNEL','funnel','off'),funnelRelay:pick('funnel-relay','LLMESH_FUNNEL_RELAY','funnelRelay',null),
    funnelPublicUrl:pick('funnel-public-url','LLMESH_FUNNEL_PUBLIC_URL','funnelPublicUrl',null),funnelPublicBase:pick('funnel-public-base','LLMESH_FUNNEL_PUBLIC_BASE','funnelPublicBase',null),
    funnelToken:secretEnv('LLMESH_FUNNEL_TOKEN',env)||file.funnelToken||null,funnelAllow:list(env.LLMESH_FUNNEL_ALLOW??file.funnelAllow??[])
  };
  if(!['low','medium','high'].includes(config.level))throw new Error('level must be low, medium, or high');
  if(!['auto','split','replicate'].includes(config.placement))throw new Error('placement must be auto, split, or replicate');
  if(!['managed','external'].includes(config.runtime))throw new Error('runtime must be managed or external');
  if(!Number.isInteger(config.parallel)||config.parallel<1||config.parallel>4)throw new Error('parallel must be 1–4');
  if(!Number.isFinite(config.drainTimeout)||config.drainTimeout<0||config.drainTimeout>300)throw new Error('drain-timeout must be 0–300 seconds');
  if(!['json','pretty'].includes(config.logFormat))throw new Error('log-format must be json or pretty');
  if(typeof config.gpus==='string'&&!['auto','all'].includes(config.gpus))config.gpus=list(config.gpus);
  for(const url of config.urls){const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('ollama-url must be HTTP(S) without embedded credentials');}
  const address=new URL('http://'+config.listen);config.host=address.hostname.replace(/^\[|\]$/g,'');config.port=Number(address.port||80);
  const relayCommand=config.command==='funnel'&&config.args[0]==='relay';
  const loopback=['127.0.0.1','::1','localhost'].includes(config.host);
  if(!relayCommand&&!loopback&&!(config.tlsCert&&config.tlsKey)&&![true,'true','1'].includes(config.insecureListen))throw new Error('Non-loopback listen requires tls-cert/tls-key or explicit --insecure-listen');
  if(config.funnelAllow.some(key=>!/^[a-f0-9]{64}$/.test(key)))throw new Error('Funnel allowlist entries must be 64-character node keys');
  const funnel=funnelSettings({provider:config.funnel,relay:config.funnelRelay,publicUrl:config.funnelPublicUrl,publicBase:config.funnelPublicBase,token:config.funnelToken},{allowInsecure:[true,'true','1'].includes(config.insecureListen)});
  config.funnel=funnel.provider;config.funnelRelay=funnel.relay;config.funnelPublicUrl=funnel.publicUrl;config.funnelPublicBase=funnel.publicBase;config.funnelToken=funnel.token;
  config.funnelPlainRelay=relayCommand&&!loopback&&!(config.tlsCert&&config.tlsKey);
  return config;
}
