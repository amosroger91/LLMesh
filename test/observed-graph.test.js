import test from 'node:test';import assert from 'node:assert/strict';import {ObservedGraph} from '../src/browser/observed-graph.js';
test('awake graph shows actual provider branches and pulses only after observed counter changes',()=>{
 const graph=new ObservedGraph(),desktop={id:'desktop',kind:'desktop',providers:[{id:'provider-0',name:'Groq',traffic:{requests:5,responses:10}}]},phone={id:'phone',kind:'browser',connected:true,gatewayId:'desktop',traffic:{requests:1,responses:20}},stranger={id:'other',kind:'browser'};
 let scene=graph.update([desktop,phone,stranger],1000);assert.equal(scene.edges.length,2);assert.equal(scene.pulses.length,0);assert.equal(scene.nodes.filter(node=>node.kind==='provider').length,1);assert.equal(scene.edges.some(edge=>edge.to==='other'),false);
 desktop.providers[0].traffic.requests++;phone.traffic.responses+=3;scene=graph.update([desktop,phone,stranger],2000);assert.equal(scene.pulses.length,2);assert.equal(scene.pulses.find(pulse=>pulse.direction==='response').count,3);assert.equal(scene.pulses.find(pulse=>pulse.direction==='response').from,'phone');
 assert.equal(graph.update([desktop,phone,stranger],4000).pulses.length,0);desktop.providers[0].traffic.requests=0;assert.equal(graph.update([desktop,phone,stranger],5000).pulses.length,0,'Counter resets do not invent traffic');
});
