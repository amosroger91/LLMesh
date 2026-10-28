import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Service } from '../src/service.js';
import { generateSecretKey } from '../src/identity.js';
import { startApi } from '../src/api.js';
test('status excludes the API secret and query parameters do not break routes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmesh-api-security-'));
  const service = new Service({ directory, secret: generateSecretKey(), network: false, ollama: { close() {} } });
  const api = await startApi(service, { port: 0 });
  try {
    assert.equal(service.status().apiKey, undefined);
    const response = await fetch(service.apiUrl + '/v1/models?refresh=true', { headers: { Authorization: 'Bearer ' + service.apiKey } });
    assert.equal(response.status, 200);
  } finally { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await service.close(); rmSync(directory, { recursive: true, force: true }); }
});
