import test from 'node:test';
import assert from 'node:assert/strict';
import { drawAliveScene } from '../src/browser/alive-map.js';

function context() {
  const calls = [];
  const target = { fillStyle: '', font: '', textAlign: '', lineWidth: 1, strokeStyle: '' };
  return { calls, context: new Proxy(target, {
    get(current, prop) {
      if (prop in current && typeof current[prop] !== 'function') return current[prop];
      return (...args) => calls.push([String(prop), ...args]);
    },
    set(current, prop, value) { current[prop] = value; return true; }
  }) };
}

test('the living map draws the phone scene and a wide desktop scene from the same counters', () => {
  const scene = { nodes: [{ id: 'desktop', kind: 'desktop', name: 'Home', ready: true }, { id: 'desktop:provider-1', kind: 'provider', name: 'Groq', state: 'ready' }], edges: [{ from: 'desktop', to: 'desktop:provider-1' }], pulses: [{ from: 'desktop', to: 'desktop:provider-1', direction: 'request', started: Date.now() }], visitors: 1 };
  const caption = { kicker: 'THE PEOPLE’S COMPUTE', title: 'LLMesh', legend: 'Green: ready', status: 'THIS NODE IS READY', detail: '1 contributing devices', notes: ['Observed traffic counters'] };
  const phone = context();
  drawAliveScene(phone.context, { width: 720, height: 1280, scene, caption });
  assert.equal(phone.calls.some(call => call[0] === 'fillText' && call[1] === 'THE PEOPLE’S COMPUTE' && call[3] === 80), true);
  assert.equal(phone.calls.some(call => call[0] === 'fillText' && call[1] === 'LLMesh' && call[3] === 145), true);
  assert.equal(phone.calls.some(call => call[0] === 'arc' && call[3] === 7), true);
  const desktop = context();
  drawAliveScene(desktop.context, { width: 1100, height: 560, scene, caption });
  assert.equal(desktop.calls.some(call => call[0] === 'fillText' && call[1] === 'LLMesh' && call[3] === 68), true);
  assert.equal(desktop.calls.some(call => call[0] === 'fillText' && String(call[1]).includes('THIS NODE IS READY')), true);
  assert.equal(desktop.calls.some(call => call[0] === 'arc' && call[3] === 7), true);
});
