import manifest from '../../vendor/browser/manifest.json' with {type:'json'};
export async function localModelConfig(){
 if(!navigator.serviceWorker)throw new Error('Enable service workers to load the repository-hosted model files');
 await navigator.serviceWorker.register(new URL('../asset-worker.js',import.meta.url));
 await navigator.serviceWorker.ready;
 if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Model asset worker did not activate; reload this page')),10000);navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(timer);resolve();},{once:true});});
 return {model_list:manifest.models.map(model=>({...model,model:new URL('../models/'+model.model,import.meta.url).href,model_lib:new URL('../models/'+model.model_lib,import.meta.url).href}))};
}
