import {servingTopology} from './serving-topology.js';
const ns='http://www.w3.org/2000/svg';
export function renderNetwork(container,topology){
  container.replaceChildren();const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 900 500');svg.setAttribute('role','img');svg.setAttribute('aria-label','Connected nodes in your known mesh');
  topology=servingTopology(topology??{});const nodes=topology.nodes,positions=new Map();
  nodes.forEach((node,index)=>{const angle=(index-1)/Math.max(1,nodes.length-1)*Math.PI*2;positions.set(node.id,index===0?[450,250]:[450+Math.cos(angle)*320,250+Math.sin(angle)*185]);});
  for(const edge of topology?.edges??[]){const a=positions.get(edge.from),b=positions.get(edge.to);if(!a||!b)continue;const line=document.createElementNS(ns,'line');line.setAttribute('x1',a[0]);line.setAttribute('y1',a[1]);line.setAttribute('x2',b[0]);line.setAttribute('y2',b[1]);line.setAttribute('stroke','#236078');line.setAttribute('stroke-width','2');svg.append(line);}
  for(const node of nodes){const [x,y]=positions.get(node.id),group=document.createElementNS(ns,'g'),circle=document.createElementNS(ns,'circle'),label=document.createElementNS(ns,'text'),detail=document.createElementNS(ns,'text');
    circle.setAttribute('cx',x);circle.setAttribute('cy',y);circle.setAttribute('r',node.kind==='desktop'?30:23);circle.setAttribute('fill',node.busy?'#b9e657':'#00aeef');
    label.setAttribute('x',x);label.setAttribute('y',y+48);label.setAttribute('text-anchor','middle');label.setAttribute('fill','#e5f6ff');label.textContent=node.name;
    detail.setAttribute('x',x);detail.setAttribute('y',y+68);detail.setAttribute('text-anchor','middle');detail.setAttribute('fill','#8babbc');detail.setAttribute('font-size','12');detail.textContent=`${node.busy?'Working':'Idle'} · ${node.model??'No model'}`;
    const profile=node.profile;if(profile){circle.setAttribute('stroke',profile.ringColor);circle.setAttribute('stroke-width','4');label.textContent=profile.name;const title=document.createElementNS(ns,'title');title.textContent=profile.name+(profile.bio?' · '+profile.bio:'');group.append(title);}
    group.append(circle);
    if(profile?.avatar){const id='avatar-'+crypto.randomUUID(),clip=document.createElementNS(ns,'clipPath'),shape=document.createElementNS(ns,'circle'),photo=document.createElementNS(ns,'image');clip.setAttribute('id',id);shape.setAttribute('cx',x);shape.setAttribute('cy',y);shape.setAttribute('r',node.kind==='desktop'?26:19);clip.append(shape);photo.setAttribute('href',profile.avatar);photo.setAttribute('x',x-(node.kind==='desktop'?26:19));photo.setAttribute('y',y-(node.kind==='desktop'?26:19));photo.setAttribute('width',node.kind==='desktop'?52:38);photo.setAttribute('height',node.kind==='desktop'?52:38);photo.setAttribute('clip-path','url(#'+id+')');photo.setAttribute('preserveAspectRatio','xMidYMid slice');group.append(clip,photo);}
    group.append(label,detail);svg.append(group);}
  container.append(svg);
}
