import { planPlacement } from './placement.js';
import { CONTRIBUTION } from './catalog.js';
export { CONTRIBUTION } from './catalog.js';
export function chooseContribution(hardware, level = 'medium', options = {}) {
  const placement = planPlacement(hardware, { ...options, level }); const first = placement.instances[0];
  return { ...CONTRIBUTION[level], level, placement, model: first?.model ?? null, candidates: first?.candidates ?? [],
    mode: first?.backend === 'cpu' ? 'cpu' : hardware.unifiedMemory ? 'unified' : 'gpu', threads: first?.threads ?? 1,
    reward: first ? 1 : null, memoryBudgetGB: first?.memoryBudgetGB ?? 0,
    availableMemoryGB: first?.memoryBudgetGB ?? 0, reason: placement.reason };
}
