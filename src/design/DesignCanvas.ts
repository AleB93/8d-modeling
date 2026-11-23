import type { Store } from '../model/store';
import { isNodeId, Journey, KINDS, makeEdge, makeNode, NodeKind, SEdge, SNode, uid } from '../model/types';
import { journeyEdges, journeyNodes, tokenAt } from '../model/journeys';
import { bounds, cxOf, cyOf, distToSeg, edgeEnds } from '../model/geom';

export type Tool = 'select' | 'hand' | 'arrow' | NodeKind;

export interface DesignHooks {
  onTool(t: Tool): void;
  onEditLabel(id: string): void;
  /** Short user-facing message (e.g. a journey hop that can't be recorded). */
  onToast?(msg: string): void;
}

export interface View2D { cx: number; cy: number; width: number }

type Drag =
  | { t: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { t: 'move'; wx: number; wy: number; sx: number; sy: number; orig: Map<string, [number, number]>; started: boolean }
  | { t: 'resize'; id: string; hx: -1 | 1; hy: -1 | 1; orig: SNode; started: boolean }
  | { t: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: Set<string> }
  | { t: 'create'; kind: NodeKind; x0: number; y0: number; x1: number; y1: number }
  | { t: 'arrow'; from: string; x: number; y: number; over: string | null };

const C = {
  bg: '#0f1218',
  grid: '#1a1f29',
  gridMajor: '#212734',
  text: '#e5e9f0',
  dim: '#8b93a7',
  sel: '#6ea8ff',
  edge: '#6b7790',
  guide: '#ff5ca8',
};
const FONT = '600 14px Inter, ui-sans-serif, system-ui, sans-serif';
const TEXT_SIZE = 20;
const GRID = 10;

const KIND_KEYS: Record<string, Tool> = {
  v: 'select', '1': 'select', h: 'hand', a: 'arrow', s: 'service', d: 'database', q: 'queue',
  k: 'cache', l: 'lb', c: 'client', z: 'zone', t: 'text',
};

export class DesignCanvas {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  view = { x: -200, y: -150, z: 1 };
  tool: Tool = 'select';
  active = true;
  private drag: Drag | null = null;
  private guides: { x: number[]; y: number[] } = { x: [], y: [] };
  private space = false;
  private raf = 0;
  private clip: { nodes: SNode[]; edges: SEdge[] } | null = null;
  private measure = document.createElement('canvas').getContext('2d')!;

  constructor(public canvas: HTMLCanvasElement, private store: Store, private hooks: DesignHooks) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    store.subscribe(() => this.invalidate());
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDbl);
    this.resize();
  }

  // ---------- view ----------
  private resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.invalidate();
  }

  invalidate() {
    if (!this.raf && this.active) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  setActive(a: boolean) {
    this.active = a;
    if (a) { this.resize(); this.invalidate(); }
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [sx / this.view.z + this.view.x, sy / this.view.z + this.view.y];
  }

  getView(): View2D {
    return { cx: this.view.x + this.w / 2 / this.view.z, cy: this.view.y + this.h / 2 / this.view.z, width: this.w / this.view.z };
  }

  setView(v: View2D) {
    const z = Math.max(0.1, Math.min(4, this.w / v.width));
    this.view = { z, x: v.cx - this.w / 2 / z, y: v.cy - this.h / 2 / z };
    this.invalidate();
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const [wx, wy] = this.toWorld(sx, sy);
    const z = Math.max(0.1, Math.min(4, this.view.z * factor));
    this.view = { z, x: wx - sx / z, y: wy - sy / z };
    this.invalidate();
  }

  fit() {
    const b = bounds(Object.values(this.store.scene.nodes).filter((n) => this.store.isLayerVisible(n.layer)));
    if (!b || !this.w) return;
    const z = Math.max(0.1, Math.min(2, Math.min(this.w / (b.x1 - b.x0), this.h / (b.y1 - b.y0)) * 0.8));
    this.view = { z, x: (b.x0 + b.x1) / 2 - this.w / 2 / z, y: (b.y0 + b.y1) / 2 - this.h / 2 / z };
    this.invalidate();
  }

  setTool(t: Tool) {
    this.tool = t;
    this.canvas.style.cursor = t === 'hand' ? 'grab' : t === 'select' ? 'default' : 'crosshair';
    this.hooks.onTool(t);
  }

  screenRect(n: SNode) {
    const z = this.view.z;
    return { x: (n.x - this.view.x) * z, y: (n.y - this.view.y) * z, w: n.w * z, h: n.h * z, z };
  }

  /** Size a text node to fit its content. */
  textSize(label: string): [number, number] {
    this.measure.font = `500 ${TEXT_SIZE}px Inter, ui-sans-serif, system-ui, sans-serif`;
    const lines = label.split('\n');
    const w = Math.max(...lines.map((l) => this.measure.measureText(l).width));
    return [Math.ceil(w) + 8, lines.length * TEXT_SIZE * 1.25 + 4];
  }

  // ---------- hit testing ----------
  private visibleNodes(): SNode[] {
    return Object.values(this.store.scene.nodes).filter((n) => this.store.isLayerVisible(n.layer));
  }

  /** Topmost node at a world point. Active layer wins; zones only hit on their border/title. */
  hitNode(wx: number, wy: number, excludeZones = false): SNode | null {
    const tol = 6 / this.view.z;
    const nodes = this.visibleNodes();
    let best: SNode | null = null;
    let bestScore = -1;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (wx < n.x - tol || wy < n.y - tol || wx > n.x + n.w + tol || wy > n.y + n.h + tol) continue;
      let score: number;
      if (n.kind === 'zone') {
        if (excludeZones) continue;
        const border = wx < n.x + tol || wx > n.x + n.w - tol || wy < n.y + tol || wy > n.y + n.h - tol || wy < n.y + 32;
        if (!border) continue;
        score = 1;
      } else score = 2;
      if (!this.store.allLayers && n.layer === this.store.activeLayer) score += 10;
      if (score > bestScore) { best = n; bestScore = score; }
    }
    return best;
  }

  private hitEdge(wx: number, wy: number): SEdge | null {
    const tol = 6 / this.view.z;
    const s = this.store.scene;
    for (const e of Object.values(s.edges)) {
      const a = s.nodes[e.from], b = s.nodes[e.to];
      if (!a || !b || !this.store.isLayerVisible(a.layer) || !this.store.isLayerVisible(b.layer)) continue;
      const [x1, y1, x2, y2] = edgeEnds(a, b);
      if (distToSeg(wx, wy, x1, y1, x2, y2) < tol) return e;
    }
    return null;
  }

  private hitHandle(sx: number, sy: number): { hx: -1 | 1; hy: -1 | 1 } | null {
    const sel = this.store.selectedNodes;
    if (sel.length !== 1 || sel[0].kind === 'text') return null;
    const r = this.screenRect(sel[0]);
    for (const hx of [-1, 1] as const) for (const hy of [-1, 1] as const) {
      const px = hx < 0 ? r.x : r.x + r.w, py = hy < 0 ? r.y : r.y + r.h;
      if (Math.abs(sx - px) < 7 && Math.abs(sy - py) < 7) return { hx, hy };
    }
    return null;
  }

  // ---------- pointer ----------
  private onDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    const [wx, wy] = this.toWorld(e.offsetX, e.offsetY);
    if (e.button === 1 || this.tool === 'hand' || this.space) {
      this.drag = { t: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y };
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;

    if (this.store.recording) {
      // recording a journey: click boxes (or connections) in order; drag empty space to pan
      const node = this.hitNode(wx, wy, true);
      const edge = node ? null : this.hitEdge(wx, wy);
      const err = node && node.kind !== 'text' ? this.store.recordNode(node.id) : edge ? this.store.recordEdge(edge.id) : undefined;
      if (err) this.hooks.onToast?.(err);
      if (err === undefined) {
        this.drag = { t: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y };
        this.canvas.style.cursor = 'grabbing';
      }
      return;
    }

    if (this.tool === 'arrow') {
      const n = this.hitNode(wx, wy);
      if (n && n.kind !== 'text') this.drag = { t: 'arrow', from: n.id, x: wx, y: wy, over: null };
      return;
    }
    if (this.tool !== 'select') {
      this.drag = { t: 'create', kind: this.tool, x0: wx, y0: wy, x1: wx, y1: wy };
      return;
    }

    const handle = this.hitHandle(e.offsetX, e.offsetY);
    if (handle) {
      const n = this.store.selectedNodes[0];
      this.drag = { t: 'resize', id: n.id, ...handle, orig: { ...n }, started: false };
      return;
    }

    const node = this.hitNode(wx, wy);
    const hit = node ?? this.hitEdge(wx, wy);
    const sel = this.store.selection;
    if (hit) {
      if (node && node.layer !== this.store.activeLayer) this.store.setActiveLayer(node.layer);
      if (e.shiftKey) {
        const next = new Set(sel);
        next.has(hit.id) ? next.delete(hit.id) : next.add(hit.id);
        this.store.select(next);
      } else if (!sel.has(hit.id)) this.store.select([hit.id]);
      const ids = this.store.moveSet([...this.store.selection]);
      if (ids.length) {
        const orig = new Map(ids.map((id) => [id, [this.store.scene.nodes[id].x, this.store.scene.nodes[id].y] as [number, number]]));
        this.drag = { t: 'move', wx, wy, sx: e.clientX, sy: e.clientY, orig, started: false };
      }
    } else {
      if (!e.shiftKey && sel.size) this.store.select([]);
      this.drag = { t: 'marquee', x0: wx, y0: wy, x1: wx, y1: wy, base: e.shiftKey ? new Set(sel) : new Set() };
    }
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    const [wx, wy] = this.toWorld(e.offsetX, e.offsetY);
    if (!d) {
      if (this.store.recording && !this.space) {
        this.canvas.style.cursor = this.hitNode(wx, wy, true) || this.hitEdge(wx, wy) ? 'pointer' : 'grab';
      } else if (this.tool === 'select' && !this.space) {
        const h = this.hitHandle(e.offsetX, e.offsetY);
        this.canvas.style.cursor = h ? (h.hx === h.hy ? 'nwse-resize' : 'nesw-resize') : this.hitNode(wx, wy) ? 'move' : 'default';
      }
      return;
    }
    switch (d.t) {
      case 'pan':
        this.view.x = d.vx - (e.clientX - d.sx) / this.view.z;
        this.view.y = d.vy - (e.clientY - d.sy) / this.view.z;
        break;
      case 'move': {
        if (!d.started) {
          if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
          d.started = true;
          this.store.checkpoint();
        }
        let dx = wx - d.wx, dy = wy - d.wy;
        [dx, dy] = this.snapMove(d.orig, dx, dy, e.altKey);
        this.store.update((s) => {
          for (const [id, [ox, oy]] of d.orig) {
            const n = s.nodes[id];
            if (n) { n.x = ox + dx; n.y = oy + dy; }
          }
        }, false);
        return;
      }
      case 'resize': {
        if (!d.started) { d.started = true; this.store.checkpoint(); }
        const o = d.orig;
        const ax = d.hx < 0 ? o.x + o.w : o.x, ay = d.hy < 0 ? o.y + o.h : o.y; // anchor = opposite corner
        const px = e.altKey ? wx : Math.round(wx / GRID) * GRID, py = e.altKey ? wy : Math.round(wy / GRID) * GRID;
        const w = Math.max(20, d.hx < 0 ? ax - px : px - ax), h = Math.max(20, d.hy < 0 ? ay - py : py - ay);
        this.store.update((s) => {
          const n = s.nodes[d.id];
          if (!n) return;
          n.w = w; n.h = h;
          n.x = d.hx < 0 ? ax - w : ax;
          n.y = d.hy < 0 ? ay - h : ay;
        }, false);
        return;
      }
      case 'marquee':
      case 'create':
        d.x1 = wx; d.y1 = wy;
        break;
      case 'arrow': {
        d.x = wx; d.y = wy;
        const n = this.hitNode(wx, wy, true);
        d.over = n && n.id !== d.from && n.kind !== 'text' ? n.id : null;
        break;
      }
    }
    this.invalidate();
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    this.guides = { x: [], y: [] };
    if (!d) return;
    const s = this.store;
    switch (d.t) {
      case 'pan':
        this.setTool(this.tool);
        break;
      case 'marquee': {
        const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
        if (x1 - x0 > 2 || y1 - y0 > 2) {
          const ids = new Set(d.base);
          for (const n of this.visibleNodes()) {
            if (s.inFocus(n.layer) && n.x >= x0 && n.y >= y0 && n.x + n.w <= x1 && n.y + n.h <= y1) ids.add(n.id);
          }
          for (const e of Object.values(s.scene.edges)) if (ids.has(e.from) && ids.has(e.to)) ids.add(e.id);
          s.select(ids);
        }
        break;
      }
      case 'create': {
        const def = KINDS[d.kind];
        const sz = Math.abs(d.x1 - d.x0) * this.view.z > 6 || Math.abs(d.y1 - d.y0) * this.view.z > 6;
        const snap = (v: number) => (e.altKey ? v : Math.round(v / GRID) * GRID);
        let x: number, y: number, w = def.w, h = def.h;
        if (sz && d.kind !== 'text') {
          x = snap(Math.min(d.x0, d.x1)); y = snap(Math.min(d.y0, d.y1));
          w = Math.max(20, snap(Math.abs(d.x1 - d.x0))); h = Math.max(20, snap(Math.abs(d.y1 - d.y0)));
        } else {
          x = snap(d.x0 - w / 2); y = snap(d.y0 - h / 2);
        }
        const n = makeNode(d.kind, x, y, s.activeLayer, { w, h });
        s.update((sc) => {
          if (n.kind === 'zone') {
            // zones go to the back so they never cover nodes
            sc.nodes = { [n.id]: n, ...sc.nodes };
          } else sc.nodes[n.id] = n;
        });
        s.select([n.id]);
        this.setTool('select');
        if (n.kind === 'text') this.hooks.onEditLabel(n.id);
        break;
      }
      case 'arrow':
        if (d.over) {
          const exists = Object.values(s.scene.edges).some((x) => x.from === d.from && x.to === d.over);
          if (!exists) {
            const edge = makeEdge(d.from, d.over);
            s.update((sc) => { sc.edges[edge.id] = edge; });
            s.select([edge.id]);
          }
        }
        break;
    }
    this.invalidate();
  };

  /** Alignment guides against other nodes, falling back to grid snap. Alt disables snapping. */
  private snapMove(orig: Map<string, [number, number]>, dx: number, dy: number, free: boolean): [number, number] {
    this.guides = { x: [], y: [] };
    if (free) return [dx, dy];
    const sc = this.store.scene;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [id, [ox, oy]] of orig) {
      const n = sc.nodes[id];
      x0 = Math.min(x0, ox + dx); y0 = Math.min(y0, oy + dy);
      x1 = Math.max(x1, ox + dx + n.w); y1 = Math.max(y1, oy + dy + n.h);
    }
    const tol = 6 / this.view.z;
    const xs = [x0, (x0 + x1) / 2, x1], ys = [y0, (y0 + y1) / 2, y1];
    let bx: number | null = null, by: number | null = null, bdx = tol, bdy = tol;
    const vx0 = this.view.x, vy0 = this.view.y, vx1 = vx0 + this.w / this.view.z, vy1 = vy0 + this.h / this.view.z;
    for (const n of this.visibleNodes()) {
      if (orig.has(n.id) || !this.store.inFocus(n.layer)) continue;
      if (n.x > vx1 || n.y > vy1 || n.x + n.w < vx0 || n.y + n.h < vy0) continue;
      for (const t of [n.x, n.x + n.w / 2, n.x + n.w]) for (const v of xs) {
        const dd = Math.abs(t - v);
        if (dd < bdx) { bdx = dd; bx = t - v; }
      }
      for (const t of [n.y, n.y + n.h / 2, n.y + n.h]) for (const v of ys) {
        const dd = Math.abs(t - v);
        if (dd < bdy) { bdy = dd; by = t - v; }
      }
    }
    const [fx0, fy0] = orig.values().next().value!;
    const ndx = bx !== null ? dx + bx : Math.round((fx0 + dx) / GRID) * GRID - fx0;
    const ndy = by !== null ? dy + by : Math.round((fy0 + dy) / GRID) * GRID - fy0;
    if (bx !== null) this.guides.x = xs.map((v) => v + bx!).filter((v, i, a) => a.indexOf(v) === i);
    if (by !== null) this.guides.y = ys.map((v) => v + by!).filter((v, i, a) => a.indexOf(v) === i);
    // keep only guides that actually align with some other node
    return [ndx, ndy];
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // Mouse wheels send line-mode or large integer vertical-only deltas; trackpads send small/fractional
    // pixel deltas (often with deltaX). Mouse wheel → zoom; trackpad two-finger → pan; pinch (ctrlKey) → zoom.
    const lineMode = e.deltaMode === 1;
    const mouseWheel = lineMode || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
    if (e.ctrlKey || e.metaKey || mouseWheel) {
      const d = lineMode ? e.deltaY * 33 : e.deltaY;
      const step = Math.sign(d) * Math.min(Math.abs(d), mouseWheel ? 25 : 40); // ≤ ~1.3× per event: smooth, no jumps
      this.zoomAt(e.offsetX, e.offsetY, Math.exp(-step * 0.01));
    } else {
      this.view.x += e.deltaX / this.view.z;
      this.view.y += e.deltaY / this.view.z;
      this.invalidate();
    }
  };

  private onDbl = (e: MouseEvent) => {
    if (this.store.recording) return;
    const [wx, wy] = this.toWorld(e.offsetX, e.offsetY);
    const n = this.hitNode(wx, wy);
    if (n) {
      this.store.select([n.id]);
      this.hooks.onEditLabel(n.id);
      return;
    }
    const t = makeNode('text', Math.round(wx), Math.round(wy - 12), this.store.activeLayer);
    this.store.update((s) => { s.nodes[t.id] = t; });
    this.store.select([t.id]);
    this.hooks.onEditLabel(t.id);
  };

  // ---------- keyboard ----------
  /** Returns true when the key was handled. */
  onKey(e: KeyboardEvent): boolean {
    const s = this.store;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.key === ' ') {
      if (!this.space) { this.space = true; this.canvas.style.cursor = 'grab'; }
      return true;
    }
    if (mod) {
      if (k === 'z') { e.shiftKey ? s.redo() : s.undo(); return true; }
      if (k === 'y') { s.redo(); return true; }
      if (k === 'c' || k === 'x') { this.copy(); if (k === 'x') s.deleteSelection(); return true; }
      if (k === 'v') { this.paste(); return true; }
      if (k === 'd') { this.copy(); this.paste(); return true; }
      if (k === 'a') {
        const ids = this.visibleNodes().filter((n) => s.inFocus(n.layer)).map((n) => n.id);
        s.select(ids);
        return true;
      }
      if (k === '=' || k === '+') { this.zoomAt(this.w / 2, this.h / 2, 1.2); return true; }
      if (k === '-') { this.zoomAt(this.w / 2, this.h / 2, 1 / 1.2); return true; }
      if (k === '0') { this.setView({ ...this.getView(), width: this.w }); return true; }
      return false;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { s.deleteSelection(); return true; }
    if (e.key === 'Escape') { s.select([]); this.setTool('select'); return true; }
    if (e.key === 'Enter') {
      const sel = s.selectedNodes;
      if (sel.length === 1) { this.hooks.onEditLabel(sel[0].id); return true; }
      return false;
    }
    if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) { this.fit(); return true; }
    if (e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? GRID : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const ids = s.moveSet([...s.selection]);
      if (!ids.length) return false;
      s.update((sc) => { for (const id of ids) { sc.nodes[id].x += dx; sc.nodes[id].y += dy; } }, 'nudge');
      return true;
    }
    const t = KIND_KEYS[k];
    if (t && !e.altKey) { this.setTool(t); return true; }
    return false;
  }

  onKeyUp(e: KeyboardEvent) {
    if (e.key === ' ') { this.space = false; this.setTool(this.tool); }
  }

  copy() {
    const s = this.store.scene;
    const nodes = this.store.selectedNodes.map((n) => structuredClone(n));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = Object.values(s.edges).filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => structuredClone(e));
    if (nodes.length) this.clip = { nodes, edges };
  }

  paste() {
    const c = this.clip;
    if (!c) return;
    const map = new Map<string, string>();
    const layerOk = new Set(this.store.scene.layers.map((l) => l.id));
    const nodes = c.nodes.map((n) => {
      const id = uid('n');
      map.set(n.id, id);
      return { ...n, id, x: n.x + 30, y: n.y + 30, layer: layerOk.has(n.layer) ? n.layer : this.store.activeLayer };
    });
    const edges = c.edges.map((e) => ({ ...e, id: uid('e'), from: map.get(e.from)!, to: map.get(e.to)! }));
    this.store.update((s) => {
      for (const n of nodes) s.nodes[n.id] = n;
      for (const e of edges) s.edges[e.id] = e;
    });
    this.store.select(nodes.map((n) => n.id));
    // next paste cascades further
    this.clip = { nodes: nodes.map((n) => ({ ...n })), edges };
  }

  // ---------- rendering ----------
  private draw() {
    const { ctx, dpr, view } = this;
    const z = view.z;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    this.drawGrid();

    ctx.setTransform(dpr * z, 0, 0, dpr * z, -view.x * z * dpr, -view.y * z * dpr);
    const vx0 = view.x, vy0 = view.y, vx1 = vx0 + this.w / z, vy1 = vy0 + this.h / z;
    const inView = (n: SNode) => !(n.x > vx1 || n.y > vy1 || n.x + n.w < vx0 || n.y + n.h < vy0);
    const s = this.store.scene;
    const vis = new Set(s.layers.filter((l) => l.visible).map((l) => l.id));
    const sel = this.store.selection;

    // a shown journey takes over dimming: everything off its path fades, whatever the layer
    const J = this.store.activeJourney;
    // while recording, keep every box readable: you need to see what to click next
    const rec = !!this.store.recording;
    const jNodes = J && !rec ? journeyNodes(s, J) : null;
    const jEdges = J && !rec ? journeyEdges(J) : null;
    const dimNode = (n: SNode) => !rec && (jNodes ? !jNodes.has(n.id) : !this.store.inFocus(n.layer));

    const nodes = Object.values(s.nodes);
    for (const n of nodes) if (n.kind === 'zone' && vis.has(n.layer) && inView(n)) this.drawNode(n, dimNode(n));
    for (const e of Object.values(s.edges)) {
      const a = s.nodes[e.from], b = s.nodes[e.to];
      if (!a || !b || !vis.has(a.layer) || !vis.has(b.layer)) continue;
      this.drawEdge(e, a, b, !rec && (jEdges ? !jEdges.has(e.id) : !this.store.inFocus(a.layer) && !this.store.inFocus(b.layer)), sel.has(e.id));
    }
    for (const n of nodes) if (n.kind !== 'zone' && vis.has(n.layer) && inView(n)) this.drawNode(n, dimNode(n));
    if (J) this.drawJourney(J, this.store.journey?.step ?? -1, vis);

    // ---- overlays ----
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5 / z;
    ctx.strokeStyle = C.sel;
    ctx.setLineDash([]);
    const selNodes = this.store.selectedNodes;
    for (const n of selNodes) {
      const p = 4 / z;
      ctx.strokeRect(n.x - p, n.y - p, n.w + 2 * p, n.h + 2 * p);
    }
    if (selNodes.length === 1 && selNodes[0].kind !== 'text') {
      const n = selNodes[0];
      const hs = 8 / z;
      ctx.fillStyle = C.bg;
      for (const [px, py] of [[n.x, n.y], [n.x + n.w, n.y], [n.x, n.y + n.h], [n.x + n.w, n.y + n.h]]) {
        ctx.fillRect(px - hs / 2, py - hs / 2, hs, hs);
        ctx.strokeRect(px - hs / 2, py - hs / 2, hs, hs);
      }
    }
    const d = this.drag;
    if (d?.t === 'move' && d.started) {
      ctx.strokeStyle = C.guide;
      ctx.lineWidth = 1 / z;
      ctx.beginPath();
      for (const gx of this.guides.x) { ctx.moveTo(gx, vy0); ctx.lineTo(gx, vy1); }
      for (const gy of this.guides.y) { ctx.moveTo(vx0, gy); ctx.lineTo(vx1, gy); }
      ctx.stroke();
    }
    if (d?.t === 'marquee') {
      ctx.fillStyle = 'rgba(110,168,255,0.08)';
      ctx.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
    if (d?.t === 'create' && d.kind !== 'text') {
      ctx.setLineDash([6 / z, 4 / z]);
      ctx.strokeStyle = KINDS[d.kind].color;
      ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.setLineDash([]);
    }
    if (d?.t === 'arrow') {
      const a = s.nodes[d.from];
      const b = d.over ? s.nodes[d.over] : null;
      let x2 = d.x, y2 = d.y;
      let [x1, y1] = [cxOf(a), cyOf(a)];
      if (b) [x1, y1, x2, y2] = edgeEnds(a, b);
      if (b) {
        ctx.strokeStyle = C.sel;
        ctx.lineWidth = 2 / z;
        ctx.strokeRect(b.x - 4 / z, b.y - 4 / z, b.w + 8 / z, b.h + 8 / z);
      }
      ctx.strokeStyle = C.sel;
      ctx.lineWidth = 2 / z;
      this.arrowLine(x1, y1, x2, y2, false);
    }
  }

  /** Journey overlay: colored path with numbered steps, a token walking it, and the recording cursor. */
  private drawJourney(j: Journey, step: number, vis: Set<string>) {
    const { ctx } = this;
    const z = this.view.z;
    const s = this.store.scene;
    const fwd = new Set<string>(), bwd = new Set<string>();
    for (const st of j.steps) (st.back ? bwd : fwd).add(st.edge);
    // segment of step k in walking order; request/response on one connection sit side by side
    const seg = (k: number): [number, number, number, number] | null => {
      const st = j.steps[k];
      const e = s.edges[st.edge];
      const a = e && s.nodes[e.from], b = e && s.nodes[e.to];
      if (!a || !b || !vis.has(a.layer) || !vis.has(b.layer)) return null;
      let [x1, y1, x2, y2] = edgeEnds(a, b);
      if (st.back) [x1, y1, x2, y2] = [x2, y2, x1, y1];
      if (fwd.has(st.edge) && bwd.has(st.edge)) {
        const L = Math.hypot(x2 - x1, y2 - y1) || 1;
        const off = 7 / Math.min(1, z);
        const nx = (-(y2 - y1) / L) * off, ny = ((x2 - x1) / L) * off;
        x1 += nx; y1 += ny; x2 += nx; y2 += ny;
      }
      return [x1, y1, x2, y2];
    };
    const alpha = (k: number) => (step < 0 || k === step ? 1 : k < step ? 0.5 : 0.16);
    const segs = j.steps.map((_, k) => seg(k));

    ctx.strokeStyle = j.color;
    ctx.lineWidth = Math.max(3, 2.5 / z);
    segs.forEach((g, k) => {
      if (!g) return;
      ctx.globalAlpha = alpha(k);
      this.arrowLine(g[0], g[1], g[2], g[3], !!j.steps[k].back);
    });

    // numbered badges near each step's start (screen-constant size)
    const r = 9 / z;
    ctx.font = `700 ${11 / z}px Inter, ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    segs.forEach((g, k) => {
      if (!g) return;
      const bx = g[0] + (g[2] - g[0]) * 0.28, by = g[1] + (g[3] - g[1]) * 0.28;
      ctx.globalAlpha = alpha(k);
      ctx.fillStyle = j.color;
      ctx.beginPath();
      ctx.arc(bx, by, k === step ? r * 1.3 : r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.bg;
      ctx.fillText(String(k + 1), bx, by + 0.5 / z);
    });

    // the token: walks the whole journey, or loops the focused step
    const tk = tokenAt(j, step, performance.now());
    const g = tk && segs[tk.k];
    if (g) {
      const t = tk!.t;
      const x = g[0] + (g[2] - g[0]) * t, y = g[1] + (g[3] - g[1]) * t;
      ctx.globalAlpha = 1;
      ctx.shadowColor = j.color;
      ctx.shadowBlur = 18;
      ctx.fillStyle = j.color;
      ctx.beginPath();
      ctx.arc(x, y, 7 / z, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, 3 / z, 0, Math.PI * 2);
      ctx.fill();
    }

    // recording: pulsing ring on the box the next hop starts from
    const rec = this.store.recording;
    const head = rec?.id === j.id ? this.store.recordingHead : null;
    const hn = head ? s.nodes[head] : null;
    if (hn) {
      const pad = (6 + 3 * Math.sin(performance.now() / 180)) / z;
      ctx.globalAlpha = 1;
      ctx.strokeStyle = j.color;
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([6 / z, 4 / z]);
      ctx.strokeRect(hn.x - pad, hn.y - pad, hn.w + 2 * pad, hn.h + 2 * pad);
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
    if (j.steps.length || hn) this.invalidate(); // keep animating while a journey is on screen
  }

  private drawGrid() {
    const { ctx, view } = this;
    let step = 20;
    while (step * view.z < 10) step *= 5;
    const major = step * 5;
    const x0 = Math.floor(view.x / step) * step, y0 = Math.floor(view.y / step) * step;
    const x1 = view.x + this.w / view.z, y1 = view.y + this.h / view.z;
    for (const [color, every] of [[C.grid, step], [C.gridMajor, major]] as const) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      for (let x = Math.floor(x0 / every) * every; x <= x1; x += every) {
        const sx = Math.round((x - view.x) * view.z) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, this.h);
      }
      for (let y = Math.floor(y0 / every) * every; y <= y1; y += every) {
        const sy = Math.round((y - view.y) * view.z) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(this.w, sy);
      }
      ctx.stroke();
    }
  }

  private arrowLine(x1: number, y1: number, x2: number, y2: number, dashed: boolean) {
    const { ctx } = this;
    const z = this.view.z;
    ctx.setLineDash(dashed ? [8 / z, 6 / z] : []);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const hl = Math.max(10, 12 / z);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - hl * Math.cos(ang - 0.4), y2 - hl * Math.sin(ang - 0.4));
    ctx.lineTo(x2 - hl * Math.cos(ang + 0.4), y2 - hl * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }

  private drawEdge(e: SEdge, a: SNode, b: SNode, dim: boolean, selected: boolean) {
    const { ctx } = this;
    const [x1, y1, x2, y2] = edgeEnds(a, b);
    ctx.globalAlpha = dim ? 0.3 : 1;
    ctx.strokeStyle = selected ? C.sel : C.edge;
    ctx.lineWidth = selected ? 2.5 : 1.75;
    this.arrowLine(x1, y1, x2, y2, e.dashed);
    const label = e.label + (e.mult !== 1 ? ` ×${e.mult}` : '');
    if (label && this.view.z > 0.35) {
      ctx.font = '500 12px Inter, ui-sans-serif, system-ui, sans-serif';
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = C.bg;
      ctx.beginPath();
      ctx.roundRect(mx - tw / 2 - 6, my - 10, tw + 12, 20, 6);
      ctx.fill();
      ctx.fillStyle = C.dim;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, mx, my);
    }
  }

  private drawNode(n: SNode, dim: boolean) {
    const { ctx } = this;
    const { x, y, w, h, color } = n;
    ctx.globalAlpha = dim ? 0.3 : n.down ? 0.55 : 1;
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.fillStyle = color + '26';
    ctx.setLineDash([]);
    ctx.beginPath();
    switch (n.kind) {
      case 'service':
        ctx.roundRect(x, y, w, h, 10);
        ctx.fill(); ctx.stroke();
        break;
      case 'database': {
        const ry = Math.min(14, h * 0.16);
        ctx.ellipse(x + w / 2, y + ry, w / 2, ry, 0, Math.PI, 0);
        ctx.lineTo(x + w, y + h - ry);
        ctx.ellipse(x + w / 2, y + h - ry, w / 2, ry, 0, 0, Math.PI);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + ry, w / 2, ry, 0, 0, Math.PI);
        ctx.stroke();
        break;
      }
      case 'queue': {
        ctx.roundRect(x, y, w, h, h / 2);
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        for (let i = 1; i <= 3; i++) {
          const lx = x + w - h / 2 - i * 12;
          ctx.moveTo(lx, y + h * 0.25); ctx.lineTo(lx, y + h * 0.75);
        }
        ctx.stroke();
        break;
      }
      case 'cache': {
        const i = w / 4;
        ctx.moveTo(x + i, y); ctx.lineTo(x + w - i, y); ctx.lineTo(x + w, y + h / 2);
        ctx.lineTo(x + w - i, y + h); ctx.lineTo(x + i, y + h); ctx.lineTo(x, y + h / 2);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        break;
      }
      case 'lb':
        ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h / 2); ctx.lineTo(x + w / 2, y + h); ctx.lineTo(x, y + h / 2);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        break;
      case 'client': {
        ctx.roundRect(x, y, w, h, 8);
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y + 16); ctx.lineTo(x + w, y + 16);
        ctx.stroke();
        ctx.fillStyle = color;
        for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(x + 10 + i * 9, y + 8, 2.5, 0, 7); ctx.fill(); }
        break;
      }
      case 'zone':
        ctx.fillStyle = color + '14';
        ctx.setLineDash([10, 6]);
        ctx.roundRect(x, y, w, h, 14);
        ctx.fill(); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = FONT;
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(n.label, x + 14, y + 18);
        return;
      case 'text': {
        ctx.font = `500 ${TEXT_SIZE}px Inter, ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        n.label.split('\n').forEach((l, i) => ctx.fillText(l, x + 4, y + 2 + i * TEXT_SIZE * 1.25));
        return;
      }
    }
    if (this.view.z < 0.25) return;
    // caption + label
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cy = n.kind === 'database' ? y + h / 2 + 6 : n.kind === 'client' ? y + h / 2 + 8 : y + h / 2;
    ctx.font = '700 9px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = color;
    ctx.fillText((n.down ? 'DOWN · ' : '') + KINDS[n.kind].name.toUpperCase(), x + w / 2, cy - 11);
    ctx.font = FONT;
    ctx.fillStyle = C.text;
    ctx.fillText(n.label, x + w / 2, cy + 6, w - 12);
  }

  exportPNG(): Promise<Blob | null> {
    this.draw();
    return new Promise((r) => this.canvas.toBlob(r, 'image/png'));
  }

  /** True when a node id is visible in the editor (for label editing overlay). */
  isNodeVisible(id: string) {
    const n = this.store.scene.nodes[id];
    return !!n && isNodeId(id) && this.store.isLayerVisible(n.layer);
  }
}
