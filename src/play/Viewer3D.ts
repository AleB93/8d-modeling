import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Store } from '../model/store';
import { isNodeId, KINDS, NodeKind, SNode, Stop, uid } from '../model/types';
import { Simulation, SimResult } from '../sim/sim';
import type { View2D } from '../design/DesignCanvas';

/** World px → 3D units. */
export const S = 1 / 40;
const LAYER_GAP = 260; // world px between floors
const SEG = 24; // samples per edge curve
const MAX_PARTICLES = 30000;
const SLOTS = 60; // particle slots per edge
const MAX_LABELS = 150; // label sprites alive at once (each is a draw call + texture)
const TEX_BUDGET = 24; // label textures (re)drawn per frame
const MESH_KINDS: NodeKind[] = ['service', 'database', 'queue', 'cache', 'lb', 'client', 'zone'];

export interface ViewerHooks {
  onHover(h: { id: string; x: number; y: number } | null): void;
  onSim(r: SimResult | null): void;
}

interface EdgeGeo { id: string; pts: Float32Array; len: number; flow: boolean; color: THREE.Color; seed: number; rank: Uint8Array }
interface LabelData { key: string; title: string; sub: string; accent: string; pos: THREE.Vector3; h: number; pinned: boolean }
interface KindMesh { mesh: THREE.InstancedMesh; ids: string[] }
interface Tween { p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3; start: number; dur: number; done: () => void }
interface Drag3D {
  ids: string[];
  orig: Map<string, [number, number, number]>;
  plane: THREE.Plane;
  start: THREE.Vector3;
  sx: number; sy: number;
  started: boolean;
  height: boolean;
}

const m4 = new THREE.Matrix4();
const v3 = new THREE.Vector3();
const v3b = new THREE.Vector3();
const q4 = new THREE.Quaternion();
const col = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const RED = new THREE.Color('#ff4d4f');
const AMBER = new THREE.Color('#f59e0b');
const DEAD = new THREE.Color('#2a2f3a');
const WHITE = new THREE.Color('#ffffff');
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function unitGeometry(kind: NodeKind): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
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

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function labelTexture(title: string, sub: string, accent: string) {
  const c = document.createElement('canvas');
  const x = c.getContext('2d')!;
  const F1 = '600 30px Inter, ui-sans-serif, system-ui, sans-serif';
  const F2 = '500 22px Inter, ui-sans-serif, system-ui, sans-serif';
  x.font = F1;
  let w = x.measureText(title).width;
  if (sub) { x.font = F2; w = Math.max(w, x.measureText(sub).width); }
  const pad = 16;
  c.width = Math.ceil(w + pad * 2);
  c.height = sub ? 84 : 52;
  x.fillStyle = 'rgba(12,15,22,0.82)';
  x.beginPath();
  x.roundRect(0, 0, c.width, c.height, 12);
  x.fill();
  x.fillStyle = accent;
  x.fillRect(0, 10, 4, c.height - 20);
  x.textBaseline = 'middle';
  x.font = F1;
  x.fillStyle = '#e8ecf4';
  x.fillText(title, pad, 27);
  if (sub) { x.font = F2; x.fillStyle = '#9aa4b8'; x.fillText(sub, pad, 62); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return { tex: t, aspect: c.width / c.height, lines: sub ? 2 : 1 };
}

/** Stable pseudo-random ranking of particle slots for an edge (same id → same order across rebuilds). */
const rankCache = new Map<string, Uint8Array>();
function slotRank(id: string) {
  let r = rankCache.get(id);
  if (r) return r;
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const order = Array.from({ length: SLOTS }, (_, i) => i);
  for (let i = SLOTS - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  r = new Uint8Array(SLOTS);
  order.forEach((slot, rank) => (r![slot] = rank));
  rankCache.set(id, r);
  return r;
}

const fmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : Math.round(n).toString());

export class Viewer3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly sim = new Simulation();
  simResult: SimResult | null = null;

  private kindMeshes = new Map<NodeKind, KindMesh>();
  private geos = new Map<NodeKind, THREE.BufferGeometry>();
  private mats = new Map<NodeKind, THREE.Material>();
  private solidLines: THREE.LineSegments;
  private dashedLines: THREE.LineSegments;
  private arrows: THREE.InstancedMesh;
  private particles: THREE.Points;
  private pPos = new Float32Array(MAX_PARTICLES * 3);
  private pCol = new Float32Array(MAX_PARTICLES * 3);
  private labels = new Map<string, { sprite: THREE.Sprite; key: string }>();
  private labelData = new Map<string, LabelData>();
  private lodDirty = true;
  private lodAt = 0;
  private frustum = new THREE.Frustum();
  private labelGroup = new THREE.Group();
  private slabGroup = new THREE.Group();
  private selGroup = new THREE.Group();
  private slabGeo = new THREE.BoxGeometry(1, 1, 1);
  private slabEdges = new THREE.EdgesGeometry(this.slabGeo);
  private slabMat = new THREE.MeshStandardMaterial({ color: '#8fb3ff', transparent: true, opacity: 0.06, depthWrite: false });
  private slabLineMat = new THREE.LineBasicMaterial({ color: '#4a5d85', transparent: true, opacity: 0.6 });
  private edgeGeos: EdgeGeo[] = [];
  private sun: THREE.DirectionalLight;
  private layerY = new Map<string, number>();
  private visibleLayers = new Set<string>();

  private dirty = true;
  private needsRender = true;
  private running = false;
  private raf = 0;
  private last = 0;
  private time = 0;
  private simOn = false;
  private flowsOn = true;
  private simAcc = 0;
  private uiAcc = 0;
  private tween: Tween | null = null;
  private drag: Drag3D | null = null;
  private hoverAt: { x: number; y: number } | null = null;
  private hoverId: string | null = null;
  private down: { x: number; y: number } | null = null;
  private raycaster = new THREE.Raycaster();

  constructor(private host: HTMLElement, private store: Store, private hooks: ViewerHooks) {
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = false;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    host.appendChild(r.domElement);
    this.renderer = r;

    this.scene.background = new THREE.Color('#0b0e14');
    this.scene.fog = new THREE.Fog('#0b0e14', 80, 260);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true; // zoom where you point, never get stuck at the orbit center
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 600;
    this.controls.addEventListener('change', () => { this.needsRender = true; this.lodDirty = true; });

    this.scene.add(new THREE.HemisphereLight('#cfd8ff', '#1a1d26', 1.1));
    const sun = new THREE.DirectionalLight('#ffffff', 2.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    sun.shadow.intensity = 0.45;
    sun.shadow.radius = 3;
    this.scene.add(sun, sun.target);
    this.sun = sun;

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), new THREE.MeshStandardMaterial({ color: '#10141c', roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    const grid = new THREE.GridHelper(800, 400, '#252c3a', '#171c26');
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.7;
    this.scene.add(ground, grid);

    for (const k of MESH_KINDS) {
      this.geos.set(k, unitGeometry(k));
      this.mats.set(k, k === 'zone'
        ? new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.22, depthWrite: false, roughness: 1 })
        : new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.15 }));
      this.kindMeshes.set(k, { mesh: this.makeInstanced(k, 64), ids: [] });
    }

    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
    this.solidLines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat);
    this.dashedLines = new THREE.LineSegments(new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ vertexColors: true, dashSize: 0.35, gapSize: 0.25, transparent: true, opacity: 0.85 }));
    this.solidLines.frustumCulled = this.dashedLines.frustumCulled = false;
    const cone = new THREE.ConeGeometry(0.13, 0.36, 12);
    this.arrows = new THREE.InstancedMesh(cone, new THREE.MeshBasicMaterial({ color: '#8b97b0' }), 1024);
    this.arrows.count = 0;
    this.arrows.frustumCulled = false;

    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setDrawRange(0, 0);
    this.particles = new THREE.Points(pg, new THREE.PointsMaterial({
      size: 0.5, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }));
    this.particles.frustumCulled = false;

    this.scene.add(this.solidLines, this.dashedLines, this.arrows, this.particles, this.labelGroup, this.slabGroup, this.selGroup);

    store.subscribe(() => { this.dirty = true; });
    new ResizeObserver(() => this.resize()).observe(host);
    const el = r.domElement;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointerleave', () => { this.hoverAt = null; this.setHover(null); });
    el.addEventListener('dblclick', this.onDbl);
  }

  private makeInstanced(kind: NodeKind, cap: number) {
    const m = new THREE.InstancedMesh(this.geos.get(kind)!, this.mats.get(kind)!, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, WHITE);
    m.count = 0;
    m.castShadow = kind !== 'zone';
    m.receiveShadow = true;
    m.userData.kind = kind;
    this.scene.add(m);
    return m;
  }

  // ---------- lifecycle ----------
  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.setHover(null);
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  private loop = (t: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    let need = this.needsRender;
    if (this.dirty) { this.rebuild(); need = true; }
    if (this.tween) { this.stepTween(t); need = true; this.lodDirty = true; }
    else if (this.controls.update()) need = true;

    if (this.simOn) {
      this.simAcc += dt;
      this.uiAcc += dt;
      if (this.simAcc >= 0.1) {
        this.simResult = this.sim.step(this.store.scene, this.simAcc, this.visibleLayers);
        this.simAcc = 0;
        this.applyColors();
        need = true;
      }
      if (this.uiAcc >= 0.4) {
        this.uiAcc = 0;
        this.buildLabels();
        this.hooks.onSim(this.simResult);
      }
    }
    if (this.simOn || this.flowsOn) {
      this.time += dt;
      this.updateParticles();
      need = true;
    }
    if (this.hoverAt && !this.drag) {
      const id = this.pick(this.hoverAt.x, this.hoverAt.y)?.id ?? null;
      this.renderer.domElement.style.cursor = id ? 'pointer' : '';
      this.setHover(id, this.hoverAt.x, this.hoverAt.y);
      this.hoverAt = null;
    }
    if (this.lodDirty && t - this.lodAt > 66) {
      this.lodAt = t;
      this.updateLabelLOD();
      need = true;
    }
    if (need) {
      this.fitDepth();
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  };

  /** Scale fog and the far plane with zoom so huge scenes stay visible and small ones keep depth cues. */
  private fitDepth() {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = dist * 1.3 + 20;
    fog.far = dist * 4 + 120;
    const far = Math.max(1000, dist * 8);
    if (this.camera.far !== far) {
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  setFlows(on: boolean) {
    this.flowsOn = on;
    if (!on && !this.simOn) this.particles.geometry.setDrawRange(0, 0);
    this.needsRender = true;
  }

  setSim(on: boolean) {
    this.simOn = on;
    if (on) {
      this.sim.reset();
      this.simAcc = 1;
      this.uiAcc = 1;
    } else {
      this.simResult = null;
      this.hooks.onSim(null);
      if (!this.flowsOn) this.particles.geometry.setDrawRange(0, 0);
    }
    this.dirty = true;
  }

  // ---------- scene build ----------
  private nodeBase(n: SNode) {
    return this.layerY.get(n.layer) ?? 0;
  }

  private rebuild() {
    this.dirty = false;
    const sc = this.store.scene;
    this.layerY.clear();
    this.visibleLayers.clear();
    sc.layers.forEach((l, i) => {
      this.layerY.set(l.id, i * LAYER_GAP * S);
      if (l.visible) this.visibleLayers.add(l.id);
    });

    const groups = new Map<NodeKind, SNode[]>(MESH_KINDS.map((k) => [k, []]));
    const bb = new THREE.Box3();
    for (const n of Object.values(sc.nodes)) {
      if (!this.visibleLayers.has(n.layer)) continue;
      groups.get(n.kind)?.push(n);
      const y = this.nodeBase(n);
      bb.expandByPoint(v3.set(n.x * S, y, n.y * S));
      bb.expandByPoint(v3.set((n.x + n.w) * S, y + n.height * S, (n.y + n.h) * S));
    }

    for (const [kind, list] of groups) {
      let km = this.kindMeshes.get(kind)!;
      if (list.length > km.mesh.instanceMatrix.count) {
        this.scene.remove(km.mesh);
        km.mesh.dispose();
        km = { mesh: this.makeInstanced(kind, Math.max(64, 2 ** Math.ceil(Math.log2(list.length)))), ids: [] };
        this.kindMeshes.set(kind, km);
      }
      km.ids = list.map((n) => n.id);
      list.forEach((n, i) => {
        const base = this.nodeBase(n);
        const h = kind === 'zone' ? 0.05 : Math.max(2, n.height) * S;
        m4.compose(v3.set((n.x + n.w / 2) * S, base + (kind === 'zone' ? 0.01 : 0), (n.y + n.h / 2) * S), q4.identity(), v3b.set(n.w * S, h, n.h * S));
        km.mesh.setMatrixAt(i, m4);
      });
      km.mesh.count = list.length;
      km.mesh.instanceMatrix.needsUpdate = true;
      km.mesh.computeBoundingSphere();
      km.mesh.computeBoundingBox();
    }
    this.applyColors();
    this.buildEdges();
    this.buildLabels();
    this.buildSlabs();
    this.buildSelection();

    if (!bb.isEmpty() && !this.drag?.started) {
      const c = bb.getCenter(new THREE.Vector3());
      const r = Math.max(10, bb.getSize(v3).length() * 0.6);
      this.sun.position.set(c.x + r * 0.5, c.y + r * 1.2, c.z + r * 0.7);
      this.sun.target.position.copy(c);
      const cam = this.sun.shadow.camera;
      cam.left = cam.bottom = -r;
      cam.right = cam.top = r;
      cam.near = 0.5;
      cam.far = r * 4;
      cam.updateProjectionMatrix();
    }
    this.renderer.shadowMap.needsUpdate = true;
    this.needsRender = true;
  }

  private nodeColor(n: SNode, out: THREE.Color) {
    out.set(n.color);
    if (n.down) return out.copy(DEAD);
    const st = this.simResult?.nodes.get(n.id);
    if (!st) return out;
    const u = n.kind === 'queue' ? Math.max(st.util, st.backlog > 0 ? 0.9 + Math.min(0.3, st.backlog / (n.capacity * 60)) : 0) : st.util;
    if (u > 0.7) out.lerp(AMBER, Math.min(1, (u - 0.7) / 0.2));
    if (u > 0.9) out.lerp(RED, Math.min(1, (u - 0.9) / 0.2));
    if (st.err > 0.01 && u <= 0.9) out.lerp(RED, Math.min(0.45, st.err));
    return out;
  }

  private applyColors() {
    const sc = this.store.scene;
    for (const [, km] of this.kindMeshes) {
      km.ids.forEach((id, i) => {
        const n = sc.nodes[id];
        if (n) km.mesh.setColorAt(i, this.nodeColor(n, col));
      });
      if (km.mesh.instanceColor) km.mesh.instanceColor.needsUpdate = true;
    }
    this.needsRender = true;
  }

  private buildEdges() {
    const sc = this.store.scene;
    const solid: number[] = [], solidC: number[] = [], dashed: number[] = [], dashedC: number[] = [];
    this.edgeGeos = [];
    let ai = 0;
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), mid = new THREE.Vector3();
    const curve = new THREE.QuadraticBezierCurve3(p0, mid, p1);
    for (const e of Object.values(sc.edges)) {
      const a = sc.nodes[e.from], b = sc.nodes[e.to];
      if (!a || !b || !this.visibleLayers.has(a.layer) || !this.visibleLayers.has(b.layer)) continue;
      p0.set((a.x + a.w / 2) * S, this.nodeBase(a) + a.height * S * 0.5, (a.y + a.h / 2) * S);
      p1.set((b.x + b.w / 2) * S, this.nodeBase(b) + b.height * S * 0.5, (b.y + b.h / 2) * S);
      const d = p0.distanceTo(p1);
      mid.lerpVectors(p0, p1, 0.5);
      mid.y = Math.max(p0.y, p1.y) + 0.6 + d * 0.18;
      const pts = new Float32Array((SEG + 1) * 3);
      for (let i = 0; i <= SEG; i++) {
        curve.getPoint(i / SEG, v3);
        pts[i * 3] = v3.x; pts[i * 3 + 1] = v3.y; pts[i * 3 + 2] = v3.z;
      }
      const lineCol = new THREE.Color(a.color).lerp(new THREE.Color('#6b7790'), 0.55);
      const arr = e.dashed ? dashed : solid, carr = e.dashed ? dashedC : solidC;
      for (let i = 0; i < SEG; i++) {
        arr.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], pts[i * 3 + 3], pts[i * 3 + 4], pts[i * 3 + 5]);
        carr.push(lineCol.r, lineCol.g, lineCol.b, lineCol.r, lineCol.g, lineCol.b);
      }
      const len = curve.getLength();
      this.edgeGeos.push({
        id: e.id, pts, len, flow: e.flow, seed: (this.edgeGeos.length * 2654435761) >>> 0, rank: slotRank(e.id),
        color: new THREE.Color(a.color).lerp(WHITE, 0.35),
      });
      // arrowhead just outside the target
      if (ai < this.arrows.instanceMatrix.count) {
        const ta = Math.max(0.5, Math.min(0.97, 1 - (Math.max(b.w, b.h) * S * 0.5 + 0.3) / len));
        curve.getPoint(ta, v3);
        curve.getTangent(ta, v3b);
        q4.setFromUnitVectors(UP, v3b.normalize());
        m4.compose(v3, q4, v3b.set(1, 1, 1));
        this.arrows.setMatrixAt(ai++, m4);
      }
    }
    this.arrows.count = ai;
    this.arrows.instanceMatrix.needsUpdate = true;

    const setGeo = (obj: THREE.LineSegments, p: number[], c: number[]) => {
      obj.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
      obj.geometry = g;
    };
    setGeo(this.solidLines, solid, solidC);
    setGeo(this.dashedLines, dashed, dashedC);
    this.dashedLines.computeLineDistances();
  }

  private updateParticles() {
    const P = this.pPos, C = this.pCol;
    const sim = this.simOn ? this.simResult : null;
    let i = 0;
    for (const eg of this.edgeGeos) {
      let n: number, errF = 0;
      if (sim) {
        const f = sim.edges.get(eg.id);
        if (!f || f.rps <= 0.01) continue;
        n = Math.min(SLOTS, Math.max(1, Math.round(Math.sqrt(f.rps) * 0.8)));
        errF = f.err;
      } else {
        if (!eg.flow) continue;
        n = Math.min(24, Math.max(2, Math.round(eg.len / 1.4)));
      }
      // Each edge has SLOTS fixed, evenly phased slots; a stable per-edge ranking decides which n are lit.
      // When n changes, dots appear/disappear in place; none jump to new positions.
      const speed = 3.2 / eg.len;
      const base = this.time * speed;
      for (let k = 0; k < SLOTS && i < MAX_PARTICLES; k++) {
        if (eg.rank[k] >= n) continue;
        const t = (k / SLOTS + base) % 1;
        const f = t * SEG;
        const j = Math.min(SEG - 1, f | 0);
        const fr = f - j;
        const a = j * 3, b = a + 3, o = i * 3;
        P[o] = eg.pts[a] + (eg.pts[b] - eg.pts[a]) * fr;
        P[o + 1] = eg.pts[a + 1] + (eg.pts[b + 1] - eg.pts[a + 1]) * fr;
        P[o + 2] = eg.pts[a + 2] + (eg.pts[b + 2] - eg.pts[a + 2]) * fr;
        const h = (((k + 1) * 2654435761) ^ eg.seed) >>> 0;
        const c = errF > 0 && (h % 1000) / 1000 < errF ? RED : eg.color;
        C[o] = c.r; C[o + 1] = c.g; C[o + 2] = c.b;
        i++;
      }
    }
    const g = this.particles.geometry;
    g.setDrawRange(0, i);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }

  /**
   * Compute what every label should say and where (cheap, no GPU work). Sprites are only created for
   * the labels `updateLabelLOD` picks, so large scenes keep a bounded number of draw calls/textures.
   */
  private buildLabels() {
    const sc = this.store.scene;
    const seen = new Set<string>();
    const put = (id: string, title: string, sub: string, accent: string, x: number, y: number, z: number, worldH: number, pinned: boolean) => {
      seen.add(id);
      const key = title + '\u0000' + sub + '\u0000' + accent;
      const d = this.labelData.get(id);
      if (d) {
        d.key = key; d.title = title; d.sub = sub; d.accent = accent; d.pos.set(x, y, z); d.h = worldH; d.pinned = pinned;
      } else this.labelData.set(id, { key, title, sub, accent, pos: new THREE.Vector3(x, y, z), h: worldH, pinned });
    };

    for (const n of Object.values(sc.nodes)) {
      if (!this.visibleLayers.has(n.layer)) continue;
      const base = this.nodeBase(n);
      const sel = this.store.selection.has(n.id);
      if (n.kind === 'zone') {
        put(n.id, n.label, '', n.color, (n.x + 70) * S, base + 0.1, (n.y + 10) * S, 0.45, sel);
        continue;
      }
      if (n.kind === 'text') {
        put(n.id, n.label.split('\n')[0], '', n.color, (n.x + n.w / 2) * S, base + 0.3, (n.y + n.h / 2) * S, 0.6, sel);
        continue;
      }
      let sub = '';
      const st = this.simOn ? this.simResult?.nodes.get(n.id) : undefined;
      if (n.down) sub = 'DOWN';
      else if (st) {
        if (n.kind === 'client') sub = `${fmt(st.inRps)} rps · ${Math.round(st.lat)}ms · ${(st.err * 100).toFixed(1)}% err`;
        else {
          sub = `${fmt(st.inRps)} rps · ${Math.round(st.util * 100)}%`;
          if (n.kind === 'queue' && st.backlog > 1) sub += ` · ${fmt(st.backlog)} queued`;
          else if (st.drop > 0.001) sub += ` · ${(st.drop * 100).toFixed(0)}% drop`;
        }
      }
      put(n.id, n.label, sub, n.color, (n.x + n.w / 2) * S, base + n.height * S + 0.25, (n.y + n.h / 2) * S, 0.6, sel);
    }
    const byLayer = new Map<string, [number, number]>();
    for (const n of Object.values(sc.nodes)) {
      const m = byLayer.get(n.layer);
      if (!m) byLayer.set(n.layer, [n.x, n.y]);
      else { m[0] = Math.min(m[0], n.x); m[1] = Math.min(m[1], n.y); }
    }
    sc.layers.forEach((l, i) => {
      const m = byLayer.get(l.id);
      if (!l.visible || !m) return;
      put('L:' + l.id, l.name, '', '#6ea8ff', (m[0] - 60) * S + 1.2, i * LAYER_GAP * S + 0.05, (m[1] - 60) * S, 0.5, true);
    });
    for (const id of this.labelData.keys()) if (!seen.has(id)) this.labelData.delete(id);
    // move live sprites right away so labels never trail a dragged node
    for (const [id, l] of this.labels) {
      const d = this.labelData.get(id);
      if (d) l.sprite.position.copy(d.pos);
    }
    this.lodDirty = true;
  }

  /** Show the nearest on-screen labels (plus pinned ones), creating at most TEX_BUDGET textures per frame. */
  private updateLabelLOD() {
    this.camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(m4.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const cam = this.camera.position;
    const cand: { id: string; d: number }[] = [];
    for (const [id, l] of this.labelData) {
      if (l.pinned) cand.push({ id, d: -1 });
      else if (this.frustum.containsPoint(l.pos)) cand.push({ id, d: l.pos.distanceToSquared(cam) });
    }
    cand.sort((a, b) => a.d - b.d);
    const want = new Set<string>();
    for (let i = 0; i < cand.length && want.size < MAX_LABELS; i++) want.add(cand[i].id);

    for (const [id, l] of this.labels) {
      if (want.has(id)) continue;
      (l.sprite.material as THREE.SpriteMaterial).map?.dispose();
      l.sprite.material.dispose();
      this.labelGroup.remove(l.sprite);
      this.labels.delete(id);
    }
    let budget = TEX_BUDGET;
    let more = false;
    for (const id of want) {
      const d = this.labelData.get(id)!;
      let l = this.labels.get(id);
      if (!l || l.key !== d.key) {
        if (budget-- <= 0) { more = true; continue; }
        const { tex, aspect, lines } = labelTexture(d.title, d.sub, d.accent);
        if (l) {
          const mat = l.sprite.material as THREE.SpriteMaterial;
          mat.map?.dispose();
          mat.map = tex;
          mat.needsUpdate = true;
        } else {
          l = { sprite: new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })), key: d.key };
          l.sprite.center.set(0.5, 0);
          l.sprite.renderOrder = 10;
          this.labelGroup.add(l.sprite);
          this.labels.set(id, l);
        }
        l.key = d.key;
        const h = d.h * (lines === 2 ? 1.6 : 1);
        l.sprite.scale.set(h * aspect, h, 1);
      }
      l.sprite.position.copy(d.pos);
    }
    this.lodDirty = more;
    this.needsRender = true;
  }

  /** Translucent glass floor under every elevated layer. */
  private buildSlabs() {
    this.slabGroup.clear();
    const sc = this.store.scene;
    sc.layers.forEach((l, i) => {
      if (!l.visible || i === 0) return;
      const ns = Object.values(sc.nodes).filter((n) => n.layer === l.id);
      if (!ns.length) return;
      const pad = 60;
      const x0 = Math.min(...ns.map((n) => n.x)) - pad, z0 = Math.min(...ns.map((n) => n.y)) - pad;
      const x1 = Math.max(...ns.map((n) => n.x + n.w)) + pad, z1 = Math.max(...ns.map((n) => n.y + n.h)) + pad;
      const y = i * LAYER_GAP * S - 0.06;
      const mesh = new THREE.Mesh(this.slabGeo, this.slabMat);
      const line = new THREE.LineSegments(this.slabEdges, this.slabLineMat);
      for (const o of [mesh, line]) {
        o.position.set(((x0 + x1) / 2) * S, y, ((z0 + z1) / 2) * S);
        o.scale.set((x1 - x0) * S, 0.08, (z1 - z0) * S);
        o.renderOrder = -1;
        this.slabGroup.add(o);
      }
    });
  }

  private buildSelection() {
    for (const c of this.selGroup.children) (c as THREE.Box3Helper).geometry.dispose();
    this.selGroup.clear();
    const sc = this.store.scene;
    let k = 0;
    for (const id of this.store.selection) {
      const n = sc.nodes[id];
      if (!n || !this.visibleLayers.has(n.layer) || k++ > 64) continue;
      const base = this.nodeBase(n);
      const p = 0.08;
      const box = new THREE.Box3(
        new THREE.Vector3(n.x * S - p, base - p, n.y * S - p),
        new THREE.Vector3((n.x + n.w) * S + p, base + Math.max(2, n.height) * S + p, (n.y + n.h) * S + p),
      );
      this.selGroup.add(new THREE.Box3Helper(box, new THREE.Color('#6ea8ff')));
    }
  }

  // ---------- picking & interaction ----------
  private pick(cx: number, cy: number): { id: string; point: THREE.Vector3 } | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.kindMeshes.values()].map((k) => k.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    let zoneHit: { id: string; point: THREE.Vector3 } | null = null;
    for (const h of hits) {
      if (h.instanceId == null) continue;
      const kind = h.object.userData.kind as NodeKind;
      const id = this.kindMeshes.get(kind)!.ids[h.instanceId];
      if (!id) continue;
      if (kind !== 'zone') return { id, point: h.point };
      zoneHit ??= { id, point: h.point };
    }
    return zoneHit;
  }

  private setHover(id: string | null, x = 0, y = 0) {
    if (id === this.hoverId && !id) return;
    this.hoverId = id;
    this.hooks.onHover(id ? { id, x, y } : null);
  }

  private onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
    if (e.button !== 0 || this.tween) return;
    const hit = this.pick(e.clientX, e.clientY);
    if (!hit) return;
    const st = this.store;
    if (e.shiftKey) {
      const next = new Set(st.selection);
      next.has(hit.id) ? next.delete(hit.id) : next.add(hit.id);
      st.select(next);
      return;
    }
    if (!st.selection.has(hit.id)) st.select([hit.id]);
    const n = st.scene.nodes[hit.id];
    const ids = e.altKey ? [...st.selection].filter(isNodeId) : st.moveSet([...st.selection]);
    const base = this.nodeBase(n);
    this.drag = {
      ids,
      orig: new Map(ids.map((id) => { const m = st.scene.nodes[id]; return [id, [m.x, m.y, m.height]]; })),
      plane: new THREE.Plane(UP, -base),
      start: this.planePoint(e.clientX, e.clientY, new THREE.Plane(UP, -base)) ?? hit.point.clone(),
      sx: e.clientX, sy: e.clientY, started: false, height: e.altKey,
    };
    this.controls.enabled = false;
    this.renderer.domElement.setPointerCapture(e.pointerId);
  };

  private planePoint(cx: number, cy: number, plane: THREE.Plane) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), this.camera);
    return this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  }

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) {
      this.hoverAt = { x: e.clientX, y: e.clientY };
      return;
    }
    if (!d.started) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
      d.started = true;
      this.store.checkpoint();
      this.setHover(null);
    }
    if (d.height) {
      const dh = (d.sy - e.clientY) * 1.5;
      this.store.update((s) => {
        for (const [id, [, , h]] of d.orig) if (s.nodes[id]) s.nodes[id].height = Math.max(2, Math.min(2000, Math.round(h + dh)));
      }, false);
      return;
    }
    const p = this.planePoint(e.clientX, e.clientY, d.plane);
    if (!p) return;
    const snap = (v: number) => (e.shiftKey ? v : Math.round(v / 10) * 10);
    const dx = snap((p.x - d.start.x) / S), dz = snap((p.z - d.start.z) / S);
    this.store.update((s) => {
      for (const [id, [x, y]] of d.orig) {
        const n = s.nodes[id];
        if (n) { n.x = x + dx; n.y = y + dz; }
      }
    }, false);
  };

  private onUp = (e: PointerEvent) => {
    const wasDrag = this.drag?.started;
    this.drag = null;
    if (wasDrag) this.dirty = true; // refit shadows/bounds now that the drag is over
    this.controls.enabled = true;
    const dn = this.down;
    this.down = null;
    if (!wasDrag && dn && Math.hypot(e.clientX - dn.x, e.clientY - dn.y) < 4 && e.button === 0) {
      if (!this.pick(e.clientX, e.clientY) && this.store.selection.size) this.store.select([]);
    }
  };

  private onDbl = (e: MouseEvent) => {
    const hit = this.pick(e.clientX, e.clientY);
    if (hit) this.focusNode(hit.id);
  };

  // ---------- camera ----------
  private stepTween(t: number) {
    const tw = this.tween!;
    const k = Math.min(1, (t - tw.start) / tw.dur);
    const e = ease(k);
    this.camera.position.lerpVectors(tw.p0, tw.p1, e);
    this.controls.target.lerpVectors(tw.t0, tw.t1, e);
    this.camera.lookAt(this.controls.target);
    if (k >= 1) {
      this.tween = null;
      this.settleControls();
      tw.done();
    }
  }

  /** Re-sync OrbitControls with a camera we moved ourselves, dropping any leftover damping momentum. */
  private settleControls() {
    const damp = this.controls.enableDamping;
    this.clearMomentum();
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = damp;
    this.controls.enabled = true;
  }

  /** Drop any orbit/pan/zoom momentum OrbitControls still holds, so it can't be replayed after a flight. */
  private clearMomentum() {
    const c = this.controls as any;
    c._sphericalDelta?.set(0, 0, 0);
    c._panOffset?.set(0, 0, 0);
    if (c._scale !== undefined) c._scale = 1;
    if (c._performCursorZoom !== undefined) c._performCursorZoom = false;
  }

  flyTo(pos: THREE.Vector3, target: THREE.Vector3, dur = 900): Promise<void> {
    this.tween?.done();
    this.clearMomentum();
    return new Promise((done) => {
      this.controls.enabled = false;
      this.tween = {
        p0: this.camera.position.clone(), p1: pos.clone(),
        t0: this.controls.target.clone(), t1: target.clone(),
        start: performance.now(), dur, done,
      };
    });
  }

  focusNode(id: string) {
    const n = this.store.scene.nodes[id];
    if (!n) return;
    const t = new THREE.Vector3((n.x + n.w / 2) * S, this.nodeBase(n) + n.height * S * 0.5, (n.y + n.h / 2) * S);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = Math.max(n.w, n.h) * S * 2.5 + 5;
    this.flyTo(t.clone().addScaledVector(dir, dist), t, 700);
  }

  private topDownDistance(width: number) {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    return (width * S) / (2 * Math.tan(fov / 2) * this.camera.aspect);
  }

  /** Start from a top-down shot matching the 2D view, then tilt into perspective. */
  async enter(v: View2D) {
    this.start();
    if (this.dirty) this.rebuild();
    const d = this.topDownDistance(v.width);
    const t = new THREE.Vector3(v.cx * S, 0, v.cy * S);
    this.camera.position.set(t.x, d, t.z + d * 0.001);
    this.controls.target.copy(t);
    this.camera.lookAt(t);
    this.needsRender = true;
    // aim at the vertical middle of the stack, pulled back enough to see every floor
    const top = (this.store.scene.layers.length - 1) * LAYER_GAP * S;
    const lift = new THREE.Vector3(t.x, top * 0.5, t.z);
    const k = Math.max(d, top * 2.2) * 1.15;
    await this.flyTo(new THREE.Vector3(t.x + k * 0.3, top * 0.5 + k * 0.62, t.z + k * 0.78), lift, 1000);
  }

  /** Tilt back to top-down and report the matching 2D view. */
  async leave(): Promise<View2D> {
    const t = this.controls.target.clone();
    const d = Math.max(5, this.camera.position.distanceTo(t));
    const flat = new THREE.Vector3(t.x, 0, t.z);
    await this.flyTo(new THREE.Vector3(t.x, d, t.z + d * 0.001), flat, 600);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const width = (2 * d * Math.tan(fov / 2) * this.camera.aspect) / S;
    this.stop();
    return { cx: t.x / S, cy: t.z / S, width };
  }

  captureStop(name: string): Stop {
    return {
      id: uid('s'), name,
      pos: this.camera.position.toArray() as [number, number, number],
      target: this.controls.target.toArray() as [number, number, number],
    };
  }

  goTo(s: Stop) {
    return this.flyTo(new THREE.Vector3(...s.pos), new THREE.Vector3(...s.target), 1200);
  }

  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  kindName(id: string) {
    const n = this.store.scene.nodes[id];
    return n ? KINDS[n.kind].name : '';
  }
}
