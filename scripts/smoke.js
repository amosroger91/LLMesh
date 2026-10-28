import { app, ipcMain, clipboard } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const directory = resolve('.llmesh/smoke');
app.disableHardwareAcceleration();
mkdirSync(directory, { recursive: true });
app.setPath('userData', directory);
process.env.LLMESH_SMOKE = '1'; process.env.LLMESH_NO_MESH = '1'; process.env.LLMESH_PORT = '0';
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
      const clipboardBefore = clipboard.readText();
      await window.webContents.executeJavaScript(`window.llmesh.copy('apiKey')`);
      assert.match(clipboard.readText(), /^[a-f0-9]{64}$/);
      clipboard.writeText(clipboardBefore);
      const logoVisible = await window.webContents.executeJavaScript(`document.querySelector('.brand-logo').complete && document.querySelector('.brand-logo').naturalWidth > 0`);
      assert.equal(logoVisible, true);
      // Exercise the actual renderer/preload chat path with deterministic streamed output.
      const chats = [];
      ipcMain.removeHandler('chat');
      ipcMain.handle('chat', async (_event, job) => {
        chats.push(job); assert.equal(job.model, 'llmesh-auto');
        window.webContents.send('route', { reason: 'Smoke route: local mesh worker' });
        window.webContents.send('delta', 'Mesh ');
        window.webContents.send('delta', 'response');
        await new Promise(resolve => setTimeout(resolve, 30));
        return { model: 'qwen3.5:0.8b', worker: 'smoke-worker', credits: 1, route: { settlement: 'local-self' } };
      });
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
      assert.deepEqual(chats[2].messages.slice(-3), [
        { role: 'user', content: 'Smoke mesh chat' }, { role: 'assistant', content: 'Mesh response' }, { role: 'user', content: 'Follow-up' }
      ]);
      const offline = await window.webContents.executeJavaScript(`(async () => {
        const state = await window.llmesh.status();
        return { apiSecretWithheld: state.apiKey === undefined, paymentConfigured: state.payments.configured };
      })()`);
      await window.webContents.executeJavaScript(`document.querySelector('[data-view="overview"]').click()`);
      const overviewVisible = await window.webContents.executeJavaScript(`!document.getElementById('view-overview').classList.contains('hidden')`);
      if (!overviewVisible) throw new Error('Overview navigation did not activate');
      await new Promise(resolve => setTimeout(resolve, 150));
      writeFileSync(resolve('.llmesh/smoke.png'), (await window.webContents.capturePage()).toPNG());
      for (const view of ['energy', 'wallet', 'companion']) {
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
