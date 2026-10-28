import manifest from '../../vendor/browser/manifest.json' with {type:'json'};
export async function localModelConfig(){
 if(!navigator.serviceWorker)throw new Error('Enable service workers to load the repository-hosted model files');
 const registration=await navigator.serviceWorker.register(new URL('../asset-worker.js',import.meta.url));
 await registration.update();const pending=registration.installing??registration.waiting;
 if(pending&&pending.state!=='activated')await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Model asset worker update timed out; reload this page')),15000);pending.addEventListener('statechange',()=>{if(pending.state==='activated'){clearTimeout(timer);resolve();}else if(pending.state==='redundant'){clearTimeout(timer);reject(new Error('Model asset worker could not activate'));}});});
 await navigator.serviceWorker.ready;
 if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Model asset worker did not activate; reload this page')),10000);navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(timer);resolve();},{once:true});});
 return {model_list:manifest.models.map(model=>({...model,model:new URL('../models/'+model.model+'resolve/main/',import.meta.url).href,model_lib:new URL('../models/'+model.model_lib,import.meta.url).href}))};
}
