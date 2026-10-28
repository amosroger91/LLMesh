import {mkdir,copyFile,writeFile} from 'node:fs/promises';
import {modelAsset} from '../src/core/model-assets.js';
const root='vendor/llama.cpp',asset={url:'https://github.com/ggml-org/llama.cpp/releases/download/b11960/llama-b11960-bin-win-vulkan-x64.zip',size:37345851,sha256:'bac6914b5e83523eb008c6789eaa12669f93fbc196c3b9e8237b6672323b33e9'};
await mkdir(root,{recursive:true});const file=await modelAsset(asset,'.llmesh/runtime-download',progress=>console.log(progress.completed+'/'+progress.total));
await copyFile(file,root+'/llama-b11960-bin-win-vulkan-x64.zip');
const response=await fetch('https://raw.githubusercontent.com/ggml-org/llama.cpp/b11960/LICENSE');if(!response.ok)throw new Error('Could not archive runtime license');await writeFile(root+'/LICENSE',await response.text());
await writeFile(root+'/manifest.json',JSON.stringify({version:'b11960',platform:'win32',arch:'x64',archive:'llama-b11960-bin-win-vulkan-x64.zip',...asset},null,2)+'\n');console.log('Pinned llama.cpp runtime archived');
