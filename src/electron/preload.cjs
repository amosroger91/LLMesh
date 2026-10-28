const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('llmesh', {
  nativeRuntime:engine=>ipcRenderer.invoke('runtime-engine',engine),restart:()=>ipcRenderer.invoke('restart-app'), abliteratedServing:enabled=>ipcRenderer.invoke('abliterated-serving',enabled), nodeProfile: value=>ipcRenderer.invoke('node-profile',value), privacy: value => ipcRenderer.invoke('privacy',value), status: () => ipcRenderer.invoke('status'), contribution: level => ipcRenderer.invoke('contribution', level), previewRoute: job => ipcRenderer.invoke('route-preview', job),
  forceModel:()=>ipcRenderer.invoke('force-model'), runtime: () => ipcRenderer.invoke('runtime'), companionChat: job => ipcRenderer.invoke('companion-chat',job), chat: job => ipcRenderer.invoke('chat', job), cancel: () => ipcRenderer.invoke('cancel'),
  copy: name => ipcRenderer.invoke('copy', name), funnelApply: value => ipcRenderer.invoke('funnel-apply', value), funnelProbe: () => ipcRenderer.invoke('funnel-probe'), energy: value => ipcRenderer.invoke('energy', value), scanPower: () => ipcRenderer.invoke('power-scan'),
  connectPayments: value => ipcRenderer.invoke('payments-connect', value), refreshPayments: () => ipcRenderer.invoke('payments-refresh'), registerTokens: () => ipcRenderer.invoke('payments-register'),
  refundPayment: id => ipcRenderer.invoke('payments-refund', id),
  providerModels:value=>ipcRenderer.invoke('provider-models',value),providerAdd:value=>ipcRenderer.invoke('provider-add',value),providerRemove:id=>ipcRenderer.invoke('provider-remove',id),providerToggle:id=>ipcRenderer.invoke('provider-toggle',id),
  browserGuest: value => ipcRenderer.invoke('browser-guest',value), browserPair: value => ipcRenderer.invoke('browser-pair',value), browserApprove: value => ipcRenderer.invoke('browser-approve',value),
  browserReport: (id,event) => ipcRenderer.invoke('browser-report',id,event), browserRemove: id => ipcRenderer.invoke('browser-remove',id),
  onBrowserSend: fn => {const listener=(_event,value)=>fn(value);ipcRenderer.on('browser-send',listener);return ()=>ipcRenderer.removeListener('browser-send',listener);},
  onDelta: fn => { const listener = (_event, value) => fn(value); ipcRenderer.on('delta', listener); return () => ipcRenderer.removeListener('delta', listener); },
  onProgress: fn => { const listener = (_event, value) => fn(value); ipcRenderer.on('progress', listener); return () => ipcRenderer.removeListener('progress', listener); },
  onRoute: fn => { const listener = (_event, value) => fn(value); ipcRenderer.on('route', listener); return () => ipcRenderer.removeListener('route', listener); }
});
