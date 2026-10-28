import test from 'node:test';
import assert from 'node:assert/strict';
import {servingTopology,deviceStatus} from '../src/browser/serving-topology.js';
import {memoryFailure} from '../src/shared/memory-status.js';
import {ObservedGraph} from '../src/browser/observed-graph.js';
test('maps show connected serving nodes, retain busy workers, and count visitors separately',()=>{
 const desktop={id:'desktop',kind:'desktop',ready:true,providers:[{id:'api',state:'ready'},{id:'paused-api',state:'cooldown'}]};
 const phone={id:'phone',kind:'browser',ready:true,connected:true,busy:true,gatewayId:'desktop'};
 const visitors=[{id:'offline',kind:'browser',ready:true,connected:false},{id:'paused',kind:'browser',ready:false,connected:true},{id:'loading',kind:'desktop',ready:false}];
 const nodes=[desktop,phone,...visitors],scene=new ObservedGraph().update(nodes);
 assert.deepEqual(scene.nodes.map(node=>node.id),['desktop','phone','desktop:api']);assert.equal(scene.visitors,3);assert.equal(scene.edges.length,2);
 const filtered=servingTopology({nodes,edges:[{from:'desktop',to:'phone'},{from:'desktop',to:'offline'}]});assert.equal(filtered.edges.length,1);
 phone.connected=false;const disconnected=new ObservedGraph().update(nodes);assert.equal(disconnected.nodes.some(node=>node.id==='phone'),false);assert.equal(disconnected.visitors,4);
});
test('real memory diagnostics show red only for connected devices; ready is yellow and working is green',()=>{
 assert.equal(memoryFailure('No model fits current budgets: 2 GB free RAM'),true);assert.equal(memoryFailure('connection timeout'),false);
 const blocked={id:'low-ram',kind:'desktop',connected:true,ready:false,memoryBlocked:true};
 assert.equal(servingTopology({nodes:[blocked]}).nodes.length,1);assert.equal(servingTopology({nodes:[{...blocked,connected:false}]}).nodes.length,0);
 assert.deepEqual(deviceStatus(blocked),{label:'Not enough memory',color:'#ff646e'});
 assert.equal(deviceStatus({ready:true}).color,'#f5cc55');assert.equal(deviceStatus({ready:true,busy:true}).color,'#65df85');
});
