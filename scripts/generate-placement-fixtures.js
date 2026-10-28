// Explicit maintainer operation: review output diffs before updating the contract.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { planPlacement } from '../src/core/placement.js';

const directory = new URL('../test/fixtures/hardware/', import.meta.url);
const cases = [];
for (const file of readdirSync(directory).filter(name => name.endsWith('.json'))) {
  const hardware = JSON.parse(readFileSync(new URL(file, directory)));
  for (const level of ['low', 'medium', 'high']) {
    for (const mode of ['auto', 'split', 'replicate']) {
      const options = { level, mode };
      cases.push({ name: `${file}/${level}/${mode}`, hardware, options, expected: planPlacement(hardware, options) });
    }
  }
}
const hardware = JSON.parse(readFileSync(new URL('mixed-size.json', directory)));
for (const options of [{gpuSelection:['GPU-1'],level:'high'}, {gpuSelection:[]}, {parallel:4}, {parallel:0}, {gpuSelection:['missing']}, {mode:'bad'}, {level:'bad'}]) {
  const item = {name:'options/'+JSON.stringify(options),hardware,options};
  try {item.expected=planPlacement(hardware,options);} catch {item.error=true;}
  cases.push(item);
}
const windows = {...hardware,platform:'win32'};
cases.push({name:'windows-display-reserve',hardware:windows,options:{level:'medium'},expected:planPlacement(windows,{level:'medium'})});
writeFileSync(new URL('../fixtures/placement.json', import.meta.url),JSON.stringify(cases,null,2)+'\n');
