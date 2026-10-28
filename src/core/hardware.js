import os from 'node:os';
import si from 'systeminformation';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { catalog } from './catalog.js';
import { planPlacement } from './placement.js';
export { catalog } from './catalog.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const GB = 1024 ** 3;
const execute = promisify(execFile);

// Estimates are advisory: try loads with 20% less than the catalog estimate.
// The runtime remains the authority and setup falls back on allocation failure.
export const MODEL_MEMORY_FACTOR = 0.8;
export const HOST_RAM_RESERVE_GB = 1;
export const UNIFIED_RESERVE_GB = 2;

export function parseNvidiaMemory(text) {
  return text.trim().split('\n').flatMap(line => {
    const fields = line.split(',').map(field=>field.trim()), modern = fields.length >= 7;
    const total=Number(fields.at(modern?-4:-2)), free=Number(fields.at(modern?-3:-1));
    if(fields.length<4||!Number.isFinite(total)||total<=0)return [];
    return [{index:Number(fields[0]),uuid:modern?fields[1]:`nvidia-${fields[0]}`,name:fields.slice(modern?2:1,modern?-4:-2).join(','),
      vendor:'NVIDIA',backend:'cuda',integrated:false,pciBus:modern?fields.at(-2).toLowerCase():undefined,
      powerWatts:modern&&Number.isFinite(Number(fields.at(-1)))?Number(fields.at(-1)):undefined,
      vramGB:total/1024,freeGB:Number.isFinite(free)&&free>=0?Math.min(free,total)/1024:undefined,source:'NVIDIA driver'}];
  });
}
export function parseRocm(text) {
  const data=JSON.parse(text);return Object.entries(data).filter(([key])=>/^card\d+$/.test(key)).flatMap(([key,value])=>{
    const total=Number(value['VRAM Total Memory (B)']),used=Number(value['VRAM Total Used Memory (B)']);if(!Number.isFinite(total)||total<=0)return [];
    const index=Number(key.slice(4)),uid=String(value['Unique ID']??value['GPU unique ID']??index);
    return [{index,uuid:'rocm-'+uid,runtimeId:String(index),name:value['Card series']??'AMD '+key,vendor:'AMD',backend:'rocm',integrated:false,
      pciBus:value['PCI Bus'],vramGB:total/2**30,freeGB:Number.isFinite(used)?Math.max(0,total-used)/2**30:undefined,source:'ROCm'}];
  });
}
async function amdDevices(){
  if(process.platform!=='linux')return [];
  try{return parseRocm((await execute('rocm-smi',['--showmeminfo','vram','--showuniqueid','--json'],{timeout:4000})).stdout);}catch{}
  const result=[];
  for(const card of await readdir('/sys/class/drm').catch(()=>[])){
    if(!/^card\d+$/.test(card))continue;const root='/sys/class/drm/'+card+'/device';
    try{if((await readFile(root+'/vendor','utf8')).trim()!=='0x1002')continue;
      const total=Number(await readFile(root+'/mem_info_vram_total','utf8')),used=Number(await readFile(root+'/mem_info_vram_used','utf8'));
      const pciBus=(await readlink(root)).split('/').at(-1),index=Number(card.slice(4));
      result.push({index,uuid:'amd-'+pciBus,runtimeId:String(index),name:'AMD '+card,vendor:'AMD',backend:'rocm',integrated:total<2*2**30,pciBus,vramGB:total/2**30,freeGB:Math.max(0,total-used)/2**30,source:'Linux DRM'});
    }catch{}
  }return result;
}

export function recommend(hardware) {
  const placement = planPlacement(hardware, { level: 'high' });
  const best = placement.instances.map(instance => instance.model).sort((a,b) => b.rank-a.rank)[0] ?? null;
  const capacity = planPlacement({ ...hardware, freeRamGB: hardware.ramGB, gpus: hardware.gpus.map(gpu=>({...gpu,freeGB:gpu.vramGB})) }, {level:'high'});
  return { model: best, capacityModel: capacity.instances.map(instance=>instance.model).sort((a,b)=>b.rank-a.rank)[0]??null,
    mode: placement.instances[0]?.backend === 'cpu' ? 'cpu' : hardware.unifiedMemory ? 'unified' : 'gpu', reason: placement.reason, placement,
    alternatives: catalog.models.map(model=>({id:model.id,fitsNow:placement.instances.some(instance=>instance.candidates.some(candidate=>candidate.id===model.id)),recommended:model.id===best?.id})) };
}

export async function detectHardware() {
  const [graphics, cpu, nvidia, amd] = await Promise.all([si.graphics().catch(() => ({ controllers: [] })), si.cpu().catch(() => ({})),
    execute('nvidia-smi', ['--query-gpu=index,uuid,name,memory.total,memory.free,pci.bus_id,power.draw', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 4000 })
      .then(result => parseNvidiaMemory(result.stdout)).catch(() => []), amdDevices()]);
  const normalizePci=value=>String(value??'').toLowerCase().replace(/^00000000:/,'0000:');
  const detected=[...nvidia,...amd];
  const gpus = graphics.controllers.filter(gpu=>!detected.some(device=>
    (gpu.busAddress&&device.pciBus&&normalizePci(gpu.busAddress)===normalizePci(device.pciBus))||
    (gpu.model&&device.name&&gpu.model.trim().toLowerCase()===device.name.trim().toLowerCase())))
    .map((gpu,index)=>({index,uuid:'probe-'+(gpu.busAddress??index),runtimeId:String(index),name:gpu.model??'Unknown GPU',vendor:gpu.vendor??'Unknown',backend:'vulkan',
      integrated:gpu.dynamic||/intel|uhd|iris|apu/i.test(gpu.model??''),pciBus:gpu.busAddress,
      vramGB:(gpu.memoryTotal??gpu.vram??0)/1024,freeGB:gpu.memoryFree==null?undefined:gpu.memoryFree/1024,source:'System probe'}));
  gpus.push(...detected);
  return { platform: os.platform(), arch: os.arch(), cpu: (cpu.brand || os.cpus()[0]?.model || os.arch()).trim(), cores: os.cpus().length,
    physicalCores: cpu.physicalCores > 0 ? cpu.physicalCores : os.cpus().length,
    ramGB: os.totalmem() / GB, freeRamGB: os.freemem() / GB,
    unifiedMemory: os.platform() === 'darwin' && os.arch() === 'arm64',
    gpus };
}
