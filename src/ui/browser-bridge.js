import {Peer} from 'peerjs';
import QRCode from 'qrcode';
import {ephemeralKey,publicKey,secureChannel,sendData} from '../browser/secure-channel.js';
import {renderNetwork} from '../browser/network-map.js';

export function browserBridge(api){
  const sessions=new Map();let peer,key,certificate,pair;
  const note=value=>{document.getElementById('pair-note').textContent=value;};
  api.onBrowserSend(({deviceId,message})=>{void sessions.get(deviceId)?.channel.send(message).catch(()=>{sessions.get(deviceId)?.connection.close();});});
  async function createPeer(){
    key=await ephemeralKey();peer=new Peer();
    peer.on('error',error=>note(error.message));
    peer.on('connection',connection=>{
      let channel,deviceId,approved=false,serial=Promise.resolve();const deadline=setTimeout(()=>{if(!approved)connection.close();},120000);
      connection.on('data',data=>{serial=serial.then(async()=>{
        if(!channel){if(data?.type!=='join'||data.nonce!==pair?.nonce||Date.now()>pair.expires)throw new Error('Invalid pairing request');
          const sessionPair={...pair};
          const name=String(data.name??'Browser device').slice(0,60),pub=data.publicKey;
          deviceId=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(pub))))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
          channel=await secureChannel(key,pub,sessionPair.nonce,body=>sendData(connection,body));
          const row=document.createElement('div');row.className='session';const label=document.createElement('span');label.textContent=`${name} · ${deviceId.slice(0,12)}`;
          const approve=document.createElement('button');approve.textContent='Approve device';const deny=document.createElement('button');deny.textContent='Deny';deny.className='secondary';
          approve.onclick=async()=>{try{const account=await api.browserApprove({deviceId,name,nonce:sessionPair.nonce});approved=true;clearTimeout(deadline);sessions.set(deviceId,{channel,connection});await channel.send({type:'approved',...account});row.remove();note('Linked. Worker earnings go to this desktop account. Generate another QR to add a device.');}catch(error){note(error.message);connection.close();row.remove();}};
          deny.onclick=()=>{row.remove();connection.close();};row.append(label,approve,deny);document.getElementById('pair-pending').append(row);await channel.send({type:'pending'});return;
        }
        if(!approved)throw new Error('Approve the device first');
        await api.browserReport(deviceId,await channel.receive(data));
      }).catch(error=>{note(error.message);connection.close();});});
      connection.on('close',()=>{clearTimeout(deadline);if(approved){sessions.delete(deviceId);void api.browserRemove(deviceId);}});
      connection.on('error',()=>connection.close());
    });
    await new Promise((resolve,reject)=>{peer.once('open',resolve);peer.once('error',reject);setTimeout(()=>reject(new Error('Signaling unavailable; retry QR setup')),15000);});
  }
  document.getElementById('pair-create').onclick=async()=>{try{note('Connecting to peer signaling…');if(!peer||peer.destroyed)await createPeer();
    certificate=await api.browserPair({peerId:peer.id,publicKey:await publicKey(key)});pair=JSON.parse(certificate.content);
    const encoded=btoa(unescape(encodeURIComponent(JSON.stringify(certificate)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
    const url='https://amosroger91.github.io/LLMesh/#pair='+encoded;
    document.getElementById('pair-qr').src=await QRCode.toDataURL(url,{width:340,margin:2,errorCorrectionLevel:'L'});
    document.getElementById('pair-qr').hidden=false;note('Scan from the web app or your phone camera. Expires in two minutes; approve the device below.');
  }catch(error){note(error.message);}};
  const refresh=()=>{void api.status().then(state=>{const topology=state.topology;renderNetwork(document.getElementById('network-map'),topology);
    document.getElementById('network-count').textContent=topology.nodes.length+' devices online';
    const list=document.getElementById('linked-devices');list.replaceChildren();for(const device of state.browserDevices){const row=document.createElement('div');row.className='session';const label=document.createElement('span');label.textContent=`${device.name} · ${device.state} · ${device.engineModel||'No model loaded'}`;const remove=document.createElement('button');remove.className='secondary';remove.textContent='Revoke';remove.onclick=()=>api.browserRemove(device.deviceId);row.append(label,remove);list.append(row);}
    for(const session of sessions.values())void session.channel.send({type:'network',topology}).catch(()=>session.connection.close());
  }).catch(error=>note(error.message));};
  refresh();setInterval(refresh,3000);
}
