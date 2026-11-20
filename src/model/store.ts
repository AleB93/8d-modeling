import { emptyScene, isEdgeId, isNodeId, Scene, SNode } from './types';

type Listener = () => void;

/**
 * Mutable scene + snapshot-based undo. Mutations go through `update` (records history)
 * or `update(fn, false)` (live drags: call `checkpoint()` once at drag start).
 */
export class Store {
  scene: Scene = emptyScene();
  selection = new Set<string>();
  activeLayer: string;
  private past: string[] = [];
  private future: string[] = [];
  private lastKey = '';
  private lastAt = 0;
  private ls = new Set<Listener>();

  constructor() {
    this.activeLayer = this.scene.layers[0].id;
  }

  subscribe(fn: Listener) {
    this.ls.add(fn);
    return () => void this.ls.delete(fn);
  }

  emit() {
    for (const f of this.ls) f();
  }

  /** Push an undo snapshot. Calls sharing `key` within 1.2s coalesce (typing, sliders, nudges). */
  checkpoint(key?: string) {
    const now = performance.now();
    if (key && key === this.lastKey && now - this.lastAt < 1200) {
      this.lastAt = now;
      return;
    }
    this.lastKey = key ?? '';
    this.lastAt = now;
    this.past.push(JSON.stringify(this.scene));
    if (this.past.length > 200) this.past.shift();
    this.future.length = 0;
  }

  update(fn: (s: Scene) => void, record: boolean | string = true) {
    if (record) this.checkpoint(typeof record === 'string' ? record : undefined);
    fn(this.scene);
    this.emit();
  }

  /** All-or-nothing update: if `fn` throws, the scene is restored and no history entry is left. */
  transact(fn: (s: Scene) => void) {
    const before = JSON.stringify(this.scene);
    this.checkpoint();
    try {
      fn(this.scene);
    } catch (e) {
      this.scene = JSON.parse(before);
      this.past.pop();
      throw e;
    } finally {
      this.emit();
    }
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  undo() {
    const p = this.past.pop();
    if (!p) return;
    this.future.push(JSON.stringify(this.scene));
    this.load(JSON.parse(p), false);
  }

  redo() {
    const f = this.future.pop();
    if (!f) return;
    this.past.push(JSON.stringify(this.scene));
    this.load(JSON.parse(f), false);
  }

  load(scene: Scene, resetHistory = true) {
    this.scene = scene;
    if (resetHistory) {
      this.past = [];
      this.future = [];
    }
    this.lastKey = '';
    for (const id of [...this.selection]) if (!scene.nodes[id] && !scene.edges[id]) this.selection.delete(id);
    if (!scene.layers.some((l) => l.id === this.activeLayer)) this.activeLayer = scene.layers[scene.layers.length - 1].id;
    this.emit();
  }

  select(ids: Iterable<string>) {
    this.selection = new Set(ids);
    // keep the active layer in sync when everything selected lives on one layer
    const layers = new Set(this.selectedNodes.map((n) => n.layer));
    if (layers.size === 1) this.activeLayer = [...layers][0];
    this.emit();
  }

  setActiveLayer(id: string) {
    if (this.activeLayer === id) return;
    this.activeLayer = id;
    this.emit();
  }

  get selectedNodes(): SNode[] {
    const out: SNode[] = [];
    for (const id of this.selection) {
      const n = this.scene.nodes[id];
      if (n) out.push(n);
    }
    return out;
  }

  layerIndex(id: string) {
    return this.scene.layers.findIndex((l) => l.id === id);
  }

  isLayerVisible(id: string) {
    return this.scene.layers.find((l) => l.id === id)?.visible ?? false;
  }

  /** Node ids to move: the given nodes plus everything fully inside a moved zone (same layer). */
  moveSet(ids: string[]): string[] {
    const set = new Set(ids.filter(isNodeId));
    for (const id of [...set]) {
      const z = this.scene.nodes[id];
      if (!z || z.kind !== 'zone') continue;
      for (const n of Object.values(this.scene.nodes)) {
        if (n.id !== z.id && n.layer === z.layer && n.x >= z.x && n.y >= z.y && n.x + n.w <= z.x + z.w && n.y + n.h <= z.y + z.h) set.add(n.id);
      }
    }
    return [...set];
  }

  deleteSelection() {
    if (!this.selection.size) return;
    this.update((s) => {
      for (const id of this.selection) {
        if (isNodeId(id)) {
          delete s.nodes[id];
          for (const e of Object.values(s.edges)) if (e.from === id || e.to === id) delete s.edges[e.id];
        } else if (isEdgeId(id)) delete s.edges[id];
      }
    });
    this.select([]);
  }
}
