import {Presence} from '../browser/presence.js';
import {Peer} from 'peerjs';
import {verifyEvent} from 'nostr-tools/pure';
import jsQR from 'jsqr';
import {ephemeralKey,publicKey,secureChannel,sendData,reassemble} from '../browser/secure-channel.js';
import {renderNetwork} from '../browser/network-map.js';
const $=id=>document.getElementById(id);
let engine,engineModel,peer,connection,channel,approved=false,busy=false,enabled=false,camera,activeJob,harvesting=false,connecting=false,retryAfter=0,presence;
const error=error=>{$('error').textContent=error.message??String(error);};
const activity=value=>{$('activity').textContent=value;};
async function report(message){if(approved&&connection?.open)await channel.send(message);}
async function reportState(){await report({type:'state',state:engine?(enabled&&!document.hidden?'ready':'paused'):'paired',engineModel});}
async function work(message){
  if(message.type==='cancel'){if(activeJob===message.id)await engine?.interruptGenerate();return;}
  if(message.type==='pending'){$('account').textContent='Waiting for approval on your desktop…';return;}
  if(message.type==='approved'){approved=true;connecting=false;harvesting=message.scope==='worker-only';$('account').textContent=harvesting?'Harvesting to desktop account '+message.account.slice(0,16)+'…':'Donating compute · wallet disabled · no credits retained on this browser';await reportState();activity(engine&&enabled?'READY':'PAIRED');return;}
  if(message.type==='network')return;
  if(message.type==='revoked'){approved=false;enabled=false;connection.close();activity('REVOKED');$('account').textContent='Desktop revoked this device. Scan a new QR to reconnect.';return;}
  if(message.type!=='job')return;
  const {job,id}=message;
  if(busy||!engine||!enabled||document.hidden){await report({type:'error',id,error:'Browser worker is not available'});return;}
  if(!Array.isArray(job?.messages)||job.messages.length>256||JSON.stringify(job.messages).length>90000||job.tools?.length||!Number.isInteger(job.maxTokens)||job.maxTokens<1||job.maxTokens>2048){await report({type:'error',id,error:'Unsupported browser inference request'});return;}
  busy=true;activeJob=id;activity('WORKING');$('status').textContent='Serving a request for your mesh…';
  try{let usage,finishReason='stop';
    const stream=await engine.chat.completions.create({messages:job.messages,stream:true,stream_options:{include_usage:true},max_tokens:job.maxTokens,extra_body:{enable_thinking:false}});
    for await(const chunk of stream){const choice=chunk.choices[0];if(choice?.delta.content)await report({type:'delta',id,text:choice.delta.content});if(choice?.finish_reason)finishReason=choice.finish_reason;if(chunk.usage)usage=chunk.usage;}
    if(!usage||!Number.isSafeInteger(usage.prompt_tokens)||!Number.isSafeInteger(usage.completion_tokens))throw new Error('Inference did not provide metered usage');
    await report({type:'done',id,promptTokens:usage.prompt_tokens,tokens:usage.completion_tokens,finishReason});
    $('status').textContent=`Completed ${usage.prompt_tokens+usage.completion_tokens} model tokens. ${harvesting?'Earnings directed to your desktop.':'Compute donated; wallet disabled.'}`;
  }catch(cause){await report({type:'error',id,error:String(cause.message).slice(0,350)}).catch(error);}
  finally{busy=false;activeJob=null;activity(enabled?'READY':'PAUSED');await reportState().catch(error);}
}
async function connect(raw,guest){
  let pairing;
  if(guest){pairing=guest;}else{
  const url=new URL(raw);if(url.protocol!=='https:'||url.origin!==location.origin)throw new Error('Use a pairing link for this web app');
  const encoded=new URLSearchParams(url.hash.slice(1)).get('pair');if(!encoded||encoded.length>16000)throw new Error('Invalid pairing QR');
  const event=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0))));
  if(!verifyEvent(event)||event.kind!==30078||!event.tags.some(tag=>tag[0]==='d'&&tag[1]==='llmesh-worker-pair-v1'))throw new Error('Desktop signature is invalid');
  pairing=JSON.parse(event.content);if(pairing.v!==1||pairing.scope!=='worker-only'||pairing.origin!==location.origin||pairing.account!==event.pubkey||pairing.expires<Date.now()||pairing.expires>Date.now()+125000||!/^[a-f0-9]{64}$/.test(pairing.nonce))throw new Error('Pairing is expired or for another app');
  }
  connecting=true;connection?.close();peer?.destroy();approved=false;
  const local=await ephemeralKey();peer=new Peer();peer.on('error',error);await new Promise((resolve,reject)=>{peer.once('open',resolve);peer.once('error',reject);setTimeout(()=>reject(new Error('Peer signaling timed out')),15000);});
  const exported=await publicKey(local);
  connection=peer.connect(pairing.peerId,{reliable:true,serialization:'json'});
  channel=await secureChannel(local,pairing.publicKey,pairing.nonce,body=>sendData(connection,body));
  const assemble=reassemble();let inbound=Promise.resolve();connection.on('data',frame=>{inbound=inbound.then(()=>{const whole=assemble(frame);return whole===null?null:channel.receive(whole);}).then(message=>{if(message===null)return;if(message.type==='job'){void work(message).catch(error);return;}return work(message);}).catch(cause=>{error(cause);connection.close();});});
  const current=connection;setTimeout(()=>{if(connection===current&&!approved){current.close();connecting=false;retryAfter=Date.now()+15000;}},20000);connection.on('close',()=>{if(connection!==current)return;approved=false;connecting=false;retryAfter=Date.now()+10000;activity('WAITING FOR GATEWAY');$('account').textContent=harvesting?'Desktop disconnected. Scan a new QR.':'Wallet disabled · looking for a community gateway';void engine?.interruptGenerate();});connection.on('error',error);
  connection.on('open',()=>{connection.send({type:'join',nonce:pairing.nonce,publicKey:exported,name:'Web · '+(navigator.userAgentData?.platform??navigator.platform)});});
  $('account').textContent=guest?'Connecting to a community gateway…':'Connecting securely to your desktop…';$('pair-code').value='';history.replaceState(null,'',location.pathname);
}
$('start').onclick=async()=>{try{$('error').textContent='';$('start').disabled=true;activity('LOADING');
  if(!navigator.gpu)throw new Error('WebGPU is unavailable. Use a supported browser with hardware acceleration enabled.');
  const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw new Error('No WebGPU adapter is available');
  if(!engine){const {CreateMLCEngine}=await import('@mlc-ai/web-llm');engineModel=adapter.features.has('shader-f16')?'Qwen3.5-0.8B-q4f16_1-MLC':'Qwen3.5-0.8B-q4f32_1-MLC';
    engine=await CreateMLCEngine(engineModel,{initProgressCallback:item=>{$('progress').textContent=item.text;$('load').value=item.progress;}},{context_window_size:4096});}
  enabled=true;$('model').textContent='Qwen3.5 · 0.8B';$('backend').textContent=engineModel;$('start').hidden=true;$('stop').hidden=false;activity(approved?'READY':'FINDING GATEWAY');presence?.publish();presence?.refresh();
  $('status').textContent=approved?'Ready to serve requests. Leave this tab open.':'Model ready. Finding a community gateway; no wallet required. Leave this tab open.';await reportState();
 }catch(cause){error(cause);activity('SETUP ERROR');}finally{$('start').disabled=false;}};
$('stop').onclick=async()=>{enabled=false;$('start').textContent='Resume serving';$('start').hidden=false;$('stop').hidden=true;activity(busy?'FINISHING REQUEST':'PAUSED');await reportState().catch(error);};
$('connect').onclick=()=>{void connect($('pair-code').value.trim()).catch(error);};
function stopCamera(){camera?.getTracks().forEach(track=>track.stop());camera=null;$('camera').hidden=true;$('scan').textContent='Scan desktop QR';}
$('scan').onclick=async()=>{try{if(camera){stopCamera();return;}camera=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});const video=$('camera');video.srcObject=camera;video.hidden=false;await video.play();$('scan').textContent='Stop camera';
 const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
 const scan=()=>{if(!camera)return;if(video.readyState>=2){canvas.width=video.videoWidth;canvas.height=video.videoHeight;context.drawImage(video,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height),code=jsQR(pixels.data,pixels.width,pixels.height);if(code){stopCamera();void connect(code.data).catch(error);return;}}setTimeout(scan,180);};scan();
 }catch(cause){stopCamera();error(cause);}};
document.addEventListener('visibilitychange',()=>{void reportState().catch(error);});
setInterval(()=>{void report({type:'heartbeat'}).catch(error);},5000);
window.addEventListener('pagehide',()=>{stopCamera();presence?.close();connection?.close();peer?.destroy();});
if(location.hash.startsWith('#pair=')){$('harvest').checked=true;$('wallet-link').hidden=false;void connect(location.href).catch(error);}
renderNetwork($('map'),{nodes:[{id:'browser',name:'This browser',kind:'browser'}],edges:[]});

$('harvest').onchange=()=>{$('wallet-link').hidden=!$('harvest').checked;if(!$('harvest').checked){harvesting=false;connection?.close();approved=false;connecting=false;retryAfter=0;presence.refresh();}};
presence=new Presence(()=>({kind:'browser',name:'Web browser',busy,model:engineModel??'',ready:enabled&&!document.hidden}),nodes=>{
 $('online').textContent=String(nodes.length);$('discovery').textContent=nodes.length>1?'Live public discovery · '+nodes.length+' sessions visible':'Discovering devices via public relays…';
 renderNetwork($('map'),{nodes:nodes.map(node=>({...node,kind:node.kind==='desktop'?'peer':'browser'})),edges:[]});
 if(enabled&&!approved&&!connecting&&!$('harvest').checked&&Date.now()>=retryAfter){const gateway=nodes.find(node=>node.kind==='desktop'&&node.gateway)?.gateway;if(gateway){retryAfter=Date.now()+20000;void connect('',gateway).catch(cause=>{connecting=false;retryAfter=Date.now()+20000;error(cause);});}}
});
