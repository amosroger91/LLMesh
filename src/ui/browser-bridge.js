import {RelayPeer} from '../browser/relay-peer.js';
import {Presence} from '../browser/presence.js';
import {Peer} from 'peerjs';
import QRCode from 'qrcode';
import {ephemeralKey,publicKey,secureChannel,sendData,reassemble} from '../browser/secure-channel.js';
import {renderNetwork} from '../browser/network-map.js';

export function browserBridge(api){
  const sessions=new Map();let peer,key,certificate,pair,presence,starting;const guestNonce=Array.from(crypto.getRandomValues(new Uint8Array(32))).map(n=>n.toString(16).padStart(2,'0')).join('');
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
          if(guest){await api.browserGuest({deviceId,name});approved=true;clearTimeout(deadline);sessions.set(deviceId,{channel,connection});await channel.send({type:'approved',scope:'donation-only'});return;}
          const row=document.createElement('div');row.className='session';const label=document.createElement('span');label.textContent=`${name} · ${deviceId.slice(0,12)}`;
          const approve=document.createElement('button');approve.textContent='Approve device';const deny=document.createElement('button');deny.textContent='Deny';deny.className='secondary';
          approve.onclick=async()=>{try{const account=await api.browserApprove({deviceId,name,nonce:sessionPair.nonce,harvest:data.harvest!==false});approved=true;clearTimeout(deadline);sessions.set(deviceId,{channel,connection});await channel.send({type:'approved',...account});row.remove();note('Linked. Worker earnings go to this desktop account. Generate another QR to add a device.');}catch(error){note(error.message);connection.close();row.remove();}};
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
  starting=createPeer();void starting.catch(error=>note('Direct signaling unavailable; using encrypted relay: '+error.message)).then(async()=>{const gateway={peerId:peer?.id??'relay-only',relay:relay.id,publicKey:await publicKey(key),nonce:guestNonce};presence=new Presence(()=>({kind:'desktop',name:'Desktop gateway',gateway}),nodes=>{renderNetwork(document.getElementById('public-network-map'),{nodes,edges:[]});document.getElementById('public-network-count').textContent=nodes.length+' public sessions visible · including this desktop';});}).catch(error=>{note('Public discovery unavailable: '+error.message);document.getElementById('public-network-count').textContent='Discovery unavailable · '+error.message;});
  window.addEventListener('pagehide',()=>{presence?.close();peer?.destroy();relay.destroy();});
  document.getElementById('pair-create').onclick=async()=>{try{note('Connecting to peer signaling…');await starting;if(!peer||peer.destroyed)await createPeer();
    certificate=await api.browserPair({peerId:peer.id,publicKey:await publicKey(key)});pair=JSON.parse(certificate.content);
    const encoded=btoa(unescape(encodeURIComponent(JSON.stringify(certificate)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
    const url='https://amosroger91.github.io/LLMesh/#pair='+encoded;
    document.getElementById('pair-qr').src=await QRCode.toDataURL(url,{width:340,margin:2,errorCorrectionLevel:'L'});
    document.getElementById('pair-qr').hidden=false;note('Scan from the web app or your phone camera. Expires in two minutes; approve the device below.');
  }catch(error){note(error.message);}};
  const refresh=()=>{void api.status().then(state=>{const topology=state.topology;renderNetwork(document.getElementById('network-map'),topology);
    document.getElementById('network-count').textContent=topology.nodes.filter(node=>node.kind!=='provider').length+' connected devices · '+state.browserDevices.filter(device=>device.free>0).length+' ready browser workers';
    const list=document.getElementById('linked-devices');list.replaceChildren();for(const device of state.browserDevices){const row=document.createElement('div');row.className='session';const label=document.createElement('span');label.textContent=`${device.name} · ${device.community?'Guest donation':device.harvest?'Linked harvesting':'Trusted donation'} · ${device.busy?'working':device.state} · ${device.engineModel||'No model loaded'}`;const remove=document.createElement('button');remove.className='secondary';remove.textContent='Revoke';remove.onclick=()=>api.browserRemove(device.deviceId);row.append(label,remove);list.append(row);}
    for(const session of sessions.values())void session.channel.send({type:'network',topology}).catch(()=>session.connection.close());
  }).catch(error=>note(error.message));};
  refresh();setInterval(refresh,3000);
}
