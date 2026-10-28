import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { OllamaPool } from '../src/runtime/pool.js';
import { planPlacement } from '../src/placement.js';
const hardware={ramGB:64,freeRamGB:48,cores:16,platform:'linux',gpus:[0,1,2].map(index=>({index,uuid:'GPU-'+index,backend:'cuda',name:'NVIDIA',vramGB:24,freeGB:24}))};
test('managed pool isolates GPUs, downloads once, runs three requests concurrently and closes every process', {timeout:20000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'llmesh-pool-'));
  const pool=new OllamaPool({explicitRuntime:true,executable:process.execPath,args:[resolve('test/fake-ollama.js')],cache:directory,bundleDirectory:join(directory,'no-bundle')});
  const placement=planPlacement(hardware,{level:'high',basePort:18500});
  try{
    await pool.configure(placement,hardware);assert.ok(pool.snapshot().every(instance=>instance.state==='ready'),JSON.stringify(pool.snapshot()));
    const stats=await Promise.all(pool.instances.map(instance=>fetch(instance.client.base+'/stats').then(response=>response.json())));
    assert.equal(stats.reduce((sum,stat)=>sum+stat.pulls,0),1);assert.deepEqual(stats.map(stat=>stat.cuda),['GPU-0','GPU-1','GPU-2']);
    const jobs=pool.instances.map(instance=>(async()=>{let output='';for await(const part of pool.chat({model:instance.model.id,instanceId:instance.id,messages:[{role:'user',content:'hi'}],maxTokens:12},AbortSignal.timeout(3000)))if(part.type==='delta')output+=part.text;return output;})());
    assert.equal(pool.instances.reduce((sum,instance)=>sum+instance.inFlight,0),3);
    assert.deepEqual(await Promise.all(jobs),['fake response','fake response','fake response']);
    const first=pool.instances[0],oldPid=first.child.pid;await pool.restart(first.id);assert.notEqual(first.child.pid,oldPid);
    const pids=pool.instances.map(instance=>instance.child.pid);await pool.close();
    for(const pid of pids)assert.throws(()=>process.kill(pid,0));
  }finally{await pool.close();rmSync(directory,{recursive:true,force:true});}
});
test('failed model load falls back on that instance without disabling the others', {timeout:20000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'llmesh-pool-oom-'));
  const pool=new OllamaPool({explicitRuntime:true,executable:process.execPath,args:[resolve('test/fake-ollama.js')],cache:directory,bundleDirectory:join(directory,'none'),env:{FAKE_OOM_MODEL:'qwen3.8:27b'}});
  try{await pool.configure(planPlacement(hardware,{level:'high',basePort:18600}),hardware);assert.ok(pool.snapshot().every(instance=>instance.state==='ready'));assert.ok(pool.snapshot().every(instance=>instance.model==='qwen3.5:9b'));}
  finally{await pool.close();rmSync(directory,{recursive:true,force:true});}
});
