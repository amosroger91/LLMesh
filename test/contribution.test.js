import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseContribution } from '../src/contribution.js';
import { recommend } from '../src/hardware.js';
import { Service } from '../src/service.js';
import { generateSecretKey } from '../src/identity.js';
const hardware = { ramGB: 64, freeRamGB: 48, cores: 16, physicalCores: 8, gpus: [{ vramGB: 24, freeGB: 23 }], unifiedMemory: false };
test('low, medium and high automatically choose different model and CPU budgets', () => {
  const profiles = ['low', 'medium', 'high'].map(level => chooseContribution(hardware, level));
  assert.deepEqual(profiles.map(profile => profile.model.id), ['qwen3.5:4b', 'qwen3.5:9b', 'qwen3.8:27b']);
  assert.deepEqual(profiles.map(profile => profile.threads), [2, 4, 8]);
  assert.deepEqual(profiles.map(profile => profile.reward), [1, 1, 1]);
  assert.equal(chooseContribution(hardware).level, 'medium');
  assert.equal(chooseContribution({ ...hardware, gpus: [], freeRamGB: 1 }).model, null);
  assert.equal(chooseContribution({ ...hardware, gpus: [{ vramGB: 4, freeGB: 3 }] }, 'low').model.id, 'qwen3.5:2b');
  assert.equal(chooseContribution({ ...hardware, freeRamGB: 1.3, gpus: [{ vramGB: 6, freeGB: 3.2 }] }).model.id, 'qwen3.5:0.8b');
  assert.equal(chooseContribution({ ...hardware, gpus: [] }, 'medium').model.id, 'qwen3.5:4b');
  assert.equal(chooseContribution({ ...hardware, gpus: [] }, 'high').model.id, 'qwen3.8:27b');
});
test('service auto-installs the assigned model, serves only that model, and persists contribution level', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-contribution-')), secret = generateSecretKey(), installs = [], installed = [];
  const ollama = { async installed() { return installed; }, async install(id, progress) { installs.push(id); installed.push(id); progress({ status: 'success' }); }, async unload() {}, close() {} };
  let service = new Service({ directory, secret, network: false, requirePayments: false, ollama });
  function inject() { service.scanHardware = async (level = service.contributionLevel) => { service.hardware = hardware; service.recommendation = recommend(hardware); service.proposedProfile = chooseContribution(hardware, level); return service.proposedProfile; }; }
  try {
    inject(); await service.configureContribution();
    assert.equal(installs[0], 'qwen3.5:9b'); assert.equal(service.setup.state, 'ready');
    await service.configureContribution('high'); assert.equal(installs[1], 'qwen3.8:27b'); assert.deepEqual(service.servingModels(), ['qwen3.8:27b']);
    service.busy = 1; await service.configureContribution('low'); assert.equal(service.pendingContribution, 'low'); assert.equal(installs.length, 2);
    service.busy = 0; await service.configureContribution('low'); assert.equal(service.assignedModel, 'qwen3.5:4b');
    await service.close(); service = new Service({ directory, secret, network: false, requirePayments: false, ollama });
    assert.equal(service.contributionLevel, 'low');
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('automatic setup retries a smaller model after an out-of-memory load', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-fallback-')), installed = [];
  const ollama = { async installed() { return installed; }, async install(id) { if (id === 'qwen3.5:9b') throw new Error('out of memory'); installed.push(id); }, async unload() {}, close() {} };
  const service = new Service({ directory, secret: generateSecretKey(), network: false, requirePayments: false, ollama });
  service.scanHardware = async level => { service.hardware = hardware; service.recommendation = recommend(hardware); service.proposedProfile = chooseContribution(hardware, level); };
  try {
    await service.configureContribution('medium'); assert.equal(service.assignedModel, 'qwen3.5:4b');
    assert.equal(service.setup.state, 'ready'); assert.equal(service.profile.level, 'medium'); assert.match(service.profile.reason, /exceeded available memory/);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('relaxed checks attempt the smallest CPU model on an occupied 6GB GPU system', () => {
  const occupied = { ...hardware, ramGB: 16, freeRamGB: 3.8, gpus: [{ vramGB: 6, freeGB: 1.38 }] };
  const profile = chooseContribution(occupied);
  assert.equal(profile.model.id, 'qwen3.5:0.8b'); assert.equal(profile.mode, 'cpu');
  assert.equal(recommend(occupied).model.id, profile.model.id);
  assert.equal(chooseContribution({ ...occupied, freeRamGB: 2.5 }).model, null);
  assert.equal(chooseContribution({ ...occupied, gpus: [{ vramGB: 6, freeGB: 3.0 }] }).mode, 'gpu');
});

test('manual memory override attempts a physically fitting model without relying on free memory',()=>{
 const occupied={...hardware,freeRamGB:0.2,gpus:[]};
 assert.equal(chooseContribution(occupied,'medium').model,null);
 const forced=chooseContribution(occupied,'medium',{forceMemory:true});assert.ok(forced.model);assert.ok(forced.placement.warnings.some(warning=>warning.includes('overridden')));
 assert.equal(chooseContribution({...occupied,ramGB:0.5},'medium',{forceMemory:true}).model,null);
 assert.equal(chooseContribution(occupied,'medium').model,null,'Override does not change future normal planning');
});

test('service forwards the one-time override to planning, attempts loading, and keeps later attempts normal',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'llmesh-force-')),installed=[];
 const service=new Service({directory,secret:generateSecretKey(),network:false,ollama:{async installed(){return installed;},async install(id){installed.push(id);},async unload(){},close(){}}});
 service.scanHardware=async(level,options={})=>{service.hardware={...hardware,freeRamGB:0.2,gpus:[]};service.recommendation=recommend(service.hardware);service.proposedProfile=chooseContribution(service.hardware,level,options);return service.proposedProfile;};
 try{await service.configureContribution('medium',{forceMemory:true});assert.ok(installed.length);assert.equal(service.setup.state,'ready');
  await service.configureContribution('medium');assert.equal(service.setup.state,'error');assert.match(service.setup.message,/No model fits/);
  service.busy=1;await assert.rejects(service.configureContribution('medium',{forceMemory:true}),/Finish active/);service.busy=0;
 }finally{service.busy=0;await service.close();rmSync(directory,{recursive:true,force:true});}
});
