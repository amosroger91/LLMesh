import {ObservedGraph} from '../browser/observed-graph.js';
export function isPhoneDevice(device,coarse){
  return device.userAgentData?.mobile===true||/Android|iPhone|iPad|iPod/i.test(device.userAgent??'')||(/Macintosh/i.test(device.userAgent??'')&&device.maxTouchPoints>1&&coarse);
}

export function phoneAlive(getState){
  const button=document.getElementById('phone-alive');
  if(!isPhoneDevice(navigator,matchMedia('(pointer: coarse)').matches))return;
  button.hidden=false;
  const panel=document.getElementById('phone-theater'),canvas=document.getElementById('phone-canvas'),video=document.getElementById('phone-video'),note=document.getElementById('phone-wake-status');
  const context=canvas.getContext('2d');let active=false,wake,stream,timer,wentFullscreen=false;const graph=new ObservedGraph();
  async function lock(){
    if(!active||document.hidden||wake&&!wake.released)return;
    if(!navigator.wakeLock){note.textContent='Video mode active. This browser cannot confirm a screen wake lock.';return;}
    try{wake=await navigator.wakeLock.request('screen');if(!active){await wake.release();return;}note.textContent='Screen wake lock active · leave this tab visible';wake.addEventListener('release',()=>{if(active)note.textContent='Screen wake lock released by browser · exit and reopen awake mode to retry';});}
    catch{note.textContent='Screen wake lock unavailable · battery saver or browser policy may allow sleep';}
  }
  function draw(){
    const state=getState(),scene=graph.update(state.nodes),w=canvas.width,h=canvas.height,base=scene.nodes.filter(node=>node.kind!=='provider'),providers=scene.nodes.filter(node=>node.kind==='provider'),positions=new Map();
    context.fillStyle='#07131d';context.fillRect(0,0,w,h);context.fillStyle='#b9e657';context.font='20px monospace';context.textAlign='center';context.fillText('THE PEOPLE’S COMPUTE',w/2,80);
    context.fillStyle='#eff8ff';context.font='bold 54px system-ui';context.fillText('LLMesh',w/2,145);
    base.forEach((node,index)=>{const angle=index/Math.max(1,base.length)*Math.PI*2-Math.PI/2;positions.set(node.id,{x:w/2+Math.cos(angle)*220,y:460+Math.sin(angle)*180});});
    providers.forEach((node,index)=>positions.set(node.id,{x:90+(index%4)*180,y:780+Math.floor(index/4)*110}));
    context.lineWidth=2;for(const edge of scene.edges){const a=positions.get(edge.from),b=positions.get(edge.to);if(!a||!b)continue;context.strokeStyle=edge.to.includes(':provider-')?'#715422':'#17465b';context.beginPath();context.moveTo(a.x,a.y);context.lineTo(b.x,b.y);context.stroke();}
    for(const pulse of scene.pulses){const a=positions.get(pulse.from),b=positions.get(pulse.to);if(!a||!b)continue;const fraction=Math.min(1,(Date.now()-pulse.started)/1400);context.fillStyle=pulse.direction==='request'?'#00d4ff':'#b9e657';context.beginPath();context.arc(a.x+(b.x-a.x)*fraction,a.y+(b.y-a.y)*fraction,7,0,Math.PI*2);context.fill();}
    for(const node of scene.nodes){const point=positions.get(node.id);if(!point)continue;const working=node.id===state.selfId?state.busy:node.busy;context.fillStyle=working?'#b9e657':node.kind==='provider'?'#f3b955':'#00aeef';context.beginPath();context.arc(point.x,point.y,node.kind==='provider'?17:25,0,Math.PI*2);context.fill();context.fillStyle='#c4dfed';context.font='17px system-ui';context.fillText(String(node.name??node.kind).slice(0,22),point.x,point.y+39);if(node.kind==='provider'){context.font='12px system-ui';context.fillText(String(node.model??node.state??'').slice(0,25),point.x,point.y+58);}}
    context.fillStyle='#f3b955';context.font='17px system-ui';context.fillText('● Providers   ● Cyan: requests   ● Lime: responses',w/2,1015);
    context.fillStyle='#eff8ff';context.font='bold 28px system-ui';context.fillText(state.busy?'WORKING':state.connected?'CONNECTED TO GATEWAY':'WAITING FOR GATEWAY',w/2,1080);
    context.fillStyle='#94adbf';context.font='20px system-ui';context.fillText(`${state.nodes.length} discovered sessions · ${state.model||'No model loaded'}`,w/2,1120);
    context.font='16px system-ui';context.fillText('Observed traffic counters · no simulated activity',w/2,1160);context.fillText(state.enabled?'Contribution enabled · keep this view open':'Contribution paused',w/2,1190);
  }
  async function stop(){
    active=false;clearInterval(timer);stream?.getTracks().forEach(track=>track.stop());stream=null;video.pause();video.srcObject=null;panel.hidden=true;button.textContent='Keep phone alive ↗';
    const held=wake;wake=null;await held?.release().catch(()=>{});if(document.fullscreenElement===panel)await document.exitFullscreen().catch(()=>{});
  }
  button.onclick=async()=>{
    if(active){await lock();return;}
    active=true;panel.hidden=false;button.textContent='Phone awake mode active';draw();timer=setInterval(draw,250);
    // Start both from the click gesture. No microphone, camera or display capture
    // permission is needed: this stream contains only our own canvas drawing.
    void lock();
    if(canvas.captureStream){stream=canvas.captureStream(4);video.srcObject=stream;video.hidden=false;canvas.hidden=true;try{await video.play();}catch{video.hidden=true;canvas.hidden=false;}}
    else{video.hidden=true;canvas.hidden=false;}
    try{if(panel.requestFullscreen){await panel.requestFullscreen();wentFullscreen=true;}else if(!video.hidden&&video.webkitEnterFullscreen){video.webkitEnterFullscreen();}}
    catch{/* The visible theater and wake lock still work without fullscreen. */}
  };
  document.getElementById('phone-alive-close').onclick=()=>{void stop();};
  document.addEventListener('fullscreenchange',()=>{if(active&&wentFullscreen&&document.fullscreenElement!==panel){wentFullscreen=false;void stop();}});
  video.addEventListener('webkitendfullscreen',()=>{void stop();});
  document.addEventListener('visibilitychange',()=>{if(active&&!document.hidden)void lock();});
  window.addEventListener('pagehide',()=>{void stop();});
}
