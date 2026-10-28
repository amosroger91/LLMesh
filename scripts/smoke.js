import { app, ipcMain, clipboard } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const directory = resolve('.llmesh/smoke-'+process.pid);
app.disableHardwareAcceleration();
mkdirSync(directory, { recursive: true });
app.setPath('userData', directory);
process.env.LLMESH_SMOKE = '1'; process.env.LLMESH_NO_MESH = '1'; process.env.LLMESH_PORT = '0';
process.on('uncaughtException',error=>{console.error(error);app.exit(1);});
process.on('unhandledRejection',error=>{console.error(error);app.exit(1);});
const timeout = setTimeout(() => { console.error('Electron smoke test timed out'); app.exit(1); }, 30000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('render-process-gone', () => { console.error('Renderer crashed'); app.exit(1); });
  window.webContents.once('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        let attempts = 0;
        const timer = setInterval(() => {
          if (document.body.dataset.ready === 'true' && document.getElementById('pubkey').textContent.length === 64) {
            clearInterval(timer); resolve({ title: document.title, levels: document.querySelectorAll('[data-level]').length,
              socialNavigation: Boolean(document.querySelector('[data-view="mesh"],[data-view="feed"],#view-mesh,#view-feed')),
              modelChooser: Boolean(document.querySelector('select#model,select#web-model')),
              error: document.getElementById('error').textContent });
          } else if (++attempts > 100) { clearInterval(timer); reject(new Error('Dashboard initialization timed out')); }
        }, 50);
      })`);
      if (result.levels !== 3 || result.modelChooser || result.socialNavigation || result.error) throw new Error(JSON.stringify(result));
      assert.equal(await window.webContents.executeJavaScript(`document.getElementById('privacy-mode').closest('.view').id`),'view-settings');
      assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('#runtime-engine').length`),1);
      assert.equal(await window.webContents.executeJavaScript(`Boolean(document.getElementById('model-inventory'))`),true);
      const desktopModules=await window.webContents.executeJavaScript(`['network-map','public-network-map','public-network-count','pair-create','linked-devices','donor-list','privacy-mode','funnel-provider','funnel-cloudflare-token','funnel-status'].every(id=>Boolean(document.getElementById(id)))`);
      assert.equal(desktopModules,true,'Desktop is missing a current mesh module');
      const aliveMap=await window.webContents.executeJavaScript(`(()=>{document.querySelector('[data-view="network"]').click();const known=document.querySelector('#network-map canvas.alive-map'),open=document.querySelector('#public-network-map canvas.alive-map');return {known:known?.dataset.drawn==='1',open:open?.dataset.drawn==='1'};})()`);
      assert.equal(aliveMap.known&&aliveMap.open,true,'Desktop network maps are not the living canvas');
      await window.webContents.executeJavaScript(`(async()=>{
        const select=document.getElementById('privacy-mode');select.value='allow-third-party';select.dispatchEvent(new Event('change'));
        for(let i=0;i<50;i++){if((await window.llmesh.status()).inferencePrivacy==='allow-third-party')break;await new Promise(resolve=>setTimeout(resolve,20));}
        if((await window.llmesh.status()).inferencePrivacy!=='allow-third-party')throw new Error('Privacy dropdown did not save immediately');
        select.value='mesh-only';select.dispatchEvent(new Event('change'));for(let i=0;i<50;i++){if((await window.llmesh.status()).inferencePrivacy==='mesh-only')return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Privacy dropdown did not restore');
      })()`);
      const clipboardBefore = clipboard.readText();
      await window.webContents.executeJavaScript(`window.llmesh.copy('apiKey')`);
      assert.match(clipboard.readText(), /^[a-f0-9]{64}$/);
      clipboard.writeText(clipboardBefore);
      const logoVisible = await window.webContents.executeJavaScript(`document.querySelector('.brand-logo').complete && document.querySelector('.brand-logo').naturalWidth > 0`);
      assert.equal(logoVisible, true);
      const pairing = await window.webContents.executeJavaScript(`(async()=>{
        const key=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveKey']);
        const certificate=await window.llmesh.browserPair({peerId:'smoke-peer',publicKey:await crypto.subtle.exportKey('jwk',key.publicKey)});
        const payload=JSON.parse(certificate.content),deviceId='e'.repeat(64);
        let rejected=false;try{await window.llmesh.browserApprove({deviceId,name:'Test browser',nonce:'wrong'});}catch{rejected=true;}
        if(!rejected)throw new Error('Wrong pairing nonce was accepted');
        const approved=await window.llmesh.browserApprove({deviceId,name:'Test browser',nonce:payload.nonce});
        let reused=false;try{await window.llmesh.browserApprove({deviceId:'f'.repeat(64),name:'Other browser',nonce:payload.nonce});}catch{reused=true;}
        await window.llmesh.browserRemove(deviceId);
        return {scope:approved.scope,reused,kind:certificate.kind,accountMatches:approved.account===certificate.pubkey};
      })()`);
      assert.deepEqual(pairing,{scope:'worker-only',reused:true,kind:30078,accountMatches:true});
      // Exercise the actual renderer/preload chat path with deterministic streamed output.
      const chats = [];
      ipcMain.removeHandler('chat');
      ipcMain.removeHandler('companion-chat');
      const mockChat=async (_event, job) => {
        chats.push(job); assert.equal(job.model, 'llmesh-auto');
        window.webContents.send('route', { reason: 'Smoke route: local mesh worker' });
        window.webContents.send('delta', '<thi');
        window.webContents.send('delta', 'nk>\n'+(chats.length===2?'Private test reasoning':'')+'\n</think>\nMesh ');
        window.webContents.send('delta', 'response');
        await new Promise(resolve => setTimeout(resolve, 30));
        return { model: 'qwen3.5:0.8b', worker: 'smoke-worker', credits: 1, route: { settlement: 'local-self' } };
      };
      ipcMain.handle('chat',mockChat);
      ipcMain.handle('companion-chat',(event,job)=>{assert.equal(job.hardwareOnly,true);return mockChat(event,job);});
      await window.webContents.executeJavaScript(`(async () => {
        if (document.getElementById('online').textContent !== '1') throw new Error('Local node missing from online count');
        if (document.getElementById('prompt')) throw new Error('Endpoint test still requires a custom prompt');
        document.getElementById('send').click();
        for (let i = 0; i < 100; i++) {
          await new Promise(resolve => setTimeout(resolve, 30));
          if (document.getElementById('endpoint-test-status').classList.contains('test-success')) return;
        }
        throw new Error('One-click endpoint test did not succeed');
      })()`);
      assert.equal(chats[0].maxTokens, 32);
      for (const prompt of ['Smoke mesh chat', 'Follow-up']) {
        await window.webContents.executeJavaScript(`(async () => {
          if (document.querySelector('#web-load,#web-model')) throw new Error('Separate browser runtime still present');
          document.getElementById('companion-prompt').value = ${JSON.stringify(prompt)};
          document.getElementById('companion-send').click();
          for (let i = 0; i < 100; i++) {
            await new Promise(resolve => setTimeout(resolve, 30));
            if (!document.getElementById('companion-send').disabled && !document.getElementById('companion-prompt').value) return;
          }
          throw new Error('Companion chat did not finish: ' + document.getElementById('error').textContent);
        })()`);
      }
      assert.equal(chats.length, 3);
      await window.webContents.executeJavaScript(`(async()=>{
        const {renderNetwork}=await import(new URL('../browser/network-map.js',location.href));
        const container=document.createElement('div');
        renderNetwork(container,{nodes:[{id:'working',name:'Working worker',kind:'browser',ready:true,connected:true,busy:true}],edges:[]});
        if(!container.querySelector('animateTransform'))throw new Error('Working node lacks a spinner');
        if(!container.querySelector('[stroke="#f5cc55"]'))throw new Error('Working status is not yellow');
        renderNetwork(container,{nodes:[{id:'ready',name:'Ready worker',kind:'browser',ready:true,connected:true}],edges:[]});
        if(container.querySelector('animateTransform'))throw new Error('Idle node still spins');
        if(!container.querySelector('[stroke="#65df85"]'))throw new Error('Ready status is not green');
      })()`);
      assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('#companion-history details').length`),1);
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#companion-history details').open`),false);
      assert.equal(await window.webContents.executeJavaScript(`document.getElementById('companion-history').textContent.includes('<think>')`),false);
      assert.deepEqual(chats[2].messages.slice(-3), [
        { role: 'user', content: 'Smoke mesh chat' }, { role: 'assistant', content: 'Mesh response' }, { role: 'user', content: 'Follow-up' }
      ]);
      await window.webContents.executeJavaScript(`(async () => {
        document.getElementById('companion-prompt').value = 'Unsent draft';
        document.getElementById('companion-clear').click();
        for (let i = 0; i < 100; i++) {
          await new Promise(resolve => setTimeout(resolve, 20));
          if (!document.getElementById('companion-history').children.length && !document.getElementById('companion-prompt').value) return;
        }
        throw new Error('Clear chat did not clear conversation and draft');
      })()`);
      const offline = await window.webContents.executeJavaScript(`(async () => {
        const state = await window.llmesh.status();
        return { apiSecretWithheld: state.apiKey === undefined, paymentConfigured: state.payments.configured };
      })()`);
      await window.webContents.executeJavaScript(`document.querySelector('[data-view="overview"]').click()`);
      const overviewVisible = await window.webContents.executeJavaScript(`!document.getElementById('view-overview').classList.contains('hidden')`);
      if (!overviewVisible) throw new Error('Overview navigation did not activate');
      await new Promise(resolve => setTimeout(resolve, 150));
      writeFileSync(resolve('.llmesh/smoke.png'), (await window.webContents.capturePage()).toPNG());
      for (const view of ['energy', 'wallet', 'companion', 'network', 'donations', 'settings']) {
        await window.webContents.executeJavaScript(`document.querySelector('[data-view="${view}"]').click()`);
        await new Promise(resolve => setTimeout(resolve, 100));
        writeFileSync(resolve(`.llmesh/smoke-${view}.png`), (await window.webContents.capturePage()).toPNG());
      }
      console.log('Electron dashboard smoke passed:', JSON.stringify({ ...result, ...offline }));
      clearTimeout(timeout); app.quit();
    } catch (e) { console.error(e); app.exit(1); }
  });
});
await import('../src/electron/main.js');
