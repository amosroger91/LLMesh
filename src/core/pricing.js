export const STARTER_CREDITS = 100000;
export const BILLING_VERSION = 'token-usage-v1';
export const MAX_RESERVED_CREDITS = 32768 + 2048;

// This is a refundable authorization, never the final charge. Ollama's context
// ceiling bounds prompt usage; its output budget bounds generated usage.
export function quoteWork(model, messages = [], maxTokens = 512, tools = [], contextTokens) {
  if (!Number.isFinite(model?.parametersB) || model.parametersB <= 0 || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 2048)
    throw new Error('Cannot quote unknown model or output budget');
  const inputCharacters = JSON.stringify({ messages, tools }).length;
  const context = contextTokens ?? Math.min(32768, Math.max(4096, Math.ceil((inputCharacters / 3 + maxTokens + 512) / 1024) * 1024));
  if (!Number.isInteger(context) || context < 4096 || context > 32768) throw new Error('Invalid context budget');
  const reservedCredits = context + maxTokens;
  return { version: BILLING_VERSION, priceUnits: reservedCredits, reservedCredits, creditsPerToken: 1,
    parametersB: model.parametersB, maxTokens, contextTokens: context, inputCharacters,
    basis: 'Refundable maximum reservation; final credits equal reported input plus generated tokens' };
}
export function usageCredits(promptTokens, outputTokens, reservedCredits = MAX_RESERVED_CREDITS) {
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0 || promptTokens > 32768 ||
      !Number.isSafeInteger(outputTokens) || outputTokens < 0 || outputTokens > 2048 || promptTokens + outputTokens > reservedCredits)
    throw new Error('Invalid or over-budget inference token usage');
  return promptTokens + outputTokens;
}
