import test from 'node:test';import assert from 'node:assert/strict';import {phoneAlive,isPhoneDevice} from '../src/web/phone-alive.js';
test('phone awake mode is hidden on desktop and uses and releases screen wake lock and video resources',async()=>{
 assert.equal(isPhoneDevice({userAgent:'Windows NT',maxTouchPoints:0},false),false);assert.equal(isPhoneDevice({userAgent:'iPhone'},true),true);assert.equal(isPhoneDevice({userAgent:'Macintosh',maxTouchPoints:5},true),true);
 const originals=Object.fromEntries(['document','window','navigator','matchMedia'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));let released=0,stopped=0,played=0;
 const elements=Object.fromEntries(['phone-alive','phone-theater','phone-canvas','phone-video','phone-wake-status','phone-alive-close'].map(id=>[id,{hidden:true,addEventListener(){}}]));
 const context=new Proxy({},{get:()=>()=>{}});elements['phone-canvas'].getContext=()=>context;elements['phone-canvas'].captureStream=()=>({getTracks:()=>[{stop(){stopped++;}}]});elements['phone-video'].play=async()=>{played++;};elements['phone-video'].pause=()=>{};
 const document={hidden:false,getElementById:id=>elements[id],addEventListener(){},exitFullscreen:async()=>{document.fullscreenElement=null;}};elements['phone-theater'].requestFullscreen=async()=>{document.fullscreenElement=elements['phone-theater'];};
 const device={userAgent:'iPhone',wakeLock:{request:async kind=>{assert.equal(kind,'screen');return{released:false,addEventListener(){},release:async()=>{released++;}};}}};
 try{for(const [key,value]of Object.entries({document,window:{addEventListener(){}},navigator:device,matchMedia:()=>({matches:true})}))Object.defineProperty(globalThis,key,{configurable:true,value});
 phoneAlive(()=>({nodes:[],model:'Qwen',enabled:true}));assert.equal(elements['phone-alive'].hidden,false);await elements['phone-alive'].onclick();assert.equal(played,1);assert.match(elements['phone-wake-status'].textContent,/wake lock active/);assert.equal(elements['phone-theater'].hidden,false);
 elements['phone-alive-close'].onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(released,1);assert.equal(stopped,1);assert.equal(elements['phone-theater'].hidden,true);
 }finally{for(const [key,descriptor]of Object.entries(originals)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});
