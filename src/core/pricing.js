export const STARTER_CREDITS = 100000;
export const CREDIT_SCALE = 2;
export const BILLING_VERSION = 'token-rate-v2';
export const USAGE_DOMAIN = 'llmesh-usage-v2';
export const MAX_CONTEXT_TOKENS = 32768;
export const MAX_OUTPUT_TOKENS = 2048;
export const MAX_ATOMS_PER_TOKEN = 3;
export const MAX_RESERVED_CREDITS = (MAX_CONTEXT_TOKENS + MAX_OUTPUT_TOKENS) * MAX_ATOMS_PER_TOKEN;

// Ledger rows and escrow units are half-credits. One whole credit is one LLMESH.
// 0.8B and browser workers earn 1 unit (0.5 credit) per token.
// 2B, 4B, and 9B, including quantized and abliterated 4B, earn 2 units (1 credit).
// Models above 9B earn 3 units (1.5 credits).
export function isWebWorker(worker) {
  return Boolean(worker) && (worker.source === 'community' || worker.source === 'web' || worker.engine === 'WebLLM' || worker.backend === 'webgpu' || String(worker.instanceId ?? '').startsWith('web-'));
}
export function creditAtomsPerToken(model, worker) {
  if (!Number.isFinite(Number(model?.parametersB)) || Number(model.parametersB) <= 0) throw new Error('Cannot quote unknown model or output budget');
  if (isWebWorker(worker)) return 1;
  const parameters = Number(model.parametersB);
  if (parameters <= 0.8) return 1;
  if (parameters <= 9) return 2;
  return 3;
}
export function formatCredits(atoms) {
  const value = Number(atoms);
  if (!Number.isSafeInteger(value)) return '0';
  const whole = Math.trunc(value / CREDIT_SCALE);
  return value % CREDIT_SCALE ? `${whole}.5` : String(whole);
}

// This is a refundable authorization, never the final charge. Ollama's context
// ceiling bounds prompt usage; its output budget bounds generated usage.
export function quoteWork(model, messages = [], maxTokens = 512, tools = [], contextTokens, worker) {
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_OUTPUT_TOKENS) throw new Error('Cannot quote unknown model or output budget');
  const atomsPerToken = creditAtomsPerToken(model, worker);
  const inputCharacters = JSON.stringify({ messages, tools }).length;
  const context = contextTokens ?? Math.min(MAX_CONTEXT_TOKENS, Math.max(4096, Math.ceil((inputCharacters / 3 + maxTokens + 512) / 1024) * 1024));
  if (!Number.isInteger(context) || context < 4096 || context > MAX_CONTEXT_TOKENS) throw new Error('Invalid context budget');
  const reservedTokens = context + maxTokens;
  const reservedCredits = reservedTokens * atomsPerToken;
  return { version: BILLING_VERSION, priceUnits: reservedCredits, reservedCredits, reservedTokens, atomsPerToken, creditsPerToken: atomsPerToken / CREDIT_SCALE,
    parametersB: model.parametersB, maxTokens, contextTokens: context, inputCharacters,
    basis: 'Refundable maximum reservation; final credits follow the model rate times reported input plus generated tokens' };
}
export function usageCredits(promptTokens, outputTokens, reservedCredits = MAX_RESERVED_CREDITS, atomsPerToken = 1) {
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0 || promptTokens > MAX_CONTEXT_TOKENS ||
      !Number.isSafeInteger(outputTokens) || outputTokens < 0 || outputTokens > MAX_OUTPUT_TOKENS ||
      !Number.isInteger(atomsPerToken) || atomsPerToken < 1 || atomsPerToken > MAX_ATOMS_PER_TOKEN) throw new Error('Invalid or over-budget inference token usage');
  const atoms = (promptTokens + outputTokens) * atomsPerToken;
  if (atoms > reservedCredits) throw new Error('Invalid or over-budget inference token usage');
  return atoms;
}
