import { REVISION } from 'three';
import type { Scene } from '../model/types';

// Standalone 3D viewer: one .html file with the scene embedded. three.js loads from jsDelivr at the
// version this app ships, so the file needs a network connection to open, but nothing else.
// Mirrors Viewer3D's geometry rules (scale, floor gap, edge arcs) so the export looks like Play mode.

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function sceneToHtml(scene: Scene, title = 'Stratos scene'): string {
  const ver = `0.${REVISION.replace(/\D/g, '')}.0`;
  const data = JSON.stringify(scene).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Stratos">
<title>${esc(title)}</title>
<style>
  :root { --bg:#0b0e14; --panel:rgba(18,22,31,.92); --line:#262d3b; --fg:#e8ecf4; --muted:#9aa4b8; --accent:#5b8cff; color-scheme:dark }
  * { box-sizing:border-box }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:13px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; overflow:hidden }
  #c { position:fixed; inset:0; display:block }
  #labels { position:fixed; inset:0; pointer-events:none; overflow:hidden }
  .lbl { position:absolute; left:0; top:0; white-space:nowrap; padding:4px 9px 4px 11px; border-radius:7px; background:rgba(12,15,22,.84);
         font-weight:600; font-size:12px; color:var(--fg); border-left:3px solid var(--a); transform-origin:50% 100%; will-change:transform }
  .lbl.text { background:none; border:none; color:var(--muted); font-weight:500 }
  .lbl.zone { background:rgba(12,15,22,.6); font-weight:500; font-size:11px; color:var(--a) }
  .lbl.edge { background:rgba(12,15,22,.72); border:none; font-weight:500; font-size:10.5px; color:var(--muted); padding:2px 6px }
  body.noedge .lbl.edge { display:none }
  .panel { position:fixed; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px; backdrop-filter:blur(8px) }
  .panel h2 { margin:0 0 6px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:var(--muted) }
  #top { top:12px; left:12px; right:12px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; padding:8px 12px }
  #top b { font-size:14px }
  #top .sp { flex:1 }
  button, label.tg { font:inherit; color:var(--fg); background:#1b2130; border:1px solid var(--line); border-radius:7px; padding:5px 10px; cursor:pointer }
  button:hover, label.tg:hover { background:#232a3b }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:1px }
  button.on { background:var(--accent); border-color:var(--accent); color:#fff }
  #floors { left:12px; top:70px; min-width:180px }
  #floors label { display:flex; gap:8px; align-items:center; padding:3px 2px; cursor:pointer }
  #tour { left:12px; bottom:12px; min-width:200px; max-height:45vh; overflow:auto }
  #tour button { display:block; width:100%; text-align:left; margin-top:4px }
  #tour button span { color:var(--muted); margin-right:8px; font-variant-numeric:tabular-nums }
  #hint { position:fixed; bottom:14px; left:50%; transform:translateX(-50%); color:var(--muted); font-size:12px; pointer-events:none; text-align:center }
  #err { position:fixed; inset:0; display:none; place-items:center; text-align:center; padding:24px; color:var(--muted) }
  @media (max-width:640px) { #floors { display:none } #hint { display:none } }
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="labels"></div>
<div id="top" class="panel"><b>${esc(title)}</b><span class="sp"></span>
  <button id="flows" class="on" title="Animate traffic along connections">Flows</button>
  <button id="edgelbl" class="on" title="Show connection labels">Labels</button>
  <button id="fit" title="Frame the whole scene">Fit</button>
</div>
<div id="floors" class="panel"><h2>Floors</h2></div>
<div id="tour" class="panel" hidden><h2>Tour</h2></div>
<div id="hint">Drag to orbit · right-drag to pan · scroll to zoom · ←/→ tour stops</div>
<div id="err"><div><p>This viewer loads three.js from cdn.jsdelivr.net and needs a network connection.</p><p id="errmsg"></p></div></div>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@${ver}/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@${ver}/examples/jsm/"}}</script>
<script id="scene" type="application/json">${data}</script>
<script type="module">
const fail = (e) => { document.getElementById('err').style.display = 'grid'; document.getElementById('errmsg').textContent = String(e && e.message || e); };
try {
const THREE = await import('three');
const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
const { RoundedBoxGeometry } = await import('three/addons/geometries/RoundedBoxGeometry.js');

const S = 1 / 40, GAP = 260, SEG = 24;
const sc = JSON.parse(document.getElementById('scene').textContent);
const layerIdx = new Map(sc.layers.map((l, i) => [l.id, i]));
const baseY = (n) => (layerIdx.get(n.layer) ?? 0) * GAP * S;
const visible = new Set(sc.layers.filter((l) => l.visible !== false).map((l) => l.id));

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0b0e14');
scene.fog = new THREE.Fog('#0b0e14', 80, 260);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
const controls = new OrbitControls(camera, canvas);
Object.assign(controls, { enableDamping: true, dampingFactor: 0.12, maxPolarAngle: Math.PI * 0.495, screenSpacePanning: true, zoomToCursor: true, minDistance: 1.5, maxDistance: 600 });

scene.add(new THREE.HemisphereLight('#cfd8ff', '#1a1d26', 1.1));
const sun = new THREE.DirectionalLight('#ffffff', 2.4);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02; sun.shadow.intensity = 0.45;
scene.add(sun, sun.target);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), new THREE.MeshStandardMaterial({ color: '#10141c', roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02; ground.receiveShadow = true;
const grid = new THREE.GridHelper(800, 400, '#252c3a', '#171c26');
grid.material.transparent = true; grid.material.opacity = 0.7;
scene.add(ground, grid);

function unitGeo(kind) {
  let g;
  switch (kind) {
    case 'service': g = new RoundedBoxGeometry(1, 1, 1, 2, 0.06); break;
    case 'client': g = new RoundedBoxGeometry(1, 1, 1, 3, 0.2); break;
    case 'database': g = new THREE.CylinderGeometry(0.5, 0.5, 1, 28); break;
    case 'queue': g = new THREE.CylinderGeometry(0.5, 0.5, 1, 20); g.rotateZ(Math.PI / 2); break;
    case 'cache': g = new THREE.CylinderGeometry(0.5, 0.5, 1, 6); g.rotateY(Math.PI / 2); break;
    case 'lb': g = new THREE.CylinderGeometry(0.5, 0.5, 1, 4); break;
    default: g = new THREE.BoxGeometry(1, 1, 1);
  }
  g.translate(0, 0.5, 0);
  return g;
}
const geos = {};
const geo = (k) => (geos[k] ??= unitGeo(k));

// ---- build ----
const groups = new Map(sc.layers.map((l) => [l.id, new THREE.Group()]));
groups.forEach((g) => scene.add(g));
const labelsEl = document.getElementById('labels');
const labels = []; // { el, pos, layer, layer2 }
function addLabel(text, cls, accent, pos, layer, layer2) {
  const el = document.createElement('div');
  el.className = 'lbl ' + cls;
  el.textContent = text;
  el.style.setProperty('--a', accent);
  labelsEl.appendChild(el);
  labels.push({ el, pos, layer, layer2 });
}

const bb = new THREE.Box3();
const v = new THREE.Vector3();
for (const n of Object.values(sc.nodes)) {
  const g = groups.get(n.layer); if (!g) continue;
  const y = baseY(n);
  const cx = (n.x + n.w / 2) * S, cz = (n.y + n.h / 2) * S;
  bb.expandByPoint(v.set(n.x * S, y, n.y * S)); bb.expandByPoint(v.set((n.x + n.w) * S, y + n.height * S, (n.y + n.h) * S));
  if (n.kind === 'text') { addLabel(n.label, 'text', n.color, new THREE.Vector3(cx, y + 0.3, cz), n.layer); continue; }
  if (n.kind === 'zone') {
    const m = new THREE.Mesh(geo('zone'), new THREE.MeshStandardMaterial({ color: n.color, transparent: true, opacity: 0.22, depthWrite: false, roughness: 1 }));
    m.position.set(cx, y + 0.01, cz); m.scale.set(n.w * S, 0.05, n.h * S); m.receiveShadow = true;
    g.add(m);
    addLabel(n.label, 'zone', n.color, new THREE.Vector3((n.x + 70) * S, y + 0.1, (n.y + 10) * S), n.layer);
    continue;
  }
  const mat = new THREE.MeshStandardMaterial({ color: n.down ? '#2a2f3a' : n.color, roughness: 0.45, metalness: 0.15 });
  const m = new THREE.Mesh(geo(n.kind), mat);
  m.position.set(cx, y, cz); m.scale.set(n.w * S, Math.max(2, n.height) * S, n.h * S);
  m.castShadow = m.receiveShadow = true;
  g.add(m);
  addLabel(n.label, 'node', n.color, new THREE.Vector3(cx, y + n.height * S + 0.25, cz), n.layer);
}

// floor slabs (all floors above the ground one)
sc.layers.forEach((l, i) => {
  if (i === 0) return;
  const ns = Object.values(sc.nodes).filter((n) => n.layer === l.id);
  if (!ns.length) return;
  const pad = 60;
  const x0 = Math.min(...ns.map((n) => n.x)) - pad, z0 = Math.min(...ns.map((n) => n.y)) - pad;
  const x1 = Math.max(...ns.map((n) => n.x + n.w)) + pad, z1 = Math.max(...ns.map((n) => n.y + n.h)) + pad;
  const box = new THREE.BoxGeometry(1, 1, 1);
  const slab = new THREE.Mesh(box, new THREE.MeshStandardMaterial({ color: '#8090b0', transparent: true, opacity: 0.06, depthWrite: false }));
  const line = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: '#56607a', transparent: true, opacity: 0.6 }));
  for (const o of [slab, line]) { o.position.set(((x0 + x1) / 2) * S, i * GAP * S - 0.06, ((z0 + z1) / 2) * S); o.scale.set((x1 - x0) * S, 0.08, (z1 - z0) * S); o.renderOrder = -1; groups.get(l.id).add(o); }
});

// edges: arcs, arrowheads, flow particles
const edgeObjs = [];
const cone = new THREE.ConeGeometry(0.13, 0.36, 12);
const UP = new THREE.Vector3(0, 1, 0);
const dotTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'); const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const edgeGroup = new THREE.Group(); scene.add(edgeGroup);
for (const e of Object.values(sc.edges)) {
  const a = sc.nodes[e.from], b = sc.nodes[e.to];
  if (!a || !b) continue;
  const p0 = new THREE.Vector3((a.x + a.w / 2) * S, baseY(a) + a.height * S * 0.5, (a.y + a.h / 2) * S);
  const p1 = new THREE.Vector3((b.x + b.w / 2) * S, baseY(b) + b.height * S * 0.5, (b.y + b.h / 2) * S);
  const mid = p0.clone().lerp(p1, 0.5); mid.y = Math.max(p0.y, p1.y) + 0.6 + p0.distanceTo(p1) * 0.18;
  const curve = new THREE.QuadraticBezierCurve3(p0, mid, p1);
  const lineCol = new THREE.Color(a.color).lerp(new THREE.Color('#6b7790'), 0.55);
  const lg = new THREE.BufferGeometry().setFromPoints(curve.getPoints(SEG));
  const line = new THREE.Line(lg, e.dashed
    ? new THREE.LineDashedMaterial({ color: lineCol, dashSize: 0.35, gapSize: 0.25, transparent: true, opacity: 0.85 })
    : new THREE.LineBasicMaterial({ color: lineCol, transparent: true, opacity: 0.85 }));
  if (e.dashed) line.computeLineDistances();
  const len = curve.getLength();
  const ta = Math.max(0.5, Math.min(0.97, 1 - (Math.max(b.w, b.h) * S * 0.5 + 0.3) / len));
  const arrow = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: lineCol }));
  arrow.position.copy(curve.getPoint(ta)); arrow.quaternion.setFromUnitVectors(UP, curve.getTangent(ta).normalize());
  const count = Math.max(2, Math.min(12, Math.round(len / 2.5 * Math.min(2, e.mult || 1))));
  const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  const pts = new THREE.Points(pg, new THREE.PointsMaterial({ map: dotTex, color: new THREE.Color(a.color).lerp(new THREE.Color('#fff'), 0.35), size: 0.42, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  pts.visible = e.flow !== false;
  edgeGroup.add(line, arrow, pts);
  edgeObjs.push({ a: a.layer, b: b.layer, objs: [line, arrow, pts], pts, curve, count, speed: (e.dashed ? 0.6 : 1) * 3 / len, flow: e.flow !== false });
  if (e.label) addLabel(e.label, 'edge', a.color, curve.getPoint(0.5).add(new THREE.Vector3(0, 0.25, 0)), a.layer, b.layer);
}

// light + camera framing
const center = bb.isEmpty() ? new THREE.Vector3() : bb.getCenter(new THREE.Vector3());
const radius = bb.isEmpty() ? 10 : Math.max(10, bb.getSize(new THREE.Vector3()).length() * 0.6);
sun.position.set(center.x + radius * 0.5, center.y + radius * 1.2, center.z + radius * 0.7); sun.target.position.copy(center);
Object.assign(sun.shadow.camera, { left: -radius, bottom: -radius, right: radius, top: radius, near: 0.5, far: radius * 4 });
sun.shadow.camera.updateProjectionMatrix();
function fit() { tweenTo(center.clone().add(new THREE.Vector3(radius * 0.55, radius * 0.75, radius * 1.05)), center.clone()); }

// ---- tween ----
let tw = null;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function tweenTo(pos, target, dur = 900) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) dur = 1;
  tw = { p0: camera.position.clone(), p1: pos, t0: controls.target.clone(), t1: target, start: performance.now(), dur };
}

// ---- UI ----
const floorsEl = document.getElementById('floors');
[...sc.layers].reverse().forEach((l) => {
  const lab = document.createElement('label');
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = visible.has(l.id); cb.id = 'floor-' + l.id;
  cb.onchange = () => { cb.checked ? visible.add(l.id) : visible.delete(l.id); applyVisibility(); };
  lab.append(cb, document.createTextNode(l.name));
  floorsEl.appendChild(lab);
});
function applyVisibility() {
  groups.forEach((g, id) => (g.visible = visible.has(id)));
  for (const e of edgeObjs) { const on = visible.has(e.a) && visible.has(e.b); e.objs.forEach((o, i) => (o.visible = on && (i < 2 || (flowsOn && e.flow)))); }
}
let flowsOn = true;
const flowsBtn = document.getElementById('flows');
flowsBtn.onclick = () => { flowsOn = !flowsOn; flowsBtn.classList.toggle('on', flowsOn); applyVisibility(); };
const lblBtn = document.getElementById('edgelbl');
lblBtn.onclick = () => { const on = document.body.classList.toggle('noedge'); lblBtn.classList.toggle('on', !on); };
document.getElementById('fit').onclick = fit;

const stops = sc.stops || [];
let cur = -1;
const tourEl = document.getElementById('tour');
const stopBtns = stops.map((s, i) => {
  const b = document.createElement('button');
  b.innerHTML = '<span>' + (i + 1) + '</span>';
  b.append(document.createTextNode(s.name));
  b.onclick = () => go(i);
  tourEl.appendChild(b);
  return b;
});
if (stops.length) tourEl.hidden = false;
function go(i) {
  if (!stops.length) return;
  cur = (i + stops.length) % stops.length;
  const s = stops[cur];
  tweenTo(new THREE.Vector3(...s.pos), new THREE.Vector3(...s.target));
  stopBtns.forEach((b, j) => b.classList.toggle('on', j === cur));
}
addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') go(cur + 1);
  else if (e.key === 'ArrowLeft') go(cur - 1);
  else if (/^[1-9]$/.test(e.key)) go(+e.key - 1);
});

// ---- loop ----
function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();
const proj = new THREE.Vector3();
function frame(t) {
  if (tw) {
    const k = Math.min(1, (t - tw.start) / tw.dur), e = ease(k);
    camera.position.lerpVectors(tw.p0, tw.p1, e); controls.target.lerpVectors(tw.t0, tw.t1, e);
    if (k >= 1) tw = null;
  }
  controls.update();
  if (flowsOn) for (const e of edgeObjs) {
    if (!e.pts.visible) continue;
    const arr = e.pts.geometry.attributes.position;
    for (let i = 0; i < e.count; i++) { e.curve.getPoint(((t / 1000) * e.speed + i / e.count) % 1, proj); arr.setXYZ(i, proj.x, proj.y, proj.z); }
    arr.needsUpdate = true;
  }
  renderer.render(scene, camera);
  const w = innerWidth, h = innerHeight, camPos = camera.position;
  for (const l of labels) {
    const on = visible.has(l.layer) && (!l.layer2 || visible.has(l.layer2));
    proj.copy(l.pos).project(camera);
    const d = camPos.distanceTo(l.pos);
    if (!on || proj.z > 1 || d > 140 || Math.abs(proj.x) > 1.2 || Math.abs(proj.y) > 1.2) { l.el.style.display = 'none'; continue; }
    l.el.style.display = '';
    const s = Math.max(0.55, Math.min(1.25, 28 / d));
    l.el.style.transform = 'translate(' + ((proj.x + 1) / 2 * w) + 'px,' + ((1 - proj.y) / 2 * h) + 'px) translate(-50%,-100%) scale(' + s.toFixed(3) + ')';
    l.el.style.zIndex = String(1000 - Math.round(d));
  }
  requestAnimationFrame(frame);
}
if (stops.length) { const s = stops[0]; camera.position.set(...s.pos); controls.target.set(...s.target); cur = 0; stopBtns[0].classList.add('on'); }
else { camera.position.copy(center).add(new THREE.Vector3(radius * 0.55, radius * 0.75, radius * 1.05)); controls.target.copy(center); }
applyVisibility();
requestAnimationFrame(frame);
} catch (e) { fail(e); }
</script>
</body>
</html>
`;
}
