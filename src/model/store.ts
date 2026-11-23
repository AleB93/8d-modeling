import { emptyScene, isEdgeId, isNodeId, Journey, Scene, SNode } from './types';
import { findPath, journeyEnd, pruneJourneys, stepsToEdge } from './journeys';

type Listener = () => void;

/**
 * Mutable scene + snapshot-based undo. Mutations go through `update` (records history)
 * or `update(fn, false)` (live drags: call `checkpoint()` once at drag start).
 */
export class Store {
  scene: Scene = emptyScene();
  selection = new Set<string>();
  /** Layer new nodes go on; also the focused layer unless `allLayers`. */
  activeLayer: string;
  /** "All layers" mode: nothing is dimmed and layer-scoped tools act on every visible layer. */
  allLayers = false;
  /** Journey on screen: `step` -1 = the whole path, k = focus on step k. View state, not undoable. */
  journey: { id: string; step: number } | null = null;
  /** Journey being recorded by clicking boxes; `from` = first clicked node while it has no steps yet. */
  recording: { id: string; from: string | null } | null = null;
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
    this.tidyJourneys();
    this.emit();
  }

  /** Keep journeys consistent with the scene after any edit: drop dangling steps, clamp view state. */
  private tidyJourneys() {
    const s = this.scene;
    s.journeys ??= [];
    pruneJourneys(s);
    if (this.journey) {
      const j = s.journeys.find((x) => x.id === this.journey!.id);
      if (!j) this.journey = null;
      else if (this.journey.step >= j.steps.length) this.journey.step = j.steps.length ? j.steps.length - 1 : -1;
    }
    if (this.recording && !s.journeys.some((x) => x.id === this.recording!.id)) this.recording = null;
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
      this.tidyJourneys();
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
    this.tidyJourneys();
    this.emit();
  }

  select(ids: Iterable<string>) {
    this.selection = new Set(ids);
    // keep the active layer in sync when everything selected lives on one layer
    const layers = new Set(this.selectedNodes.map((n) => n.layer));
    if (layers.size === 1) this.activeLayer = [...layers][0];
    this.emit();
  }

  /** Change the insertion layer without leaving "All layers" mode. */
  setActiveLayer(id: string) {
    if (this.activeLayer === id) return;
    this.activeLayer = id;
    this.emit();
  }

  /** Focus one layer (dims the others), leaving "All layers" mode. */
  focusLayer(id: string) {
    if (this.activeLayer === id && !this.allLayers) return;
    this.activeLayer = id;
    this.allLayers = false;
    this.emit();
  }

  setAllLayers(on: boolean) {
    if (this.allLayers === on) return;
    this.allLayers = on;
    this.emit();
  }

  /** True if `layer` is in focus: the active layer, or any layer in "All layers" mode. */
  inFocus(layer: string) {
    return this.allLayers || layer === this.activeLayer;
  }

  // ---------- journeys ----------
  journeyById(id: string | undefined | null): Journey | undefined {
    return id ? this.scene.journeys.find((j) => j.id === id) : undefined;
  }

  get activeJourney(): Journey | undefined {
    return this.journeyById(this.journey?.id);
  }

  /** Show a journey (step -1 = whole path) or hide journeys (null). */
  setJourney(id: string | null, step = -1) {
    const j = this.journeyById(id);
    const next = j ? { id: j.id, step: Math.max(-1, Math.min(step, j.steps.length - 1)) } : null;
    if (next?.id === this.journey?.id && next?.step === this.journey?.step) return;
    this.journey = next;
    if (this.recording && this.recording.id !== next?.id) this.recording = null;
    this.emit();
  }

  startRecording(id: string) {
    if (!this.journeyById(id)) return;
    this.recording = { id, from: null };
    this.journey = { id, step: -1 };
    this.emit();
  }

  stopRecording() {
    if (!this.recording) return;
    this.recording = null;
    this.emit();
  }

  /** Node where the next recorded hop starts (null until the first box is clicked). */
  get recordingHead(): string | null {
    const r = this.recording;
    const j = this.journeyById(r?.id);
    if (!r || !j) return null;
    return journeyEnd(this.scene, j) ?? r.from;
  }

  /** Recording click on a node: extend the journey to it along existing connections. Returns an error message or null. */
  recordNode(nodeId: string): string | null {
    const r = this.recording;
    const j = this.journeyById(r?.id);
    if (!r || !j) return null;
    const head = this.recordingHead;
    if (!head) {
      r.from = nodeId;
      this.emit();
      return null;
    }
    if (head === nodeId) return null;
    const path = findPath(this.scene, head, nodeId, new Set(j.steps.map((st) => st.edge)));
    const name = (id: string) => this.scene.nodes[id]?.label ?? '?';
    if (!path) return `“${name(head)}” and “${name(nodeId)}” aren't connected. Draw a connection first.`;
    this.update((s) => { s.journeys.find((x) => x.id === j.id)!.steps.push(...path); });
    this.journey = { id: j.id, step: -1 };
    this.emit();
    return null;
  }

  /** Recording click on a connection: walk to it if needed, then along it. */
  recordEdge(edgeId: string): string | null {
    const r = this.recording;
    const j = this.journeyById(r?.id);
    if (!r || !j) return null;
    const steps = stepsToEdge(this.scene, this.recordingHead, edgeId, new Set(j.steps.map((st) => st.edge)));
    if (!steps) return "That connection can't be reached from where the journey ends.";
    this.update((s) => { s.journeys.find((x) => x.id === j.id)!.steps.push(...steps); });
    return null;
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
