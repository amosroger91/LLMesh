import test from 'node:test';
import assert from 'node:assert/strict';
import { EnergyMeter } from '../src/energy.js';
test('energy integrates watts over elapsed time with rate changes and no idle charge', () => {
  let now = 0; const meter = new EnergyMeter(':memory:', async () => ({ gpuWatts: null, source: 'estimate' }), () => now);
  try {
    meter.configure({ rate: 0.2, estimatedWatts: 1000 }); meter.start('qwen');
    now = 1800000; meter.configure({ rate: 0.4 }); now = 3600000; meter.stop();
    let status = meter.status(); assert.equal(status.totals[0].kwh, 1); assert.ok(Math.abs(status.totals[0].cost - 0.3) < 1e-10);
    now += 3600000; meter.stop(); status = meter.status(); assert.equal(status.totals[0].kwh, 1);
    assert.throws(() => meter.configure({ rate: -1 })); assert.throws(() => meter.configure({ wallWatts: NaN }));
  } finally { meter.close(); }
});
test('wall power override takes precedence over GPU estimates', () => {
  let now = 0; const meter = new EnergyMeter(':memory:', undefined, () => now);
  try {
    meter.power = { gpuWatts: 200, source: 'board + host estimate' }; meter.configure({ wallWatts: 500, rate: 1 });
    meter.start('qwen'); now = 3600000; meter.stop();
    assert.equal(meter.status().totals[0].kwh, 0.5); assert.equal(meter.status().totals[0].cost, 0.5);
    assert.equal(meter.status().method, 'user wall-power override');
  } finally { meter.close(); }
});
