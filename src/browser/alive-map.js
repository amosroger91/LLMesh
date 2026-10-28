import { deviceStatus } from './serving-topology.js';
import { ObservedGraph } from './observed-graph.js';

function drawNode(context, node, point, pictures) {
  const status = deviceStatus(node);
  const radius = node.kind === 'provider' ? 17 : 25;
  context.fillStyle = status.color;
  context.beginPath();
  context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.fill();
  const profile = node.profile;
  if (profile?.avatar) {
    if (!pictures.has(profile.avatar)) {
      const image = new Image();
      image.src = profile.avatar;
      pictures.set(profile.avatar, image);
      if (pictures.size > 64) pictures.delete(pictures.keys().next().value);
    }
    const image = pictures.get(profile.avatar);
    if (image?.complete && image.naturalWidth) {
      context.save();
      context.beginPath();
      context.arc(point.x, point.y, radius - 2, 0, Math.PI * 2);
      context.clip();
      context.drawImage(image, point.x - radius + 2, point.y - radius + 2, (radius - 2) * 2, (radius - 2) * 2);
      context.restore();
    }
  }
  context.strokeStyle = profile?.ringColor ?? status.color;
  context.lineWidth = 4;
  context.beginPath();
  context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.stroke();
  context.strokeStyle = status.color;
  context.lineWidth = 2;
  context.beginPath();
  context.arc(point.x, point.y, radius + 6, 0, Math.PI * 2);
  context.stroke();
  if (node.busy) {
    const angle = Date.now() / 160;
    context.strokeStyle = '#14222d';
    context.lineWidth = 4;
    context.beginPath();
    context.arc(point.x, point.y, 10, angle, angle + 4.2);
    context.stroke();
  }
  context.fillStyle = '#c4dfed';
  context.font = '17px system-ui';
  context.textAlign = 'center';
  context.fillText(String(node.profile?.name ?? node.name ?? node.kind).slice(0, 22), point.x, point.y + 39);
  if (node.profile?.bio) {
    context.font = '12px system-ui';
    context.fillText(node.profile.bio.slice(0, 30), point.x, point.y + 59);
  }
  if (node.kind === 'provider') {
    context.font = '12px system-ui';
    context.fillText(String(node.model ?? node.state ?? '').slice(0, 25), point.x, point.y + 58);
  }
}

function layoutPhone(width, height, base, providers) {
  const positions = new Map();
  base.forEach((node, index) => {
    const angle = index / Math.max(1, base.length) * Math.PI * 2 - Math.PI / 2;
    positions.set(node.id, { x: width / 2 + Math.cos(angle) * 220, y: 460 + Math.sin(angle) * 180 });
  });
  providers.forEach((node, index) => positions.set(node.id, { x: 90 + (index % 4) * 180, y: 780 + Math.floor(index / 4) * 110 }));
  return positions;
}

function layoutDesktop(width, height, base, providers) {
  const positions = new Map();
  const rx = Math.min(width * 0.32, 420);
  const ry = Math.min(height * 0.28, 180);
  const cy = height * 0.46;
  base.forEach((node, index) => {
    const angle = index / Math.max(1, base.length) * Math.PI * 2 - Math.PI / 2;
    positions.set(node.id, { x: width / 2 + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
  });
  const columns = Math.max(1, Math.min(8, providers.length));
  providers.forEach((node, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const rowCount = Math.min(columns, providers.length - row * columns);
    const gap = Math.min(150, (width - 120) / Math.max(1, rowCount));
    positions.set(node.id, { x: width / 2 - ((rowCount - 1) * gap) / 2 + column * gap, y: height - 86 - row * 64 });
  });
  return positions;
}

export function drawAliveScene(context, { width, height, scene, pictures = new Map(), caption = {} }) {
  const portrait = height > width;
  const base = scene.nodes.filter(node => node.kind !== 'provider');
  const providers = scene.nodes.filter(node => node.kind === 'provider');
  const positions = portrait ? layoutPhone(width, height, base, providers) : layoutDesktop(width, height, base, providers);
  context.fillStyle = '#07131d';
  context.fillRect(0, 0, width, height);
  context.textAlign = 'center';
  if (portrait) {
    context.fillStyle = '#b9e657';
    context.font = '20px monospace';
    context.fillText(caption.kicker ?? '', width / 2, 80);
    context.fillStyle = '#eff8ff';
    context.font = 'bold 54px system-ui';
    context.fillText(caption.title ?? '', width / 2, 145);
  } else {
    context.fillStyle = '#b9e657';
    context.font = '13px monospace';
    context.fillText(caption.kicker ?? '', width / 2, 28);
    context.fillStyle = '#eff8ff';
    context.font = 'bold 34px system-ui';
    context.fillText(caption.title ?? '', width / 2, 68);
  }
  context.lineWidth = 2;
  for (const edge of scene.edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    context.strokeStyle = String(edge.to).includes(':provider-') ? '#715422' : '#17465b';
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  }
  for (const pulse of scene.pulses ?? []) {
    const from = positions.get(pulse.from);
    const to = positions.get(pulse.to);
    if (!from || !to) continue;
    const fraction = Math.min(1, (Date.now() - pulse.started) / 1400);
    context.fillStyle = pulse.direction === 'request' ? '#00d4ff' : '#b9e657';
    context.beginPath();
    context.arc(from.x + (to.x - from.x) * fraction, from.y + (to.y - from.y) * fraction, 7, 0, Math.PI * 2);
    context.fill();
  }
  for (const node of scene.nodes) {
    const point = positions.get(node.id);
    if (point) drawNode(context, node, point, pictures);
  }
  context.textAlign = 'center';
  if (portrait) {
    context.fillStyle = '#f3b955';
    context.font = '17px system-ui';
    context.fillText(caption.legend ?? '', width / 2, 1015);
    context.fillStyle = '#eff8ff';
    context.font = 'bold 28px system-ui';
    context.fillText(caption.status ?? '', width / 2, 1080);
    context.fillStyle = '#94adbf';
    context.font = '20px system-ui';
    context.fillText(caption.detail ?? '', width / 2, 1120);
    context.font = '16px system-ui';
    for (const [index, note] of (caption.notes ?? []).entries()) context.fillText(note, width / 2, 1160 + index * 30);
  } else {
    context.fillStyle = '#f3b955';
    context.font = '13px system-ui';
    context.fillText(caption.legend ?? '', width / 2, height - 36);
    context.fillStyle = '#94adbf';
    context.font = '13px system-ui';
    context.fillText([caption.status, caption.detail, ...(caption.notes ?? [])].filter(Boolean).join('  ·  '), width / 2, height - 16);
  }
}

export function mountAliveMap(container, getFrame) {
  const canvas = document.createElement('canvas');
  canvas.className = 'alive-map';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Living mesh map');
  container.replaceChildren(canvas);
  const pictures = new Map();
  const graph = new ObservedGraph();
  const frame = () => {
    const view = container.closest('.view');
    if (view?.classList.contains('hidden')) return;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth || 900;
    const height = canvas.clientHeight || 560;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const input = getFrame(graph) ?? { scene: { nodes: [], edges: [], pulses: [], visitors: 0 } };
    drawAliveScene(context, { width, height, scene: input.scene, pictures, caption: input.caption });
    canvas.dataset.drawn = '1';
  };
  const timer = setInterval(frame, 250);
  frame();
  return { frame, stop() { clearInterval(timer); } };
}
