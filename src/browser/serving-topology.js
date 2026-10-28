// Presence is discovery, not proof that a device is accepting inference.
export function isServing(node){
  if(node.connected===false)return false;
  if(node.kind==='provider')return node.state==='ready'||node.busy===true;
  return node.ready===true;
}
export function deviceStatus(node){
  if(node.connected===false)return {label:'Offline',color:'#ff646e'};
  if(node.busy)return {label:'Serving a request',color:'#f5cc55'};
  if(node.memoryBlocked===true)return {label:'Not enough memory',color:'#ff646e'};
  if(node.disabled===true||['disabled','paused','cooldown','quota','error'].includes(node.state))return {label:'Disabled / unavailable',color:'#ff646e'};
  if(node.kind==='provider')return {label:'External API',color:'#49a8ff'};
  return {label:'Ready to serve',color:'#65df85'};
}
export function servingTopology(topology){
  const all=topology.nodes??[],visible=node=>node.connected!==false&&(isServing(node)||node.memoryBlocked===true||node.disabled===true),nodes=all.filter(visible),ids=new Set(nodes.map(node=>node.id));
  return {...topology,nodes,edges:(topology.edges??[]).filter(edge=>ids.has(edge.from)&&ids.has(edge.to)),visitors:all.filter(node=>node.kind!=='provider'&&!visible(node)).length};
}
