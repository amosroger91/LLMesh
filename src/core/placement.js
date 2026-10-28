// Pure planner. A GPU belongs to at most one instance; backends never mix.
import { catalog as defaultCatalog, CONTRIBUTION } from './catalog.js';
export const MEMORY_FACTOR = 0.8;
export function gpuBackend(gpu) {
  return gpu.backend ?? (/nvidia/i.test(gpu.vendor ?? gpu.name ?? '') ? 'cuda' : /amd|radeon/i.test(gpu.vendor ?? gpu.name ?? '') ? 'rocm' : 'vulkan');
}
export function planPlacement(hardware, { level = 'medium', gpuSelection = 'auto', mode = 'auto', catalog = defaultCatalog, parallel = 1, basePort = 11500, displayGpu = 0, forceMemory = false, minimumRank = 1, minimumFraction = 0, preferQuantized = false, keepAlive, fixedModel } = {}) {
  if (!CONTRIBUTION[level]) throw new Error('Choose low, medium, or high contribution');
  if (!['auto', 'split', 'replicate'].includes(mode)) throw new Error('Placement must be auto, split, or replicate');
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 4) throw new Error('parallel must be 1–4');
  if (gpuSelection !== 'auto' && gpuSelection !== 'all' && !Array.isArray(gpuSelection)) throw new Error('gpus must be auto, all, or an array of GPU IDs');
  const policy = {...CONTRIBUTION[level],fraction:Math.max(CONTRIBUTION[level].fraction,minimumFraction)}, variants=new Set(catalog.models.filter(model=>model.variantOf).map(model=>model.variantOf)), models = catalog.models.filter(model=>model.rank>=minimumRank&&(fixedModel?model.id===fixedModel:!model.abliterated&&(preferQuantized?!variants.has(model.id):model.automatic!==false))).sort((a,b) => a.rank - b.rank);
  const minimumParameters=models[0]?.parametersB??0;
  const instances = [], warnings = forceMemory?['Free-memory checks overridden for this attempt; runtime may still reject the load or use system paging.']:[];
  const ram = forceMemory ? hardware.ramGB : Math.min(hardware.ramGB, hardware.freeRamGB);
  const threads = Math.max(1, Math.floor((hardware.physicalCores ?? hardware.cores ?? 1) * policy.threadFraction));
  const candidates = (budget, cpu = false) => models.filter(model => model.minRamGB <= hardware.ramGB && model.memoryGB * MEMORY_FACTOR <= budget &&
    (!cpu || model.parametersB <= (level === 'low' ? Math.max(2,minimumParameters) : level === 'medium' ? Math.max(4,minimumParameters) : Infinity)));
  const add = (gpus, backend, budget, kind, cpu = false) => {
    const fitting = candidates(budget, cpu); const model = fitting.at(-1); if (!model) return;
    const cappedParallel = /^qwen3\.5:/.test(model.id) ? 1 : parallel;
    if (cappedParallel !== parallel) warnings.push(`${model.id}: pinned Ollama limits this architecture to one slot per instance`);
    instances.push({ id: `instance-${instances.length}`, gpus: gpus.map(gpu => gpu.uuid), gpuIndexes: gpus.map(gpu => gpu.index),
      backend, model, candidates: fitting.reverse(), port: basePort + instances.length, parallel: cappedParallel, requestedParallel: parallel,
      mode: kind, memoryBudgetGB: budget, threads, keepAlive: keepAlive ?? policy.keepAlive, batch: policy.batch });
  };
  if (hardware.unifiedMemory) {
    add([], 'metal', Math.max(0, ram - 2) * policy.fraction, 'single');
  } else {
    let selected = hardware.gpus.map((gpu, index) => ({ ...gpu, index: gpu.index ?? index, uuid: gpu.uuid ?? `gpu-${gpu.index ?? index}`, backend: gpuBackend(gpu) }));
    if (Array.isArray(gpuSelection)) {
      const missing = gpuSelection.filter(id => !selected.some(gpu => gpu.uuid === String(id) || String(gpu.index) === String(id)));
      if (missing.length) throw new Error(`Unknown GPU selection: ${missing.join(', ')}`);
      selected = selected.filter(gpu => gpuSelection.some(id => gpu.uuid === String(id) || String(gpu.index) === String(id)));
    } else if (gpuSelection === 'auto') selected = selected.filter(gpu => !gpu.integrated && !/\b(uhd|iris|apu)\b/i.test(gpu.name) && gpu.vramGB >= 2);
    selected = selected.map(gpu => ({ ...gpu, budget: Math.max(0, (forceMemory ? gpu.vramGB : (gpu.freeGB ?? gpu.vramGB)) - 0.75 * parallel -
      (!forceMemory && gpu.freeGB == null && hardware.platform === 'win32' && gpuSelection === 'auto' && gpu.index === displayGpu ? 1.5 : 0)) * policy.fraction }));
    selected.sort((a,b) => b.budget - a.budget || a.uuid.localeCompare(b.uuid));
    if (level === 'low') selected = selected.slice(0,1);
    for (const backend of [...new Set(selected.map(gpu => gpu.backend))]) {
      const group = selected.filter(gpu => gpu.backend === backend);
      const largest = candidates(group.reduce((sum,gpu) => sum + gpu.budget, 0)).at(-1);
      const single = candidates(group[0]?.budget ?? 0).at(-1);
      if (group.length > 1 && largest && mode !== 'replicate' && (mode === 'split' || largest.rank > (single?.rank ?? 0))) {
        const chosen = []; let budget = 0;
        for (const gpu of group) { chosen.push(gpu); budget += gpu.budget; if (mode !== 'split' && budget >= largest.memoryGB * MEMORY_FACTOR) break; }
        add(chosen, backend, budget, 'split');
        for (const gpu of group.filter(gpu => !chosen.includes(gpu))) add([gpu], backend, gpu.budget, 'single');
      } else for (const gpu of group) add([gpu], backend, gpu.budget, 'single');
    }
    if (!instances.length && (gpuSelection === 'auto' || gpuSelection === 'all' || gpuSelection.length === 0)) {
      add([], 'cpu', Math.max(0, ram - 1) * policy.fraction, 'cpu', true);
    }
  }
  return { level, mode, gpuSelection, instances, warnings: [...new Set(warnings)],
    reason: instances.length ? `${instances.length} runtime instance${instances.length === 1 ? '' : 's'}: ${instances.map(instance => `${instance.model.id} (${instance.mode}, ${instance.gpus.length || 'CPU/unified'} devices)`).join('; ')}`
      : `No model fits current budgets: ${ram.toFixed(1)} GB ${forceMemory?'total':'free'} RAM.${minimumRank>1?' Desktop minimum is '+minimumParameters+'B.':''} ${forceMemory?'Runtime capacity or the desktop minimum prevents placement.':'Free memory or lower parallelism.'}` };
}
