import { planPlacement } from './placement.js';
import { CONTRIBUTION } from './catalog.js';
import { creditAtomsPerToken, CREDIT_SCALE } from './pricing.js';
export { CONTRIBUTION } from './catalog.js';
function discreteGpu(hardware) {
  return (hardware.gpus ?? []).some(gpu => !gpu.integrated && !/\b(uhd|iris|apu)\b/i.test(gpu.name ?? '') && Number(gpu.vramGB) >= 2);
}
export function chooseContribution(hardware, level = 'medium', options = {}) {
  let placement = planPlacement(hardware, { ...options, level });
  if (!placement.instances.some(instance => instance.gpus?.length) && options.minimumRank > 1 && discreteGpu(hardware)) {
    const relaxed = planPlacement(hardware, { ...options, level, minimumRank: 1 });
    const gpuInstances = relaxed.instances.filter(instance => instance.gpus?.length);
    if (gpuInstances.length) {
      const served = gpuInstances.map(instance => instance.model.id).join(', ');
      placement = { ...relaxed, instances: gpuInstances, warnings: [...new Set([...relaxed.warnings, `Desktop minimum does not fit this GPU. Serving ${served} so a smaller card can still work.`])],
        reason: `${gpuInstances.length} runtime instance${gpuInstances.length === 1 ? '' : 's'}: ${gpuInstances.map(instance => `${instance.model.id} (${instance.mode}, ${instance.gpus.length} devices)`).join('; ')}. Desktop minimum does not fit this GPU; serving a smaller model.` };
    }
  }
  const first = placement.instances[0];
  return { ...CONTRIBUTION[level], keepAlive:options.keepAlive??CONTRIBUTION[level].keepAlive, level, placement, model: first?.model ?? null, candidates: first?.candidates ?? [],
    mode: first?.backend === 'cpu' ? 'cpu' : hardware.unifiedMemory ? 'unified' : 'gpu', threads: first?.threads ?? 1,
    reward: first ? creditAtomsPerToken(first.model) / CREDIT_SCALE : null, memoryBudgetGB: first?.memoryBudgetGB ?? 0,
    availableMemoryGB: first?.memoryBudgetGB ?? 0, reason: placement.reason };
}
