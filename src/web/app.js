import {memoryFailure} from '../shared/memory-status.js';
import {servingTopology} from '../browser/serving-topology.js';
import {nodeProfile as validateProfile} from '../shared/node-profile.js';
import {profileEditor} from '../browser/profile-editor.js';
import {browserInference,probeBrowserTools} from '../browser/tool-inference.js';
import {phoneAlive} from './phone-alive.js';
import {RelayPeer} from '../browser/relay-peer.js';
import {Presence} from '../browser/presence.js';
import {Peer} from 'peerjs';
import {verifyEvent} from 'nostr-tools/pure';
import jsQR from 'jsqr';
import {ephemeralKey,publicKey,secureChannel,sendData,reassemble} from '../browser/secure-channel.js';
import {renderNetwork} from '../browser/network-map.js';
const $=id=>document.getElementById(id);
let nodeProfile;try{nodeProfile=validateProfile(JSON.parse(localStorage.getItem('llmesh.node-profile')??'{}'));}catch{nodeProfile=validateProfile();}
let memoryBlocked=false,engine,engineModel,toolsEnabled=false,peer,connection,channel,approved=false,busy=false,enabled=false,camera,activeJob,harvesting=false,connecting=false,retryAfter=0,presence,relay,visibleNodes=[],connectedGateway;const traffic={requests:0,responses:0};
const error=error=>{$('error').textContent=error.message??String(error);};
const activity=value=>{$('activity').textContent=value;};
async function report(message){if(approved&&connection?.open){await channel.send(message);if(['delta','tool_calls','done','error'].includes(message.type)){traffic.responses++;presence?.changed();}}}
async function reportState(){await report({type:'state',memoryBlocked,state:memoryBlocked?'error':engine?(enabled&&!document.hidden?'ready':'paused'):'paired',engineModel,profile:nodeProfile,supportsTools:toolsEnabled,toolAdapter:'json-schema-v1'});}
async function work(message){
  if(message.type==='cancel'){if(activeJob===message.id)await engine?.interruptGenerate();return;}
  if(message.type==='pending'){$('account').textContent='Waiting for approval on your desktop…';return;}
  if(message.type==='approved'){approved=true;connectedGateway=message.discoveryId??connectedGateway;presence?.changed();connecting=false;harvesting=message.scope==='worker-only';$('account').textContent=harvesting?'Harvesting to desktop account '+message.account.slice(0,16)+'…':(message.scope==='trusted-donation'?'Trusted desktop linked · harvesting disabled · ':'Guest donation · ')+(connection?.transport==='encrypted-relay'?'encrypted relay fallback':'direct WebRTC')+' · wallet disabled';await reportState();activity(engine&&enabled?'READY':'PAIRED');$('status').textContent=engine&&enabled?'Ready · connected to desktop via '+(connection?.transport==='encrypted-relay'?'encrypted relay fallback':'direct WebRTC'):'Connected · download the model to begin serving';return;}
  if(message.type==='network')return;
  if(message.type==='revoked'){approved=false;enabled=false;connection.close();activity('REVOKED');$('account').textContent='Desktop revoked this device. Scan a new QR to reconnect.';return;}
  if(message.type!=='job')return;
  const {job,id}=message;traffic.requests++;presence?.changed();
  if(busy||!engine||!enabled||document.hidden){await reportState();await report({type:'error',id,error:busy?'Phone is already working on another request':!engine?'Phone model is not loaded':!enabled?'Phone serving is paused':'Phone tab is hidden or the screen is locked. Return to the tab and enable Keep phone alive.'});return;}
  if(!Array.isArray(job?.messages)||job.messages.length>256||JSON.stringify({messages:job.messages,tools:job.tools}).length>90000||(job.tools?.length&&!toolsEnabled)||!Number.isInteger(job.maxTokens)||job.maxTokens<1||job.maxTokens>2048){await report({type:'error',id,error:'Unsupported browser inference request'});return;}
  busy=true;presence?.changed();activeJob=id;activity('WORKING');$('status').textContent='Serving a request for your mesh…';
  try{let used=0;
    for await(const part of browserInference(engine,job)){await report({...part,id});if(part.type==='done')used=part.promptTokens+part.tokens;}
    $('status').textContent=`Completed ${used} model tokens. ${harvesting?'Earnings directed to your desktop.':'Compute donated; wallet disabled.'}`;
  }catch(cause){memoryBlocked=memoryFailure(cause.message);await report({type:'error',id,error:String(cause.message).slice(0,350)}).catch(error);}
  finally{busy=false;presence?.changed();activeJob=null;activity(enabled?'READY':'PAUSED');await reportState().catch(error);}
}
async function connect(raw,guest,viaRelay=false){
  let pairing;
  if(guest){pairing=guest;connectedGateway=guest.sessionId;}else{
  const url=new URL(raw);if(url.protocol!=='https:'||url.origin!==location.origin)throw new Error('Use a pairing link for this web app');
  const encoded=new URLSearchParams(url.hash.slice(1)).get('pair');if(!encoded||encoded.length>16000)throw new Error('Invalid pairing QR');
  const event=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0))));
  if(!verifyEvent(event)||event.kind!==30078||!event.tags.some(tag=>tag[0]==='d'&&tag[1]==='llmesh-worker-pair-v1'))throw new Error('Desktop signature is invalid');
  pairing=JSON.parse(event.content);if(pairing.v!==1||pairing.scope!=='worker-only'||pairing.origin!==location.origin||pairing.account!==event.pubkey||pairing.expires<Date.now()||pairing.expires>Date.now()+125000||!/^[a-f0-9]{64}$/.test(pairing.nonce))throw new Error('Pairing is expired or for another app');
  }
  const previous=connection;connection=undefined;previous?.close();peer?.destroy();approved=false;connecting=true;
  const local=await ephemeralKey();
  if(guest&&(viaRelay||pairing.peerId==='relay-only')){if(!pairing.relay)throw new Error('Update desktop to enable encrypted relay fallback');relay??=new RelayPeer();connection=relay.connect(pairing.relay);}
  else{peer=new Peer();peer.on('error',error);try{await new Promise((resolve,reject)=>{peer.once('open',resolve);peer.once('error',reject);setTimeout(()=>reject(new Error('Peer signaling timed out')),10000);});}catch(cause){if(guest?.relay)return connect('',guest,true);throw cause;}connection=peer.connect(pairing.peerId,{reliable:true,serialization:'json'});}
  connection.guest=Boolean(guest);const exported=await publicKey(local);
  channel=await secureChannel(local,pairing.publicKey,pairing.nonce,body=>sendData(connection,body));
  const assemble=reassemble();let inbound=Promise.resolve();connection.on('data',frame=>{inbound=inbound.then(()=>{const whole=assemble(frame);return whole===null?null:channel.receive(whole);}).then(message=>{if(message===null)return;if(message.type==='job'){void work(message).catch(error);return;}return work(message);}).catch(cause=>{error(cause);connection.close();});});
  const current=connection;setTimeout(()=>{if(connection===current&&!approved){current.close();connecting=false;retryAfter=Date.now()+15000;if(guest?.relay&&!viaRelay)void connect('',guest,true).catch(error);}},guest&&!viaRelay?8000:30000);connection.on('close',()=>{if(connection!==current)return;approved=false;connectedGateway=undefined;presence?.changed();connecting=false;retryAfter=Date.now()+10000;activity('WAITING FOR GATEWAY');$('account').textContent=harvesting?'Desktop disconnected. Scan a new QR.':'Wallet disabled · looking for a community gateway';void engine?.interruptGenerate();});connection.on('error',error);
  connection.on('open',()=>{if(connection!==current)return;connection.send({type:'join',nonce:pairing.nonce,publicKey:exported,harvest:$('harvest').checked,name:nodeProfile.name});});
  $('account').textContent=guest?'Connecting to a community gateway…':'Connecting securely to your desktop…';$('pair-code').value='';history.replaceState(null,'',location.pathname);
}
$('start').onclick=async()=>{try{memoryBlocked=false;presence?.changed();$('error').textContent='';$('start').disabled=true;activity('LOADING');
  if(!navigator.gpu)throw new Error('WebGPU is unavailable. Use a supported browser with hardware acceleration enabled.');
  const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw new Error('No WebGPU adapter is available');
  if(!engine){const {CreateMLCEngine}=await import('@mlc-ai/web-llm');engineModel=adapter.features.has('shader-f16')?'Qwen3.5-0.8B-q4f16_1-MLC':'Qwen3.5-0.8B-q4f32_1-MLC';
    engine=await CreateMLCEngine(engineModel,{initProgressCallback:item=>{$('progress').textContent=item.text;$('load').value=item.progress;}},{context_window_size:4096});}
  if(!toolsEnabled){$('progress').textContent='Checking this model’s tool-calling support…';toolsEnabled=await probeBrowserTools(engine);}
  enabled=true;$('model').textContent='Qwen3.5 · 0.8B';$('backend').textContent=engineModel+(toolsEnabled?' · tool self-test passed':' · text only');$('start').hidden=true;$('stop').hidden=false;activity(approved?'READY':'FINDING GATEWAY');presence?.publish();presence?.refresh();
  $('status').textContent=approved?'Ready to serve requests. Leave this tab open.':'Model ready. Finding a community gateway; no wallet required. Leave this tab open.';await reportState();
 }catch(cause){memoryBlocked=memoryFailure(cause.message);presence?.changed();await reportState().catch(error);error(cause);activity(memoryBlocked?'NOT ENOUGH MEMORY':'SETUP ERROR');}finally{$('start').disabled=false;}};
$('stop').onclick=async()=>{enabled=false;presence?.changed();$('start').textContent='Resume serving';$('start').hidden=false;$('stop').hidden=true;activity(busy?'FINISHING REQUEST':'PAUSED');await reportState().catch(error);};
$('connect').onclick=()=>{void connect($('pair-code').value.trim()).catch(error);};
function stopCamera(){camera?.getTracks().forEach(track=>track.stop());camera=null;$('camera').hidden=true;$('scan').textContent='Scan desktop QR';}
$('scan').onclick=async()=>{try{if(camera){stopCamera();return;}camera=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});const video=$('camera');video.srcObject=camera;video.hidden=false;await video.play();$('scan').textContent='Stop camera';
 const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
 const scan=()=>{if(!camera)return;if(video.readyState>=2){canvas.width=video.videoWidth;canvas.height=video.videoHeight;context.drawImage(video,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height),code=jsQR(pixels.data,pixels.width,pixels.height);if(code){stopCamera();void connect(code.data).catch(error);return;}}setTimeout(scan,180);};scan();
 }catch(cause){stopCamera();error(cause);}};
document.addEventListener('visibilitychange',()=>{presence?.changed();void reportState().catch(error);});
setInterval(()=>{void report({type:'heartbeat'}).catch(error);},5000);
window.addEventListener('pagehide',()=>{stopCamera();presence?.close();connection?.close();peer?.destroy();relay?.destroy();});
if(location.hash.startsWith('#pair=')){$('wallet-link').hidden=false;void connect(location.href).catch(error);}
renderNetwork($('map'),{nodes:[],edges:[]});

$('harvest').onchange=()=>{if(approved&&!connection?.guest){harvesting=$('harvest').checked;void report({type:'harvest',enabled:harvesting}).catch(error);$('account').textContent=harvesting?'Harvesting to paired desktop account':'Trusted desktop linked · harvesting disabled';}else if($('harvest').checked){$('account').textContent='Scan your desktop QR and approve this device to harvest there.';}};
presence=new Presence(()=>({kind:'browser',name:nodeProfile.name,profile:nodeProfile,busy,memoryBlocked,disabled:Boolean(engine)&&!enabled,model:engineModel??'',ready:!memoryBlocked&&Boolean(engine)&&enabled&&!document.hidden,connected:approved,gatewayId:approved?connectedGateway:undefined,traffic:{...traffic},transport:connection?.transport??(approved?'webrtc':'none')}),nodes=>{
 visibleNodes=nodes;const active=servingTopology({nodes});$('online').textContent=String(active.nodes.length);$('discovery').textContent=active.visitors+' visitors; ready, working and memory-blocked devices appear on the map';
 renderNetwork($('map'),{nodes:nodes.map(node=>({...node,kind:node.kind==='desktop'?'peer':'browser'})),edges:[]});
 if(enabled&&!approved&&!connecting&&!$('harvest').checked&&Date.now()>=retryAfter){const target=nodes.find(node=>node.kind==='desktop'&&node.gateway),gateway=target?{...target.gateway,sessionId:target.id}:null;if(gateway){retryAfter=Date.now()+20000;void connect('',gateway).catch(cause=>{connecting=false;retryAfter=Date.now()+20000;error(cause);});}}
});

phoneAlive(()=>({selfId:presence?.id,nodes:visibleNodes,busy,connected:approved,enabled,model:engine?'Qwen3.5 · 0.8B':''}));

profileEditor($('web-node-profile'),nodeProfile,async value=>{localStorage.setItem('llmesh.node-profile',JSON.stringify(value));nodeProfile=value;presence.changed();await reportState();});
