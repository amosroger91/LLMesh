import {restoreOllamaModel,nativeAsset} from '../src/core/model-vault.js';import {modelAsset} from '../src/core/model-assets.js';import {defaultCache} from '../src/core/model-bundle.js';import {catalog} from '../src/core/catalog.js';import {join,resolve} from 'node:path';
const id=process.argv[2],cache=process.argv[3]?resolve(process.argv[3]):defaultCache();if(!catalog.models.some(model=>model.id===id))throw new Error('Pass an exact catalog model ID');
const controller=new AbortController(),progress=item=>console.log(item.status+' '+(item.completed??0)+'/'+(item.total??0));
if(catalog.models.find(model=>model.id===id).gguf){const file=await modelAsset(nativeAsset(id),join(cache,'llmesh-assets'),progress,controller.signal);console.log(JSON.stringify({model:id,gguf:file}));}
else{if(!await restoreOllamaModel(id,cache,progress,controller.signal))throw new Error('No complete repository backup is available for this model');console.log(JSON.stringify({model:id,cache,restored:true}));}
