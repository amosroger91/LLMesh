import {catalog} from '../core/catalog.js';
import {publicMetrics} from '../shared/inference-metrics.js';
export function modelCapability(id,claimed){
 const model=catalog.models.find(model=>model.id===id);if(model)return model.rank;
 if(/^Qwen3.5-0.8B-/i.test(id??''))return 1;
 return Number.isInteger(claimed)&&claimed>=1&&claimed<=5?claimed:0;
}
export function nodePerformance(node){
 const instances=node.instances?.length?node.instances:[{model:node.model,metrics:node.metrics,rank:node.rank}];
 return instances.filter(item=>typeof item.model==='string'&&item.model).map(item=>({model:item.model,capability:modelCapability(item.model,item.rank),...publicMetrics(item.metrics??item)}));
}
export function rankNodes(nodes){
 return nodes.map(node=>{const models=nodePerformance(node).sort((a,b)=>b.capability-a.capability||(b.averageTokensPerSecond??b.tokensPerSecond??0)-(a.averageTokensPerSecond??a.tokensPerSecond??0));return {...node,performance:models[0]??{capability:0}};}).sort((a,b)=>b.performance.capability-a.performance.capability||(b.performance.averageTokensPerSecond??b.performance.tokensPerSecond??0)-(a.performance.averageTokensPerSecond??a.performance.tokensPerSecond??0)||a.id.localeCompare(b.id)).map((node,index)=>({...node,speedRank:index+1}));
}
export function performanceLabel(node){const info=node.performance??nodePerformance(node).sort((a,b)=>b.capability-a.capability)[0];const speed=info?.averageTokensPerSecond??info?.tokensPerSecond;return `${node.speedRank?'#'+node.speedRank+' · ':''}${Number.isFinite(speed)?speed.toFixed(1)+' avg tok/s':'Speed unmeasured'} · ${info?.capability?'tier '+info.capability:'tier unknown'}`;}
export function modelInventory(nodes){
 const inventory=new Map(),seen=new Set();
 for(const node of nodes){if(node.connected===false||node.disabled||node.memoryBlocked||!(node.ready||node.busy||node.kind==='provider'&&node.state==='ready'))continue;
  const instances=node.instances?.length?node.instances:[{id:node.id,model:node.model,metrics:node.metrics,rank:node.rank}];
  for(const item of instances){if(item.state&&item.state!=='ready')continue;const key=node.id+':'+(item.id??item.model);if(seen.has(key))continue;seen.add(key);
   const model=node.kind==='browser'&&/^Qwen3.5-0.8B-/i.test(item.model)?'qwen3.5:0.8b':item.model;if(!model)continue;
   const entry=inventory.get(model)??{model,count:0,capability:modelCapability(model,item.rank)};entry.count++;inventory.set(model,entry);
  }
 }
 return [...inventory.values()].sort((a,b)=>b.capability-a.capability||a.model.localeCompare(b.model));
}
export function inventoryLabel(nodes){return modelInventory(nodes).map(item=>`${item.count} × ${item.model}`).join(' · ')||'No loaded models advertised';}
export function renderInventory(container,nodes){if(!container)return;container.replaceChildren();for(const item of modelInventory(nodes)){const row=document.createElement('p');row.textContent=`${item.count} × ${item.model} · capability ${item.capability||'unknown'}`;container.append(row);}if(!container.childNodes.length)container.textContent='No loaded models advertised.';}
