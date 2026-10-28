// Fixed quotes for bounded requests, compatible with the existing 1/2/3-token escrow.
// Contribution labels and worker timing claims never affect the price.
export function quoteWork(model, messages = [], maxTokens = 512, tools = []) {
  if (!Number.isFinite(model?.parametersB) || model.parametersB <= 0 || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 2048)
    throw new Error('Cannot quote unknown model or output budget');
  const modelUnits = model.parametersB <= 2 ? 1 : model.parametersB <= 9 ? 2 : 3;
  const inputCharacters = messages.reduce((sum, message) => sum + message.content.length, 0) + (tools.length ? JSON.stringify(tools).length : 0);
  const priceUnits = Math.min(3, modelUnits + Number(maxTokens > 1024) + Number(inputCharacters > 6000));
  return { version: 'model-budget-v1', priceUnits, parametersB: model.parametersB, maxTokens, inputCharacters,
    basis: 'Fixed completion quote by model size, input characters and reserved output budget; not actual-token metering' };
}
