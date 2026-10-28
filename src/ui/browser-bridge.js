import {servingTopology} from '../browser/serving-topology.js';
import {profileEditor} from '../browser/profile-editor.js';
import {RelayPeer} from '../browser/relay-peer.js';
import {Presence} from '../browser/presence.js';
import {Peer} from 'peerjs';
import QRCode from 'qrcode';
import {ephemeralKey,publicKey,secureChannel,sendData,reassemble} from '../browser/secure-channel.js';
import {mountAliveMap} from '../browser/alive-map.js';

export function browserBridge(api){
  const sessions=new Map(),providerIds=new Map();const providerId=provider=>{if(!providerIds.has(provider.providerId))providerIds.set(provider.providerId,'provider-'+crypto.randomUUID());return providerIds.get(provider.providerId);};let peer,key,certificate,pair,presence,starting,providerNodes=[],profile={name:'Desktop node'},profileReady=false,serving=false,memoryBlocked=false,busy=false,disabled=false;const guestNonce=Array.from(crypto.getRandomValues(new Uint8Array(32))).map(n=>n.toString(16).padStart(2,'0')).join('');
  const note=value=>{document.getElementById('pair-note').textContent=value;};
  api.onBrowserSend(({deviceId,message})=>{void sessions.get(deviceId)?.channel.send(message).catch(()=>{sessions.get(deviceId)?.connection.close();});});
  const relay=new RelayPeer();relay.on('connection',accept);
  function accept(connection){
      let channel,deviceId,approved=false,serial=Promise.resolve();const assemble=reassemble(),deadline=setTimeout(()=>{if(!approved)connection.close();},120000);
      connection.on('data',data=>{serial=serial.then(async()=>{
        data=assemble(data);if(data===null)return;
        if(!channel){const guest=data?.nonce===guestNonce;if(connection.transport==='encrypted-relay'&&!guest)throw new Error('Relay supports guest donation only');if(data?.type!=='join'||(!guest&&(data.nonce!==pair?.nonce||Date.now()>pair.expires)))throw new Error('Invalid pairing request');
          const sessionPair=guest?{nonce:guestNonce}:{...pair};
          const name=String(data.name??'Browser device').slice(0,60),pub=data.publicKey;
          deviceId=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(pub))))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
          channel=await secureChannel(key,pub,sessionPair.nonce,body=>sendData(connection,body));
          if(guest){await api.browserGuest({deviceId,name});approved=true;clearTimeout(deadline);sessions.set(deviceId,{channel,connection});await channel.send({type:'approved',scope:'donation-only',discoveryId:presence?.id});return;}
          const row=document.createElement('div');row.className='session';const label=document.createElement('span');label.textContent=`${name} · ${deviceId.slice(0,12)}`;
          const approve=document.createElement('button');approve.textContent='Approve device';const deny=document.createElement('button');deny.textContent='Deny';deny.className='secondary';
          approve.onclick=async()=>{try{const account=await api.browserApprove({deviceId,name,nonce:sessionPair.nonce,harvest:data.harvest!==false});approved=true;clearTimeout(deadline);sessions.set(deviceId,{channel,connection});await channel.send({type:'approved',...account,discoveryId:presence?.id});row.remove();note('Linked. Worker earnings go to this desktop account. Generate another QR to add a device.');}catch(error){note(error.message);connection.close();row.remove();}};
          deny.onclick=()=>{row.remove();connection.close();};row.append(label,approve,deny);document.getElementById('pair-pending').append(row);await channel.send({type:'pending'});return;
        }
        if(!approved)throw new Error('Approve the device first');
        await api.browserReport(deviceId,await channel.receive(data));
      }).catch(error=>{note(error.message);connection.close();});});
      connection.on('close',()=>{clearTimeout(deadline);if(approved){sessions.delete(deviceId);void api.browserRemove(deviceId);}});
      connection.on('error',()=>connection.close());
  }
  async function createPeer(){
    key??=await ephemeralKey();peer=new Peer();peer.on('error',error=>note(error.message));peer.on('connection',accept);peer.on('disconnected',()=>{if(!peer.destroyed)peer.reconnect();});
    await new Promise((resolve,reject)=>{peer.once('open',resolve);peer.once('error',reject);setTimeout(()=>reject(new Error('Signaling unavailable; retry QR setup')),15000);});
  }
  let discovered=[],latestTopology={nodes:[],edges:[]};
  const legend='Green: ready · Yellow: working · Blue: API · Red: unavailable';
  const knownMap=mountAliveMap(document.getElementById('network-map'),graph=>{
    const topology=latestTopology,self=topology.nodes?.find(node=>node.kind==='desktop');
    const sessions=(topology.nodes??[]).filter(node=>node.kind!=='provider').map(node=>node.id===self?.id?{...node,providers:providerNodes}:{...node,connected:node.connected!==false,gatewayId:self?.id});
    const scene=graph.update(sessions);
    if(self)for(const node of scene.nodes)if(node.kind!=='provider'&&node.id!==self.id&&!scene.edges.some(edge=>edge.to===node.id))scene.edges.push({from:self.id,to:node.id});
    const base=scene.nodes.filter(node=>node.kind!=='provider');
    return {scene,caption:{kicker:'THE PEOPLE’S COMPUTE',title:'LLMesh',legend,status:self?.busy?'WORKING':self?.ready?'THIS NODE IS READY':'WAITING FOR THIS NODE',detail:`${base.length} contributing devices · ${scene.visitors} visitors · ${self?.model||'No model loaded'}`,notes:['Observed traffic counters · no simulated activity']}};
  });
  const publicMap=mountAliveMap(document.getElementById('public-network-map'),graph=>{
    const scene=graph.update(discovered);
    const base=scene.nodes.filter(node=>node.kind!=='provider');
    return {scene,caption:{kicker:'PUBLIC DISCOVERY',title:'LLMesh',legend,status:`${base.length} contributing devices`,detail:`${scene.visitors} visitors · discovery is not trust`,notes:['Observed traffic counters · no simulated activity']}};
  });
  document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{knownMap.frame();publicMap.frame();}));
  starting=createPeer();void starting.catch(error=>note('Direct signaling unavailable; using encrypted relay: '+error.message)).then(async()=>{const gateway={peerId:peer?.id??'relay-only',relay:relay.id,publicKey:await publicKey(key),nonce:guestNonce};presence=new Presence(()=>({kind:'desktop',name:profile.name,profile,ready:serving,memoryBlocked,busy,disabled,gateway,providers:providerNodes}),nodes=>{discovered=nodes;const active=servingTopology({nodes});document.getElementById('public-network-count').textContent=active.nodes.length+' contributing devices · '+active.visitors+' visitors';publicMap.frame();});}).catch(error=>{note('Public discovery unavailable: '+error.message);document.getElementById('public-network-count').textContent='Discovery unavailable · '+error.message;});
  window.addEventListener('pagehide',()=>{knownMap.stop();publicMap.stop();presence?.close();peer?.destroy();relay.destroy();});
  document.getElementById('pair-create').onclick=async()=>{try{note('Connecting to peer signaling…');await starting;if(!peer||peer.destroyed)await createPeer();
    certificate=await api.browserPair({peerId:peer.id,publicKey:await publicKey(key)});pair=JSON.parse(certificate.content);
    const encoded=btoa(unescape(encodeURIComponent(JSON.stringify(certificate)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
    const url='https://amosroger91.github.io/LLMesh/#pair='+encoded;
    document.getElementById('pair-qr').src=await QRCode.toDataURL(url,{width:340,margin:2,errorCorrectionLevel:'L'});
    document.getElementById('pair-qr').hidden=false;note('Scan from the web app or your phone camera. Expires in two minutes; approve the device below.');
  }catch(error){note(error.message);}};
  const refresh=()=>{void api.status().then(state=>{if(!profileReady){profile=state.nodeProfile;profileEditor(document.getElementById('desktop-node-profile'),profile,async value=>{profile=await api.nodeProfile(value);presence?.changed();});profileReady=true;}const topology=state.topology;latestTopology=topology??latestTopology;const self=topology.nodes[0],ready=self?.ready===true,blocked=self?.memoryBlocked===true,working=self?.busy===true,paused=self?.disabled===true;if(ready!==serving||blocked!==memoryBlocked||working!==busy||paused!==disabled){serving=ready;memoryBlocked=blocked;busy=working;disabled=paused;presence?.changed();}const next=(state.donations??[]).map(provider=>({id:providerId(provider),name:provider.provider,model:provider.upstreamModel.slice(0,100),busy:Boolean(provider.busy),state:provider.state,traffic:{requests:provider.metrics.requestsSent??0,responses:provider.metrics.responseChunks??0}}));if(JSON.stringify(next)!==JSON.stringify(providerNodes)){providerNodes=next;presence?.changed();}knownMap.frame();
    document.getElementById('network-count').textContent=servingTopology(topology).nodes.filter(node=>node.kind!=='provider').length+' contributing devices · '+servingTopology(topology).visitors+' visitors · '+state.browserDevices.filter(device=>device.free>0).length+' ready browser workers';
    const list=document.getElementById('linked-devices');list.replaceChildren();for(const device of state.browserDevices){const row=document.createElement('div');row.className='session';const label=document.createElement('span');label.textContent=`${device.name} · ${device.community?'Guest donation':device.harvest?'Linked harvesting':'Trusted donation'} · ${device.busy?'working':device.state} · ${device.engineModel||'No model loaded'}`;const remove=document.createElement('button');remove.className='secondary';remove.textContent='Revoke';remove.onclick=()=>api.browserRemove(device.deviceId);row.append(label,remove);list.append(row);}
    for(const session of sessions.values())void session.channel.send({type:'network',topology}).catch(()=>session.connection.close());
  }).catch(error=>note(error.message));};
  refresh();setInterval(refresh,3000);
}
