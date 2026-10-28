// Topology is advertised by participants. Pulses are changes in measured counters,
// never a timer pretending that requests are happening.
export class ObservedGraph {
  constructor(){this.counters=new Map();this.pulses=[];}
  update(sessions,now=Date.now()){
    const nodes=sessions.slice(0,24).map(node=>({...node})),edges=[];
    const ids=new Set(nodes.map(node=>node.id)),counts=new Map();
    const edge=(from,to,traffic)=>{
      if(!ids.has(from)||!ids.has(to))return;
      edges.push({from,to});
      for(const [direction,count]of [['request',traffic?.requests],['response',traffic?.responses]]){
        if(!Number.isSafeInteger(count)||count<0)continue;
        const key=from+':'+to+':'+direction,previous=this.counters.get(key);counts.set(key,count);
        if(previous!=null&&count>previous)this.pulses.push({from:direction==='request'?from:to,to:direction==='request'?to:from,direction,count:count-previous,started:now});
      }
    };
    for(const session of sessions.slice(0,24)){
      if(session.kind==='desktop'&&Array.isArray(session.providers))for(const provider of session.providers.slice(0,8)){
        const id=session.id+':'+provider.id;nodes.push({...provider,id,kind:'provider',parent:session.id});ids.add(id);edge(session.id,id,provider.traffic);
      }
      if(session.kind==='browser'&&session.connected&&typeof session.gatewayId==='string')edge(session.gatewayId,session.id,session.traffic);
    }
    this.counters=counts;this.pulses=this.pulses.filter(pulse=>now-pulse.started<1400&&ids.has(pulse.from)&&ids.has(pulse.to)).slice(-64);
    return {nodes,edges,pulses:this.pulses};
  }
}
