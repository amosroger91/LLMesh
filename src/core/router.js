import { catalog } from './catalog.js';
import { quoteWork } from './pricing.js';
export const AUTO_MODEL = 'llmesh-auto';
const tiers = { simple: 1, standard: 3, complex: 5 };

// A bounded, local heuristic avoids an extra model call on the streaming path.
export function assessComplexity(messages, override = 'auto', maxTokens = 512) {
  if (!['auto', ...Object.keys(tiers)].includes(override)) throw new Error('Unknown complexity level');
  const text = messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
  let score = 0; const reasons = [];
  const cue = (pattern, points, description) => { if (pattern.test(text)) { score += points; reasons.push(description); } };
  cue(/\b(prove|formal proof|theorem|mathematical derivation)\b/i, 4, 'Formal reasoning');
  cue(/\b(architect|architecture|distributed|concurrency|security audit|threat model)\b/i, 2, 'System design');
  cue(/\b(implement|optimi[sz]e|debug|refactor|algorithm|write.{0,30}(function|code|program)|sql query)\b/i, 2, 'Programming task');
  cue(/\b(analy[sz]e|trade.?offs?|compare.{0,60}(approach|design)|step.by.step|multi.step)\b/i, 2, 'Analysis or multiple reasoning steps');
  if (text.length > 2000) { score += 2; reasons.push('Long input'); }
  if ((text.match(/```/g) ?? []).length >= 2 && text.length > 1000) { score += 2; reasons.push('Substantial code context'); }
  if ((text.match(/^\s*\d+[.)]\s/gm) ?? []).length >= 3) { score += 2; reasons.push('Several requested steps'); }
  if (messages.length > 10) { score += 1; reasons.push('Long conversation'); }
  if (maxTokens >= 1024) { score += 1; reasons.push('Long requested output'); }
  const level = override !== 'auto' ? override : score >= 4 ? 'complex' : score >= 2 || text.length > 300 ? 'standard' : 'simple';
  return { level, minimumRank: tiers[level], source: override === 'auto' ? 'heuristic' : 'user', score,
    reasons: override === 'auto' ? (reasons.length ? reasons : ['Short, direct request']) : ['Complexity selected by caller'] };
}

function estimate(worker, model, maxTokens) {
  const metric = worker.metrics?.[model.id];
  const mode = worker.hardware?.mode ?? 'gpu';
  const cold = worker.loadedModel && worker.loadedModel !== model.id;
  const fallbackFirst = worker.source === 'third-party' ? 250 : (mode === 'cpu' ? 600 + model.parametersB * 350 : 300 + model.parametersB * 35) + (cold ? 2000 : 0);
  const legacy = worker.models.length === 1;
  const first = metric?.firstTokenMs ?? (legacy ? worker.firstTokenMs : undefined) ?? fallbackFirst;
  const speed = metric?.tokensPerSecond ?? (legacy ? worker.tokensPerSecond : undefined) ?? (worker.source==='third-party'?100:Math.max(1, (mode === 'cpu' ? 12 : 90) / Math.sqrt(model.parametersB)));
  const latency = worker.latencyMs ?? 100;
  // First-token latency dominates; longer jobs also account for expected generation time.
  return { firstTokenMs: first + latency, completionMs: first + latency + maxTokens / speed * 1000,
    score: first + latency + maxTokens / speed * 1000 * 0.15,
    basis: metric ? 'observed for this model' : legacy && worker.firstTokenMs != null ? 'legacy worker estimate' : 'hardware/model estimate' };
}

export function planRoute(job, workers, now = Date.now()) {
  const complexity = assessComplexity(job.messages, job.complexity ?? 'auto', job.maxTokens);
  const automatic = !job.model || ['auto', AUTO_MODEL].includes(job.model);
  let options = [];
  const models = [...new Map([...catalog.models,...workers.flatMap(worker=>worker.modelCatalog??[])].map(model=>[model.id,model])).values()];
  for (const worker of workers) {
    if ((['third-party','community'].includes(worker.source)&&job.privacy!=='allow-third-party') || (job.tools?.length && worker.supportsTools === false) || worker.busy !== 0 || !Number.isFinite(worker.seen) || now - worker.seen >= 35000 || worker.seen > now + 60000 ||
        (job.workerKey && job.workerKey !== worker.pubkey)) continue;
    for (const model of models) {
      if (!worker.models.includes(model.id) || (!automatic && job.model !== model.id)) continue;
      if(worker.maxContextTokens!=null&&(job.contextTokens??4096)>worker.maxContextTokens)continue;
      if (worker.source !== 'third-party' && Number.isFinite(worker.hardware?.maxModelRank) && model.rank > worker.hardware.maxModelRank) continue;
      const pricing = quoteWork(model, job.messages, job.maxTokens ?? 512, job.tools, job.contextTokens);
      if(worker.creditBudget!=null&&pricing.reservedCredits>worker.creditBudget)continue;
      for(let slot=0;slot<(worker.free??1);slot++)options.push({ worker, model, pricing, estimate: estimate(worker, model, job.maxTokens ?? 512) });
    }
  }
  let degraded = false;
  if (automatic) {
    const capable = options.filter(option => option.model.rank >= complexity.minimumRank);
    if (capable.length) options = capable;
    else if (job.allowDegraded !== false && options.length) {
      const highest = Math.max(...options.map(option => option.model.rank)); options = options.filter(option => option.model.rank === highest); degraded = true;
    } else {
      const required = catalog.models.find(model => model.rank === complexity.minimumRank);
      throw new Error(`No idle trusted node meets ${complexity.level} complexity. Connect a worker capable of ${required.id} or larger, or retry when a suitable worker is free.`);
    }
  }
  if (!options.length) throw new Error('No available trusted worker for the requested model and payment network');
  // Every model has the same per-token rate. A refundable reservation is not a price penalty.
  for (const option of options) {
    option.estimate.fitPenaltyMs = option.worker.source==='third-party'?0:Math.max(0, option.model.rank - complexity.minimumRank) * 100;
    option.estimate.routingScore = option.estimate.score + option.estimate.fitPenaltyMs - (option.worker.source==='third-party'?150:0);
  }
  options.sort((a, b) => a.estimate.routingScore - b.estimate.routingScore || a.pricing.priceUnits - b.pricing.priceUnits || a.model.rank - b.model.rank || a.worker.pubkey.localeCompare(b.worker.pubkey));
  const best = options[0]; degraded ||= best.model.rank < complexity.minimumRank;
  return { source: best.worker.source??'mesh', privacy:job.privacy??'mesh-only', provider:best.model.provider, upstreamModel:best.model.upstreamModel, model: best.model.id, worker: best.worker.pubkey, instanceId:best.worker.instanceId, wallet: best.worker.wallet, contribution: best.worker.contribution ?? 'low', priceUnits: best.pricing.priceUnits, pricing: best.pricing, complexity, automatic, degraded,
    estimate: best.estimate, eligibleOptions: options.length,
    reason: `${complexity.level} request → ${best.model.id} on ${best.worker.local ? 'your node' : best.worker.pubkey.slice(0, 12) + '…'}; ${Math.round(best.estimate.firstTokenMs)} ms estimated first token (${best.estimate.basis}).` +
      ` 1 credit per input/output token; ${best.pricing.reservedCredits} credits reserved, unused credits returned.` +
      (best.worker.source==='third-party'?' Prompt sent to a donated third-party API with your permission.':best.worker.source==='community'?' Prompt sent to a public community browser with your permission.':'') +
      (degraded ? ' Selected model is below the recommended capability tier.' : '') };
}
