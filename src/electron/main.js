import { app, BrowserWindow, ipcMain, safeStorage, shell, clipboard } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Service } from '../service.js';
import { startApi } from '../api.js';
import { generateSecretKey, signAuth } from '../identity.js';
import { Wallet, randomBytes, hexlify } from 'ethers';
import { Payments } from '../payments.js';
import { finalizeEvent } from 'nostr-tools/pure';
import { discoverProvider } from '../core/providers.js';
import { createNodeFunnel } from '../core/funnel/index.js';

let service, api, window, quitting = false;
const here = dirname(fileURLToPath(import.meta.url));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(async () => {
  app.setAppUserModelId('net.llmesh.desktop');
  try {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('OS encrypted storage is required for the desktop identity');
    const directory = app.getPath('userData'); const keyPath = join(directory, 'identity.enc');
    if (!existsSync(keyPath)) writeFileSync(keyPath, safeStorage.encryptString(Buffer.from(generateSecretKey()).toString('hex')));
    const list = name => (process.env[name] ?? '').split(',').filter(Boolean);
    function encrypted(name, create) {
      const path = join(directory, name);
      if (!existsSync(path)) writeFileSync(path, safeStorage.encryptString(create()));
      return safeStorage.decryptString(readFileSync(path));
    }
    const secret = Buffer.from(safeStorage.decryptString(readFileSync(keyPath)), 'hex');
    const paymentPath = join(directory, 'payments.json');
    const payments = new Payments(encrypted('wallet.enc', () => Wallet.createRandom().privateKey), existsSync(paymentPath) ? JSON.parse(readFileSync(paymentPath, 'utf8')) : {});
    await payments.startConnection();
    service = new Service({ directory, secret, payments, apiKey: encrypted('api-key.enc', () => hexlify(randomBytes(32)).slice(2)),
      topic: process.env.LLMESH_TOPIC, allowedWorkers: list('LLMESH_WORKERS'), trustedCoordinators: list('LLMESH_COORDINATORS'), network: process.env.LLMESH_NO_MESH !== '1' });
    const donationsPath=join(directory,'donated-apis.enc');
    if(existsSync(donationsPath))service.providers.configure(JSON.parse(safeStorage.decryptString(readFileSync(donationsPath))));
    api = await startApi(service, { port: Number(process.env.LLMESH_PORT ?? 7337) });
    await service.initialize();
    const funnelFile = join(directory, 'funnel.json');
    const funnelTokenFile = join(directory, 'funnel-token.enc');
    const funnelCloudflareTokenFile = join(directory, 'funnel-cloudflare-token.enc');
    function readFunnel() {
      let file = {};
      try { if (existsSync(funnelFile)) file = JSON.parse(readFileSync(funnelFile, 'utf8')); } catch { file = {}; }
      let token = process.env.LLMESH_FUNNEL_TOKEN || null;
      if (!token && existsSync(funnelTokenFile)) token = safeStorage.decryptString(readFileSync(funnelTokenFile));
      let cloudflareToken = process.env.LLMESH_FUNNEL_CLOUDFLARE_TOKEN || null;
      if (!cloudflareToken && process.env.LLMESH_FUNNEL_CLOUDFLARE_TOKEN_FILE) cloudflareToken = readFileSync(process.env.LLMESH_FUNNEL_CLOUDFLARE_TOKEN_FILE, 'utf8').trim();
      if (!cloudflareToken && existsSync(funnelCloudflareTokenFile)) cloudflareToken = safeStorage.decryptString(readFileSync(funnelCloudflareTokenFile));
      return { provider: process.env.LLMESH_FUNNEL || file.provider || 'off', relay: process.env.LLMESH_FUNNEL_RELAY || file.relay || '', publicUrl: process.env.LLMESH_FUNNEL_PUBLIC_URL || file.publicUrl || '', token, cloudflareToken };
    }
    async function applyFunnel(input = {}, persist = true) {
      const current = readFunnel();
      const next = { provider: input.provider || current.provider || 'off', relay: input.relay ?? current.relay, publicUrl: input.publicUrl ?? current.publicUrl, token: input.token || current.token || null, cloudflareToken: input.cloudflareToken || current.cloudflareToken || null, allowInsecure: false, secret, pubkey: service.pubkey, apiHost: '127.0.0.1', apiPort: api.address().port };
      const node = createNodeFunnel(next);
      await service.funnel?.stop?.();
      service.funnel = node;
      if (persist) {
        writeFileSync(funnelFile, JSON.stringify({ provider: node.settings.provider, relay: node.settings.relay, publicUrl: node.settings.publicUrl }), { mode: 0o600 });
        if (input.token) writeFileSync(funnelTokenFile, safeStorage.encryptString(input.token));
        if (input.cloudflareToken) writeFileSync(funnelCloudflareTokenFile, safeStorage.encryptString(input.cloudflareToken));
      }
      if (node.settings.provider !== 'off') await node.start();
      return node.status();
    }
    await applyFunnel(readFunnel(), false).catch(error => service.emit('progress', { status: `Funnel did not start: ${error.message}` }));
    window = new BrowserWindow({ width: 1180, height: 850, minWidth: 850, minHeight: 650, show: process.env.LLMESH_SMOKE !== '1', backgroundColor: '#10151d', icon: join(here, '../../assets/branding/icon.png'),
      webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const emit = (name, value) => { if (!window.isDestroyed()) window.webContents.send(name, value); };
    service.on('progress', item => emit('progress', item));
    service.on('route', route => emit('route', route));
    const handle = (name, fn) => ipcMain.handle(name, (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Invalid sender');
      return fn(...args);
    });
    handle('status', () => service.status());
    handle('funnel-apply', value => applyFunnel(value ?? {}, true));
    handle('funnel-probe', () => service.funnel?.probe?.() ?? Promise.resolve({ provider: 'off', state: 'off', publicUrl: null }));
    handle('privacy', value => service.configurePrivacy(value));
    handle('node-profile',value=>service.configureNodeProfile(value));
    const saveDonations=()=>writeFileSync(donationsPath,safeStorage.encryptString(JSON.stringify(service.providers.configuration())));
    handle('provider-models',value=>discoverProvider(value));
    handle('provider-add',value=>{service.providers.configure([...service.providers.configuration(),value]);saveDonations();return service.providers.snapshot();});
    handle('provider-remove',id=>{service.providers.configure(service.providers.configuration().filter(provider=>provider.id!==id));saveDonations();});
    handle('provider-toggle',id=>{service.providers.configure(service.providers.configuration().map(provider=>provider.id===id?{...provider,enabled:!provider.enabled}:provider));saveDonations();});
    let pairing;
    handle('browser-pair', value => {
      if (!value || !/^[A-Za-z0-9_-]{1,100}$/.test(value.peerId) || value.publicKey?.kty !== 'EC' || value.publicKey.crv !== 'P-256' || typeof value.publicKey.x !== 'string' || typeof value.publicKey.y !== 'string') throw new Error('Invalid pairing key');
      pairing = { nonce: hexlify(randomBytes(32)).slice(2), expires: Date.now() + 120000, used: false };
      return finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now()/1000), tags: [['d','llmesh-worker-pair-v1']],
        content: JSON.stringify({ v:1, scope:'worker-only', peerId:value.peerId, publicKey:value.publicKey, nonce:pairing.nonce, expires:pairing.expires,
          origin:'https://amosroger91.github.io', account:service.pubkey }) }, secret);
    });
    handle('browser-approve', value => {
      if (!pairing || pairing.used || pairing.expires < Date.now() || value.nonce !== pairing.nonce) throw new Error('Pairing expired or already used; generate a new QR');
      service.browserWorkers.register(value.deviceId,value.name,false,value.harvest!==false);pairing.used=true;
      return {account:service.pubkey,scope:value.harvest===false?'trusted-donation':'worker-only'};
    });
    handle('browser-guest', value => {service.browserWorkers.register(value.deviceId,value.name,true);return {scope:'donation-only'};});
    handle('browser-report', (id,event) => {try{return service.browserWorkers.report(id,event);}catch(error){service.browserWorkers.remove(id);throw error;}});
    handle('browser-remove', id => { emit('browser-send',{deviceId:id,message:{type:'revoked'}});service.browserWorkers.remove(id); });
    service.browserWorkers.on('send', value => emit('browser-send',value));
    handle('contribution', level => service.configureContribution(level));
    handle('force-model',()=>service.configureContribution(service.contributionLevel,{forceMemory:true}));
    handle('route-preview', job => service.route(job));
    handle('copy', name => { const state = service.status(); const value = { endpoint: state.api + '/v1', apiKey: service.apiKey, modelId: 'llmesh-auto', modelName: 'LLMesh Auto', wallet: state.payments.address, pubkey: state.pubkey, funnel: state.funnel?.publicUrl }[name]; if (!value) throw new Error(name === 'funnel' ? 'Funnel has no public URL yet' : 'Nothing to copy'); clipboard.writeText(value); });
    handle('energy', settings => service.energy.configure(settings));
    handle('power-scan', () => service.energy.scan());
    handle('payments-connect', async settings => { if (service.busy || service.activeRequests || service.requests || service.installing) throw new Error('Stop active requests before changing payment networks');
      const result = await payments.connect(settings); writeFileSync(paymentPath, JSON.stringify(settings)); return result; });
    handle('payments-refresh', () => payments.refresh());
    handle('payments-register', () => payments.register(service.pubkey, async () => {
      const base = new URL(payments.settings.coordinatorApi);
      if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname))) throw new Error('Use an HTTPS coordinator URL or local development address');
      const url = base.href.replace(/\/$/, '') + '/v1/accounts', body = JSON.stringify({ wallet: payments.wallet.address });
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: signAuth(secret, url, 'POST', body) }, body, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Coordinator grant request failed: ' + await response.text()); return response.json();
    }));
    handle('payments-refund', id => { if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error('Invalid escrow job ID'); return payments.refund({ id }); });
    handle('runtime', async () => {
      if (process.platform !== 'win32') { await shell.openExternal('https://ollama.com/download'); return 'Install Ollama, then choose Download & configure.'; }
      return new Promise((resolve, reject) => {
        const child = spawn('winget', ['install', '--id', 'Ollama.Ollama', '--exact', '--accept-package-agreements', '--accept-source-agreements', '--silent'], { windowsHide: true, stdio: 'ignore' });
        child.on('error', () => reject(new Error('winget unavailable. Install Ollama from ollama.com/download.')));
        child.on('exit', code => code === 0 ? resolve('Ollama installed. Restart LLMesh if it is not yet on PATH.') : reject(new Error(`Ollama installer exited ${code}. See ollama.com/download.`)));
      });
    });
    let controller;
    const chat=async job => {
      if (controller) throw new Error('A request is already running');
      controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 180000);
      try { return await service.chat(service.pubkey, job, text => emit('delta', text), controller.signal); }
      finally { clearTimeout(timer); controller = null; }
    };
    handle('chat',chat);
    handle('companion-chat',job=>chat({...job,hardware_only:undefined,hardwareOnly:true}));
    handle('cancel', () => controller?.abort());
    await window.loadFile(join(here, '../ui/index.html'));
    if (process.platform === 'win32') service.ollama.installRuntime = () => new Promise((resolve, reject) => {
      emit('progress', { status: 'Installing the local inference runtime automatically…' });
      const child = spawn('winget', ['install', '--id', 'Ollama.Ollama', '--exact', '--accept-package-agreements', '--accept-source-agreements', '--silent'], { windowsHide: true, stdio: 'ignore' });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Runtime installer exited ${code}. Install Ollama and retry automatic setup.`)));
    });
    if (process.env.LLMESH_SMOKE !== '1') service.startContributionManagement();
  } catch (e) { const { dialog } = await import('electron'); dialog.showErrorBox('LLMesh could not start', e.message); app.quit(); }
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !service) return; event.preventDefault(); quitting = true;
    Promise.resolve(service.funnel?.stop?.()).finally(() => { api?.closeAllConnections(); api?.close(); service.close().finally(() => app.quit()); });
  });
  });
}
