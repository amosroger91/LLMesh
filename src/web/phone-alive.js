export function isPhoneDevice(device,coarse){
  return device.userAgentData?.mobile===true||/Android|iPhone|iPad|iPod/i.test(device.userAgent??'')||(/Macintosh/i.test(device.userAgent??'')&&device.maxTouchPoints>1&&coarse);
}

export function phoneAlive(getState){
  const button=document.getElementById('phone-alive');
  if(!isPhoneDevice(navigator,matchMedia('(pointer: coarse)').matches))return;
  button.hidden=false;
  const panel=document.getElementById('phone-theater'),canvas=document.getElementById('phone-canvas'),video=document.getElementById('phone-video'),note=document.getElementById('phone-wake-status');
  const context=canvas.getContext('2d');let active=false,wake,stream,timer,wentFullscreen=false;
  async function lock(){
    if(!active||document.hidden||wake&&!wake.released)return;
    if(!navigator.wakeLock){note.textContent='Video mode active. This browser cannot confirm a screen wake lock.';return;}
    try{wake=await navigator.wakeLock.request('screen');if(!active){await wake.release();return;}note.textContent='Screen wake lock active · leave this tab visible';wake.addEventListener('release',()=>{if(active)note.textContent='Screen wake lock released by browser · exit and reopen awake mode to retry';});}
    catch{note.textContent='Screen wake lock unavailable · battery saver or browser policy may allow sleep';}
  }
  function draw(){
    const state=getState(),nodes=state.nodes.slice(0,24),w=canvas.width,h=canvas.height,time=Date.now()/1000;
    context.fillStyle='#07131d';context.fillRect(0,0,w,h);context.fillStyle='#b9e657';context.font='20px monospace';context.textAlign='center';context.fillText('THE PEOPLE’S COMPUTE',w/2,80);
    context.fillStyle='#eff8ff';context.font='bold 54px system-ui';context.fillText('LLMesh',w/2,145);
    const points=nodes.map((node,index)=>({node,x:w/2+Math.cos(index/Math.max(1,nodes.length)*Math.PI*2-.5*Math.PI)*220,y:490+Math.sin(index/Math.max(1,nodes.length)*Math.PI*2-.5*Math.PI)*220}));
    context.lineWidth=2;for(const point of points){context.strokeStyle='#17465b';context.beginPath();context.moveTo(w/2,490);context.lineTo(point.x,point.y);context.stroke();}
    context.fillStyle=state.busy?'#b9e657':'#00aeef';context.beginPath();context.arc(w/2,490,35+Math.sin(time*2)*3,0,Math.PI*2);context.fill();
    for(const point of points){context.fillStyle=point.node.busy?'#b9e657':'#00aeef';context.beginPath();context.arc(point.x,point.y,15,0,Math.PI*2);context.fill();context.fillStyle='#b7d8e9';context.font='16px system-ui';context.fillText(point.node.kind==='desktop'?'Desktop':'Browser',point.x,point.y+35);}
    context.fillStyle='#eff8ff';context.font='bold 32px system-ui';context.fillText(state.busy?'WORKING':state.connected?'CONNECTED TO GATEWAY':'WAITING FOR GATEWAY',w/2,865);
    context.fillStyle='#94adbf';context.font='23px system-ui';context.fillText(`${state.nodes.length} discovered sessions · ${state.model||'No model loaded'}`,w/2,920);
    context.fillText(state.enabled?'Node contribution enabled':'Contribution paused',w/2,970);context.font='19px system-ui';context.fillText('Keep this view open to keep contributing.',w/2,1100);
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
