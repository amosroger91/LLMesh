/* global __ASSET_BASE__ */
import {assetResponse,repositoryAssetPath} from '../browser/asset-response.js';
import manifest from '../../vendor/browser/manifest.json' with {type:'json'};
const files=new Map(manifest.files.map(file=>[file.path,file])),prefix=new URL('models/',self.registration.scope).pathname;
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin)return;const record=files.get(repositoryAssetPath(url.pathname,prefix));if(record)event.respondWith(assetResponse(record,__ASSET_BASE__));});
