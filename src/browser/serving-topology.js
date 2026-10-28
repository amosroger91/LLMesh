// Presence is discovery, not proof that a device is accepting inference.
export function isServing(node){
  if(node.connected===false)return false;
  if(node.kind==='provider')return node.state==='ready'||node.busy===true;
  return node.ready===true;
}
export function deviceStatus(node){
  if(node.busy&&node.connected!==false)return {label:'Serving a request',color:'#65df85'};
  if(node.memoryBlocked===true)return {label:'Not enough memory',color:'#ff646e'};
  return {label:'Ready to serve',color:'#f5cc55'};
}
export function servingTopology(topology){
  const all=topology.nodes??[],visible=node=>isServing(node)||node.connected!==false&&node.memoryBlocked===true,nodes=all.filter(visible),ids=new Set(nodes.map(node=>node.id));
  return {...topology,nodes,edges:(topology.edges??[]).filter(edge=>ids.has(edge.from)&&ids.has(edge.to)),visitors:all.filter(node=>node.kind!=='provider'&&!visible(node)).length};
}
