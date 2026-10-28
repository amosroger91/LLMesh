import {ObservedGraph} from '../browser/observed-graph.js';
import {drawAliveScene} from '../browser/alive-map.js';
export function isPhoneDevice(device,coarse){
  return device.userAgentData?.mobile===true||/Android|iPhone|iPad|iPod/i.test(device.userAgent??'')||(/Macintosh/i.test(device.userAgent??'')&&device.maxTouchPoints>1&&coarse);
}

export function phoneAlive(getState){
  const button=document.getElementById('phone-alive');
  if(!isPhoneDevice(navigator,matchMedia('(pointer: coarse)').matches))return;
  button.hidden=false;
  const panel=document.getElementById('phone-theater'),canvas=document.getElementById('phone-canvas'),video=document.getElementById('phone-video'),note=document.getElementById('phone-wake-status');
  const context=canvas.getContext('2d');let active=false,wake,stream,timer,wentFullscreen=false;const graph=new ObservedGraph(),pictures=new Map();
  async function lock(){
    if(!active||document.hidden||wake&&!wake.released)return;
    if(!navigator.wakeLock){note.textContent='Video mode active. This browser cannot confirm a screen wake lock.';return;}
    try{wake=await navigator.wakeLock.request('screen');if(!active){await wake.release();return;}note.textContent='Screen wake lock active · leave this tab visible';wake.addEventListener('release',()=>{if(active)note.textContent='Screen wake lock released by browser · exit and reopen awake mode to retry';});}
    catch{note.textContent='Screen wake lock unavailable · battery saver or browser policy may allow sleep';}
  }
  function draw(){
    const state=getState(),scene=graph.update(state.nodes),base=scene.nodes.filter(node=>node.kind!=='provider');
    drawAliveScene(context,{width:canvas.width,height:canvas.height,scene,pictures,caption:{
      kicker:'THE PEOPLE’S COMPUTE',title:'LLMesh',legend:'Green: ready · Yellow: working · Blue: API · Red: unavailable',
      status:state.busy?'WORKING':state.connected?'CONNECTED TO GATEWAY':'WAITING FOR GATEWAY',
      detail:`${base.length} contributing devices · ${scene.visitors} visitors · ${state.model||'No model loaded'}`,
      notes:['Observed traffic counters · no simulated activity',state.enabled?'Contribution enabled · keep this view open':'Contribution paused']
    }});
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
