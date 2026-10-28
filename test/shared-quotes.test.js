import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quoteWork } from '../src/core/pricing.js';

test('Node pricing agrees with the native/WASM shared fixture contract', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../fixtures/quotes.json', import.meta.url)));
  for (const { name, input, expected, error } of fixtures) {
    const quote = () => quoteWork(input.model, input.messages, input.maxTokens, input.tools);
    if (error) assert.throws(quote, undefined, name);
    else assert.deepEqual(quote(), expected, name);
  }
});
