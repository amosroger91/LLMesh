import {modelCapability} from '../browser/node-performance.js';
import { formatCredits } from '../core/pricing.js';
import {responseView,splitThinking} from './response-view.js';
import {donationControls} from './donations.js';
import {browserBridge} from './browser-bridge.js';
import { LocalStore } from '../browser/storage.js';
import { npubEncode } from 'nostr-tools/nip19';

const $ = id => document.getElementById(id), api = window.llmesh;
let first = true, state, store, outputNode;
let companionHistory = [], inferenceActive = false;
let renderDonations,privacySaving=false;
function error(e) { $('error').textContent = e.message ?? String(e); }
function bind(id, fn) { $(id).onclick = async () => { $('error').textContent = ''; try { await fn(); } catch (e) { error(e); } }; }
async function task(id, fn) { $(id).disabled = true; try { return await fn(); } finally { $(id).disabled = false; } }
const money = (value, currency) => `${currency} ${Number(value).toFixed(4)}`;
const short = value => value ? value.slice(0, 10) + '…' + value.slice(-5) : '—';
function textRow(container, name, value) { const row = document.createElement('div'), label = document.createElement('span'), text = document.createElement('strong'); label.textContent = name; text.textContent = value; row.append(label, text); container.append(row); }
function renderEnergy(energy) {
  const current = energy.totals.find(total => total.currency === energy.settings.currency) ?? { kwh: 0, cost: 0 };
  $('energy-total').textContent = `${energy.totals.reduce((sum, total) => sum + total.kwh, 0).toFixed(4)} kWh`;
  $('cost-total').textContent = `Est. ${money(current.cost, energy.settings.currency)}`;
  $('power-watts').textContent = `${energy.watts.toFixed(0)} W`; $('power-method').textContent = energy.method;
  $('power-hour').textContent = money(energy.estimatedCostPerHour, energy.settings.currency);
  $('power-kwh').textContent = $('energy-total').textContent; $('power-cost').textContent = money(current.cost, energy.settings.currency);
  $('energy-sessions').replaceChildren();
  for (const session of energy.sessions) {
    const row = document.createElement('div'); row.className = 'session';
    const title = document.createElement('strong'); title.textContent = session.model;
    const detail = document.createElement('small'); detail.textContent = `${session.kwh.toFixed(6)} kWh · ${money(session.cost, session.currency)} · ${session.ended ? new Date(session.started).toLocaleString() : 'Running now'} · ${session.method}`;
    row.append(title, detail); $('energy-sessions').append(row);
  }
}
function renderPayments(payment) {
  $('wallet-address').textContent = payment.address ?? 'Unavailable';
  $('balance').textContent = payment.configured ? Number(payment.balance ?? 0).toFixed(2) : formatCredits(state.account?.balance ?? 0);
  $('balance-label').textContent = payment.configured ? `${payment.chainId === 8453 ? 'Base' : 'Test network'} · earned from completed work` : 'Local self-service credits · spend and earn back';
  $('wallet-status').textContent = payment.configured ? `${payment.balance} LLMESH · ${Number(payment.nativeBalance).toFixed(6)} ETH gas · ${payment.isCoordinator ? 'Coordinator wallet' : 'Worker receiving wallet'}` : payment.error ?? 'Self-served requests reserve local credits and return them on completion. Base payments are required for other nodes.';
  $('wallet-jobs').replaceChildren();
  for (const job of payment.jobs ?? []) {
    const row = document.createElement('div'); row.className = 'session'; const id = document.createElement('code'); id.textContent = job.id;
    const detail = document.createElement('small'); detail.textContent = `${job.state} · ${job.network} · ${job.tx ?? 'transaction not yet recorded'}`; row.append(id, detail); $('wallet-jobs').append(row);
  }
}
async function refresh() {
  state = await api.status();
  if(!$('runtime-engine').disabled)$('runtime-engine').value=state.pendingRuntimeEngine??state.runtimeEngine??'ollama';
  $('restart-runtime').classList.toggle('hidden',!state.pendingRuntimeEngine||state.pendingRuntimeEngine===state.runtimeEngine);
  $('abliterated-status').textContent=state.abliteratedSetup?.message??(state.abliteratedServing?'Preparing additional worker':'Disabled');
  if(!$('abliterated-serving').disabled)$('abliterated-serving').checked=state.abliteratedServing===true;
  if(!privacySaving)$('privacy-mode').value=state.inferencePrivacy??'mesh-only';
  $('memory').textContent = `${state.hardware.freeRamGB.toFixed(1)} GB free RAM`;
  $('online').textContent = state.topology?.nodes.filter(node=>node.kind!=='provider').length ?? new Set(state.workers.map(worker=>worker.pubkey)).size + 1;
  $('network').textContent = state.workers.length ? 'Inference mesh connected' : 'Local inference node';
  $('peers').textContent = `Your node + ${state.workers.length} remote worker${state.workers.length === 1 ? '' : 's'}`;
  const profile = state.contribution, chosen = state.assignedModel ?? profile?.model?.id;
  $('running-model').textContent = state.currentModel ?? chosen ?? 'Waiting for free memory';
  $('top-model').textContent = state.currentModel ?? state.assignedModel ?? 'Preparing automatically';
  $('ready').textContent = state.busy ? 'Actively running local inference' : state.setup.state === 'ready' ? 'Installed automatically · ready for local requests' : state.setup.message;
  const active = state.busy || state.activeRequests;
  $('request-status').textContent = state.installing ? '● PREPARING MODEL' : active ? '● RUNNING REQUEST' : '● IDLE'; $('request-status').classList.toggle('busy', Boolean(active || state.installing));
  $('recommendation').textContent = profile?.reason ?? state.recommendation.reason;
  $('assigned-model').textContent = chosen ?? 'Waiting for free memory';
  $('contribution-summary').textContent = (profile?.reason ?? '') + (state.pendingContribution ? ` ${state.pendingContribution.toUpperCase()} queued until current work finishes.` : '');
  const rate = profile?.reward;
  const rateText = rate == null ? '' : ` · ${Number.isInteger(rate) ? rate : rate.toFixed(1)} CREDIT${rate === 1 ? '' : 'S'} / TOKEN`;
  $('contribution-badge').textContent = `${state.contributionLevel.toUpperCase()}${rateText}`;
  document.querySelectorAll('[data-level]').forEach(button => button.classList.toggle('selected', button.dataset.level === (state.pendingContribution ?? state.contributionLevel)));
  $('setup').textContent = state.setup.message;
  $('setup-retry-actions').classList.toggle('hidden', state.setup.state !== 'error');
  $('progress').value = state.setup.total ? state.setup.completed / state.setup.total * 100 : state.setup.state === 'ready' ? 100 : 0;
  if (state.lastRoute) showRoute(state.lastRoute);
  else if (!state.serving.length && !state.workers.some(worker => worker.busy === 0)) $('companion-route').textContent = 'Preparing your node: ' + state.setup.message;
  $('hardware').replaceChildren(); textRow($('hardware'), 'PROCESSOR', state.hardware.cpu);
  textRow($('hardware'), 'MEMORY', `${state.hardware.ramGB.toFixed(0)} GB · ${state.hardware.cores} logical cores`);
  for (const gpu of state.hardware.gpus) textRow($('hardware'), 'GRAPHICS', `${gpu.name} · ${gpu.vramGB.toFixed(1)} GB VRAM${gpu.freeGB == null ? '' : ` · ${gpu.freeGB.toFixed(1)} GB free`}`);
  textRow($('hardware'), 'SYSTEM', `${state.hardware.platform} / ${state.hardware.arch}`);
  $('pubkey').textContent = state.pubkey; $('npub').textContent = npubEncode(state.pubkey);
  $('api').textContent = state.api + '/v1'; $('api-key').value = 'Use the Copy key button'; $('openapi-url').textContent = state.api + '/openapi.json';
  renderFunnel(state.funnel);
  $('api-example').textContent = `from openai import OpenAI\n\nclient = OpenAI(\n  base_url="${state.api}/v1",\n  api_key="<copy your local key>"\n)\n\nclient.chat.completions.create(\n  model="llmesh-auto",\n  messages=[{"role": "user",\n    "content": "Hello, mesh!"}],\n  stream=True\n)`;
  $('worker-list').replaceChildren();
  for (const worker of state.workers) textRow($('worker-list'), short(worker.pubkey), `${worker.busy ? 'Busy' : 'Idle'} · ${worker.latencyMs.toFixed(0)} ms RTT · ${worker.wallet ? 'wallet ready' : 'no wallet'}${worker.funnel?.url ? ` · funnel ${worker.funnel.url}` : ''}`);
  if (!state.workers.length) $('worker-list').textContent = 'No trusted inference workers connected.';
  const speeds=[...(state.instances??[]).map(item=>({...item,name:'Your desktop'})),...(state.browserDevices??[]),...(state.donations??[]).map(item=>({...item,name:item.provider})),...state.workers.flatMap(worker=>worker.models.map(model=>({id:worker.instanceId??worker.pubkey,name:worker.profile?.name??short(worker.pubkey),model,metrics:worker.metrics?.[model]})))].map(item=>({...item,capability:modelCapability(item.model,item.modelInfo?.rank),measurement:{...(item.metrics??item),tokensPerSecond:(item.metrics??item).averageTokensPerSecond??(item.metrics??item).tokensPerSecond}})).filter(item=>Number.isFinite(item.measurement.tokensPerSecond)&&item.measurement.tokensPerSecond>0).sort((a,b)=>b.capability-a.capability||b.measurement.tokensPerSecond-a.measurement.tokensPerSecond);
  $('speed-ranking').replaceChildren();speeds.forEach((item,index)=>textRow($('speed-ranking'),`${index+1}. ${item.name} · ${item.model}`,`${item.measurement.tokensPerSecond.toFixed(1)} avg tokens/s · tier ${item.capability||'unknown'} · ${Math.round(item.measurement.firstTokenMs??0)} ms first token`));
  if(!speeds.length)$('speed-ranking').textContent='Complete a request to measure worker speed.';
  renderDonations?.(state); renderEnergy(state.energy); renderPayments(state.payments);
  if (first) {
    const energy = state.energy.settings;
    $('energy-rate').value = energy.rate; $('energy-currency').value = energy.currency; $('energy-watts').value = energy.estimatedWatts;
    $('energy-host').value = energy.hostWatts; $('energy-wall').value = energy.wallWatts ?? '';
    const settings = state.payments.settings ?? {};
    const funnel = state.funnel?.configured ?? state.funnel ?? {};
    if ($('funnel-provider')) $('funnel-provider').value = funnel.provider ?? 'off';
    if ($('funnel-relay') && funnel.relay) $('funnel-relay').value = funnel.relay;
    if ($('funnel-public-url') && funnel.publicUrl) $('funnel-public-url').value = funnel.publicUrl;
    if (settings.rpc) $('wallet-rpc').value = settings.rpc;
    if (settings.chainId) $('wallet-chain').value = settings.chainId;
    $('wallet-token').value = settings.token ?? ''; $('wallet-escrow').value = settings.escrow ?? ''; first = false;
    $('wallet-coordinator').value = settings.coordinatorApi ?? '';
  }
}
document.querySelectorAll('[data-copy]').forEach(button => { button.onclick = () => api.copy(button.dataset.copy).then(() => { const label = button.textContent; button.textContent = 'Copied ✓'; setTimeout(() => { button.textContent = label; }, 1200); }).catch(error); });
document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => {
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('hidden', view.id !== 'view-' + button.dataset.view));
  document.querySelectorAll('.nav').forEach(nav => nav.classList.toggle('active', nav === button));
  $('page-title').textContent = button.textContent.trim(); localStorage.setItem('llmesh-view', button.dataset.view);
}; });
$('runtime-engine').onchange=async()=>{const control=$('runtime-engine');control.disabled=true;try{await api.nativeRuntime(control.value);await refresh();$('runtime-note').textContent='Runtime choice saved. Restart LLMesh to apply.';}catch(cause){control.value=state.pendingRuntimeEngine??state.runtimeEngine??'ollama';error(cause);}finally{control.disabled=false;}};
bind('restart-runtime',()=>api.restart());
$('abliterated-serving').onchange=async()=>{const control=$('abliterated-serving');control.disabled=true;try{await api.abliteratedServing(control.checked);await refresh();}catch(cause){control.checked=state.abliteratedServing===true;error(cause);}finally{control.disabled=false;}};
$('privacy-mode').onchange=async()=>{
  const select=$('privacy-mode'),value=select.value;privacySaving=true;select.disabled=true;$('error').textContent='';
  try{await api.privacy(value);state.inferencePrivacy=value;$('privacy-note').textContent='Saved automatically · applies to desktop requests and API clients that omit privacy. Explicit request settings take precedence.';}
  catch(cause){error(cause);select.value=state.inferencePrivacy??'mesh-only';$('privacy-note').textContent='Could not save inference routing preference.';}
  finally{privacySaving=false;select.disabled=false;}
};
function renderFunnel(funnel = { provider: 'off', state: 'off' }) {
  const status = $('funnel-status');
  if (!status) return;
  const label = { off: 'Funnel is off. This node stays on loopback.', starting: 'Opening the funnel.', pending: 'Funnel is up. Waiting until the public URL reaches this node.', verified: 'Public URL verified. Clients still need your API key.', error: 'Funnel is not reachable.' }[funnel.state] ?? funnel.state;
  const base = funnel.state === 'verified' && funnel.publicUrl ? `OpenAI base URL ${funnel.publicUrl.replace(/\/$/, '')}/v1` : funnel.publicUrl;
  const temporary = funnel.ephemeral ? 'This hostname changes when the tunnel restarts.' : '';
  status.textContent = [label, base, temporary, funnel.error].filter(Boolean).join(' ');
}
function showRoute(route) { for (const id of ['route-status', 'companion-route']) $(id).textContent = route.reason; }
api.onRoute(showRoute);
document.querySelectorAll('[data-level]').forEach(button => { button.onclick = async () => {
  try { await api.contribution(button.dataset.level); await refresh(); } catch (e) { error(e); }
}; });
bind('force-model',()=>task('force-model',async()=>{await api.forceModel();await refresh();}));
bind('retry-setup', () => task('retry-setup', async () => { await api.contribution(state.pendingContribution ?? state.contributionLevel); await refresh(); }));
bind('funnel-apply', () => task('funnel-apply', async () => {
  const result = await api.funnelApply({ provider: $('funnel-provider').value, relay: $('funnel-relay').value.trim(), publicUrl: $('funnel-public-url').value.trim(), token: $('funnel-token').value, cloudflareToken: $('funnel-cloudflare-token').value });
  $('funnel-token').value = ''; $('funnel-cloudflare-token').value = ''; renderFunnel(result);
}));
bind('funnel-probe', () => task('funnel-probe', async () => { renderFunnel(await api.funnelProbe()); }));
async function runInference(job, target, privacy=$('privacy-mode').value,companion=false) {
  if (inferenceActive) throw new Error('A request is already running');
  inferenceActive = true; $('send').disabled = $('companion-send').disabled = $('companion-clear').disabled = true;
  outputNode = responseView(target);
  try {
    const receipt = await (companion?api.companionChat:api.chat)({...job,privacy,...(companion?{hardwareOnly:true}:{})});
    const detail = `Completed using ${receipt.model} on ${receipt.worker === state.pubkey ? 'your node' : short(receipt.worker)} · ${receipt.credits} credits (${receipt.promptTokens ?? 0} input + ${receipt.outputTokens ?? 0} output tokens) · ${receipt.route.settlement === 'local-self' ? 'spent and earned back' : receipt.transaction ?? (receipt.settlement === 'settle-pending' ? 'settlement pending' : 'settled')}`;
    for (const id of ['route-status', 'companion-route']) $(id).textContent = detail + (receipt.route.degraded ? ' · Below recommended tier' : '');
    outputNode.finish(); return { receipt, text: outputNode.textContent };
  } finally {
    outputNode?.finish(); outputNode = null; inferenceActive = false; $('send').disabled = $('companion-send').disabled = $('companion-clear').disabled = false; await refresh();
  }
}
bind('send', async () => {
  if (inferenceActive) return;
  const status = $('endpoint-test-status'); status.className = 'micro'; status.textContent = 'Testing endpoint…';
  $('answer').textContent = '';
  try {
    const result = await runInference({ model: 'llmesh-auto', complexity: 'simple', messages: [{ role: 'user', content: 'Reply with a short greeting to confirm inference is working.' }], maxTokens: 32 }, $('answer'));
    if (!result.text.trim()) throw new Error('The request completed without a text response');
    status.className = 'micro test-success'; status.textContent = '✓ Endpoint working · response received and request completed';
  } catch (e) { status.className = 'micro test-failure'; status.textContent = '✕ Test failed: ' + e.message; throw e; }
});
bind('test-browser',()=>task('test-browser',async()=>{
  await refresh();const device=state.browserDevices.find(device=>device.free>0),status=$('browser-test-status');
  if(!device){status.className='micro test-failure';status.textContent='No ready browser worker is connected. Discovered sessions are not worker connections. Load the phone model, keep its tab visible, and wait for READY.';return;}
  status.className='micro';status.textContent='Streaming a test from '+device.name+'…';$('browser-test-answer').textContent='';
  try{const result=await runInference({model:device.model,instanceId:device.id,messages:[{role:'user',content:'Reply with a short greeting to confirm this browser worker is working.'}],maxTokens:32},$('browser-test-answer'),'allow-third-party');if(!result.text.trim())throw new Error('No text response');status.className='micro test-success';status.textContent='✓ Browser worker streamed a response · '+result.receipt.model;}
  catch(cause){status.className='micro test-failure';status.textContent='✕ '+cause.message;throw cause;}
}));
bind('cancel', () => api.cancel());
api.onDelta(text => { if (typeof text === 'string') outputNode?.appendData(text); });
api.onProgress(item => { $('setup').textContent = item.status ?? ''; $('progress').value = item.total ? item.completed / item.total * 100 : 0; });
bind('energy-save', async () => { renderEnergy(await api.energy({ rate: Number($('energy-rate').value), currency: $('energy-currency').value.toUpperCase(),
  estimatedWatts: Number($('energy-watts').value), hostWatts: Number($('energy-host').value), wallWatts: $('energy-wall').value ? Number($('energy-wall').value) : null })); $('energy-note').textContent = 'Electricity settings saved. New charges use this rate.'; });
bind('energy-scan', () => task('energy-scan', async () => { const energy = await api.scanPower(); renderEnergy(energy); if (energy.suggestedWatts) { $('energy-watts').value = energy.suggestedWatts; $('energy-note').textContent = `Suggested fallback ${energy.suggestedWatts} W from GPU power limit plus host overhead. Save to apply; this is an estimate.`; } }));
bind('wallet-connect', () => task('wallet-connect', async () => { renderPayments(await api.connectPayments({ rpc: $('wallet-rpc').value.trim(), chainId: Number($('wallet-chain').value), token: $('wallet-token').value.trim(), escrow: $('wallet-escrow').value.trim(), coordinatorApi: $('wallet-coordinator').value.trim() })); }));
bind('wallet-refresh', () => task('wallet-refresh', async () => renderPayments(await api.refreshPayments())));
bind('wallet-register', () => task('wallet-register', async () => renderPayments(await api.registerTokens())));
bind('wallet-refund', () => task('wallet-refund', async () => { const transaction = await api.refundPayment($('wallet-refund-id').value.trim()); $('wallet-status').textContent = 'Refund confirmed: ' + transaction; }));

bind('companion-stop', () => api.cancel());
bind('companion-clear', async () => {
  if (inferenceActive || !store) return;
  await store.set('companion-history', []); companionHistory = [];
  $('companion-history').replaceChildren(); $('companion-prompt').value = '';
  $('companion-route').textContent = 'Chat cleared. Your next message starts a new hardware-only conversation.';
});
bind('companion-send', async () => {
  const prompt = $('companion-prompt').value.trim(); if (!prompt || inferenceActive) return;
  const messages = [...companionHistory.map(message=>message.role==='assistant'?{...message,content:splitThinking(message.content,true).filter(part=>!part.thought).map(part=>part.text).join('').trim()}:message), { role: 'user', content: prompt }].slice(-12);
  while (messages.length > 1 && JSON.stringify(messages).length > 12000) messages.splice(0, 2);
  const row = document.createElement('div'); row.className = 'chat-message';
  const user = document.createElement('small'); user.textContent = prompt; row.append(user); $('companion-history').append(row);
  try {
    const result = await runInference({ model: 'llmesh-auto', messages, maxTokens: 512 }, row,undefined,true);
    companionHistory = [...messages, { role: 'assistant', content: result.text }].slice(-30);
    await store.set('companion-history', companionHistory); $('companion-prompt').value = '';
  } catch (e) { const note = document.createElement('small'); note.textContent = 'Request stopped: ' + e.message; row.append(note); throw e; }
});

async function initialize() {
  renderDonations=donationControls(api); browserBridge(api); await refresh(); store = await new LocalStore().open();
  companionHistory = await store.get('companion-history') ?? [];
  for (const message of companionHistory) { const row = document.createElement('div'); row.className = 'chat-message'; if(message.role==='assistant'){const view=responseView(row);view.appendData(message.content);view.finish();}else row.textContent=message.content; $('companion-history').append(row); }
  setInterval(() => refresh().catch(error), 1500);
  const savedView = localStorage.getItem('llmesh-view'); document.querySelector(`[data-view="${['overview', 'companion', 'network', 'donations', 'energy', 'wallet', 'settings'].includes(savedView) ? savedView : 'overview'}"]`)?.click();
  document.body.dataset.ready = 'true';
}
initialize().catch(error);
