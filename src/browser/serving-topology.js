// Presence is discovery, not proof that a device is accepting inference.
export function isServing(node){
  if(node.connected===false)return false;
  if(node.kind==='provider')return node.state==='ready'||node.busy===true;
  return node.ready===true;
}
export function servingTopology(topology){
  const all=topology.nodes??[],nodes=all.filter(isServing),ids=new Set(nodes.map(node=>node.id));
  return {...topology,nodes,edges:(topology.edges??[]).filter(edge=>ids.has(edge.from)&&ids.has(edge.to)),visitors:all.filter(node=>node.kind!=='provider'&&!isServing(node)).length};
}
