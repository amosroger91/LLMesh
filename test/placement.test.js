import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planPlacement } from '../src/placement.js';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/hardware/${name}.json`, import.meta.url)));
test('placement fixtures use every eligible GPU, isolate backends and choose split or replicate', () => {
  for (const name of ['one-8','one-24','two-12','two-24','mixed-size','four-16','mixed-vendor','laptop','apple','cpu']) {
    const hardware = fixture(name), plan = planPlacement(hardware, {level:'high'});
    assert.ok(plan.instances.length, name); const assigned = plan.instances.flatMap(instance=>instance.gpus);
    assert.equal(new Set(assigned).size, assigned.length, name+' reused GPU');
    const eligible = hardware.gpus.filter(gpu=>!gpu.integrated);
    assert.equal(assigned.length, eligible.length, name+' missing GPU');
    for(const instance of plan.instances) {
      assert.ok(instance.candidates.every(model=>model.rank<=instance.model.rank));
      const backends = new Set(hardware.gpus.filter(gpu=>instance.gpus.includes(gpu.uuid)).map(gpu=>gpu.backend));
      assert.ok(backends.size<=1, name+' mixed backends');
    }
  }
  const split=planPlacement(fixture('two-12'),{level:'high'});assert.equal(split.instances.length,1);assert.equal(split.instances[0].mode,'split');assert.equal(split.instances[0].model.id,'qwen3.8:27b');
  const copies=planPlacement(fixture('two-24'),{level:'high'});assert.equal(copies.instances.length,2);assert.ok(copies.instances.every(instance=>instance.model.id==='qwen3.8:27b'));
  assert.equal(planPlacement(fixture('four-16'),{level:'high'}).instances.length,3);
  assert.equal(planPlacement(fixture('two-24'),{level:'low'}).instances.length,1);
  assert.equal(planPlacement(fixture('two-24'),{level:'high',mode:'split'}).instances.length,1);
  assert.equal(planPlacement(fixture('two-12'),{level:'high',mode:'replicate'}).instances.length,2);
  assert.throws(()=>planPlacement(fixture('one-8'),{gpuSelection:['missing']}),/Unknown GPU/);
});

test('Windows measured free VRAM does not reserve display memory twice',()=>{
 const hw={platform:'win32',ramGB:16,freeRamGB:1.7,cores:16,physicalCores:8,gpus:[{index:0,uuid:'GPU-0',vendor:'NVIDIA',backend:'cuda',vramGB:6,freeGB:2.9}]};
 const plan=planPlacement(hw,{level:'high'});assert.equal(plan.instances.length,1);assert.equal(plan.instances[0].model.id,'qwen3.5:0.8b');assert.equal(plan.instances[0].backend,'cuda');
 const unknown={...hw,gpus:[{...hw.gpus[0],freeGB:undefined}]};assert.equal(planPlacement(unknown,{level:'high'}).instances[0].memoryBudgetGB,3.75);
});
