import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planPlacement} from '../src/core/placement.js';

test('Node placement agrees with shared Rust/WASM fixtures',()=>{
  const cases=JSON.parse(readFileSync(new URL('../fixtures/placement.json',import.meta.url)));
  for(const {name,hardware,options,expected,error} of cases){
    const plan=()=>planPlacement(hardware,options);
    if(error)assert.throws(plan,undefined,name);else assert.deepEqual(plan(),expected,name);
  }
});
