import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from './store';
import { addPage, deletePage, layerPages, pageLayers, pagesOf } from './pages';
import { emptyScene, isEdgeId, isNodeId, makeEdge, makeNode, NodeKind, Scene } from './types';

let now = 0;
beforeEach(() => {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

/** mulberry32: tiny seeded PRNG so randomized tests are deterministic. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const json = (st: Store) => JSON.stringify(st.scene);
const nodeCount = (st: Store) => Object.keys(st.scene.nodes).length;
function addNode(st: Store, over: Parameters<typeof makeNode>[4] = {}, layer = st.activeLayer) {
  const n = makeNode('service', 0, 0, layer, over);
  st.update((s) => { s.nodes[n.id] = n; });
  return n;
}
function rename(st: Store, name: string, key?: string) {
  st.update((s) => { s.layers[0].name = name; }, key ?? true);
}

/** A store with two pages: page 1 (ground + top), page 2 "Ops" (one floor). */
function twoPageStore() {
  const st = new Store();
  const p1 = st.scene.pages![0].id;
  const ground = st.scene.layers[0].id;
  let p2 = '', opsLayer = '';
  st.update((s) => {
    s.layers.push({ id: 'l_top', name: 'Top', visible: true, page: p1 });
    const r = addPage(s, 'Ops');
    p2 = r.page.id;
    opsLayer = r.layer.id;
  });
  return { st, p1, p2, ground, top: 'l_top', opsLayer };
}

// ------------------------------------------------------------------ history

describe('hunt: undo/redo sequences', () => {
  it('undo N then redo N returns byte-identical JSON at every step', () => {
    const st = new Store();
    const states = [json(st)];
    for (let i = 0; i < 20; i++) {
      addNode(st, { label: 'n' + i });
      states.push(json(st));
    }
    for (let i = 19; i >= 0; i--) {
      st.undo();
      expect(json(st)).toBe(states[i]);
    }
    for (let i = 1; i <= 20; i++) {
      st.redo();
      expect(json(st)).toBe(states[i]);
    }
    expect(st.canRedo).toBe(false);
  });

  it('undo/redo with empty stacks are no-ops and do not emit', () => {
    const st = new Store();
    const fn = vi.fn();
    st.subscribe(fn);
    const before = json(st);
    st.undo();
    st.redo();
    expect(json(st)).toBe(before);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a new change after undo clears redo, and redo then does nothing', () => {
    const st = new Store();
    rename(st, 'A');
    rename(st, 'B');
    st.undo();
    rename(st, 'C');
    expect(st.canRedo).toBe(false);
    st.redo();
    expect(st.scene.layers[0].name).toBe('C');
    st.undo();
    expect(st.scene.layers[0].name).toBe('A');
  });

  it('load() with history reset clears both stacks even after undo', () => {
    const st = new Store();
    rename(st, 'A');
    rename(st, 'B');
    st.undo();
    st.load(emptyScene());
    expect(st.canUndo).toBe(false);
    expect(st.canRedo).toBe(false);
  });

  it('load(scene, false) keeps undo so loading can be undone', () => {
    const st = new Store();
    rename(st, 'A');
    const mid = json(st);
    st.checkpoint();
    st.load(emptyScene(), false);
    st.undo();
    expect(json(st)).toBe(mid);
  });

  it('undo after a coalesced burst returns to the state before the burst', () => {
    const st = new Store();
    const start = json(st);
    for (let i = 0; i < 10; i++) {
      now += 500; // within 1.2s of the previous one
      rename(st, 'x'.repeat(i + 1), 'label');
    }
    st.undo();
    expect(json(st)).toBe(start);
    expect(st.canUndo).toBe(false);
  });

  it('coalescing is broken by an undo (load resets the key)', () => {
    const st = new Store();
    rename(st, 'a', 'k');
    now += 100;
    rename(st, 'ab', 'k');
    st.undo(); // back to Ground
    now += 100;
    rename(st, 'z', 'k');
    expect(st.canUndo).toBe(true);
    st.undo();
    expect(st.scene.layers[0].name).toBe('Ground');
  });

  it('coalescing is broken by an unkeyed checkpoint in between', () => {
    const st = new Store();
    rename(st, 'a', 'k');
    now += 100;
    rename(st, 'b');
    now += 100;
    rename(st, 'c', 'k');
    st.undo();
    expect(st.scene.layers[0].name).toBe('b');
  });

  it('the history cap keeps the newest 200 states and undo walks them in order', () => {
    const st = new Store();
    for (let i = 1; i <= 250; i++) rename(st, String(i));
    for (let i = 249; i >= 50; i--) {
      st.undo();
      expect(st.scene.layers[0].name).toBe(String(i));
    }
    expect(st.canUndo).toBe(false);
  });

  it('undo replaces the scene object: references held before undo are stale', () => {
    // Documented behaviour of snapshot undo; recorded so callers know not to cache `store.scene`.
    const st = new Store();
    const held = st.scene;
    addNode(st);
    st.undo();
    expect(st.scene).not.toBe(held);
  });
});

describe('hunt: transact', () => {
  it('a throwing transact leaves the scene JSON and undo depth exactly as before', () => {
    const st = new Store();
    addNode(st);
    const before = json(st);
    const depth = st.undoDepth;
    expect(() => st.transact((s) => { s.nodes = {}; s.layers.push({ id: 'lx', name: 'x', visible: true }); throw new Error('boom'); })).toThrow('boom');
    expect(json(st)).toBe(before);
    expect(st.undoDepth).toBe(depth);
    st.undo();
    expect(nodeCount(st)).toBe(0);
  });

  it('a throwing transact does not destroy the redo stack', () => {
    // BUG: transact() calls checkpoint() before running fn; checkpoint clears `future`. On failure transact
    // pops the past entry but never restores `future`, so a failed (no-op) transact silently wipes redo.
    // Expected: "no history entry is left" -> redo still available. Actual: canRedo is false.
    const st = new Store();
    rename(st, 'A');
    st.undo();
    expect(st.canRedo).toBe(true);
    expect(() => st.transact(() => { throw new Error('nope'); })).toThrow();
    expect(st.canRedo).toBe(true);
  });

  it('a throwing transact at the history cap does not drop the oldest undo entry', () => {
    // BUG: at 200 entries checkpoint() pushes then shift()s the oldest; the failure path only pop()s the
    // new one, so the oldest undo state is permanently lost even though "nothing happened".
    const st = new Store();
    for (let i = 1; i <= 200; i++) rename(st, String(i));
    expect(() => st.transact(() => { throw new Error('x'); })).toThrow();
    let n = 0;
    while (st.canUndo) { st.undo(); n++; }
    expect(n).toBe(200);
    expect(st.scene.layers[0].name).toBe('Ground');
  });

  it('a successful transact clears redo like any other change', () => {
    const st = new Store();
    rename(st, 'A');
    st.undo();
    st.transact((s) => { s.layers[0].name = 'T'; });
    expect(st.canRedo).toBe(false);
  });

  it('a throwing transact still emits and keeps selection of surviving ids', () => {
    const st = new Store();
    const n = addNode(st);
    st.select([n.id]);
    const fn = vi.fn();
    st.subscribe(fn);
    expect(() => st.transact((s) => { delete s.nodes[n.id]; throw new Error('x'); })).toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(st.scene.nodes[n.id]).toBeTruthy();
    expect(st.selection.has(n.id)).toBe(true);
  });

  it('a throwing transact restores journeys and view state consistently', () => {
    const st = new Store();
    const a = addNode(st), b = addNode(st);
    const e = makeEdge(a.id, b.id);
    st.update((s) => { s.edges[e.id] = e; s.journeys.push({ id: 'j', name: 'J', color: '#fff', steps: [{ edge: e.id }] }); });
    st.setJourney('j', 0);
    expect(() => st.transact((s) => { delete s.edges[e.id]; throw new Error('x'); })).toThrow();
    expect(st.scene.journeys[0].steps).toHaveLength(1);
    expect(st.journey).toEqual({ id: 'j', step: 0 });
  });
});

describe('hunt: historyMark / squash / rollback', () => {
  it('squash then undo then redo round-trips the whole group', () => {
    const st = new Store();
    const mark = st.historyMark();
    const before = json(st);
    addNode(st); addNode(st); addNode(st);
    const after = json(st);
    st.squash(mark);
    st.undo();
    expect(json(st)).toBe(before);
    st.redo();
    expect(json(st)).toBe(after);
  });

  it('rollback after nothing changed is a no-op on the scene', () => {
    const st = new Store();
    addNode(st);
    const mark = st.historyMark();
    const before = json(st);
    const depth = st.undoDepth;
    st.rollback(mark);
    expect(json(st)).toBe(before);
    expect(st.undoDepth).toBe(depth);
  });

  it('squash of a group that spans the history cap leaves no mid-group states in undo', () => {
    // BUG: historyMark() is an index into `past`, but checkpoint() shift()s the array once it exceeds 200,
    // so the mark no longer points at the same entry. squash() then truncates at the stale index and keeps
    // some of the group's intermediate snapshots: one undo reaches `before`, the next lands mid-group.
    const st = new Store();
    for (let i = 1; i <= 150; i++) rename(st, 'pre' + i);
    const mark = st.historyMark(); // 150
    for (let i = 1; i <= 100; i++) rename(st, 'grp' + i);
    st.squash(mark);
    st.undo();
    expect(st.scene.layers[0].name).toBe('pre150');
    st.undo();
    expect(st.scene.layers[0].name).toBe('pre149'); // actual: 'grp50' (a state from inside the group)
  });

  it('squash at a full history still merges the group into one undo step', () => {
    // BUG: with past already at 200 entries, historyMark() is 200 and stays 200 (shift keeps the length),
    // so squash() sees past.length <= mark and returns without merging anything.
    const st = new Store();
    for (let i = 1; i <= 200; i++) rename(st, 'pre' + i);
    const mark = st.historyMark();
    rename(st, 'g1'); rename(st, 'g2'); rename(st, 'g3');
    st.squash(mark);
    st.undo();
    expect(st.scene.layers[0].name).toBe('pre200'); // actual: 'g2'
  });

  it('rollback at a full history drops every entry the group added', () => {
    // BUG: same stale-mark issue: rollback keeps past.length = 200 entries, including the group's snapshots,
    // so after rolling back, Ctrl+Z steps into states the rollback was supposed to throw away.
    const st = new Store();
    for (let i = 1; i <= 200; i++) rename(st, 'pre' + i);
    const mark = st.historyMark();
    const before = json(st);
    rename(st, 'g1'); rename(st, 'g2');
    st.rollback(mark);
    expect(json(st)).toBe(before);
    st.undo();
    expect(st.scene.layers[0].name).toBe('pre199'); // actual: 'g1'
  });

  it('nested batches: inner squash then outer squash still undo as one step', () => {
    const st = new Store();
    const m0 = st.historyMark();
    addNode(st);
    const m1 = st.historyMark();
    addNode(st); addNode(st);
    st.squash(m1);
    addNode(st);
    st.squash(m0);
    expect(nodeCount(st)).toBe(4);
    st.undo();
    expect(nodeCount(st)).toBe(0);
    expect(st.canUndo).toBe(false);
  });

  it('squash and rollback inside a group that used transact failure keep a consistent mark', () => {
    const st = new Store();
    const mark = st.historyMark(), before = json(st);
    addNode(st);
    expect(() => st.transact(() => { throw new Error('x'); })).toThrow();
    addNode(st);
    st.rollback(mark);
    expect(json(st)).toBe(before);
    expect(st.canUndo).toBe(false);
  });
});

// ------------------------------------------------------------------ layers / load

describe('hunt: active layer validity', () => {
  it('undo of adding a layer that is active moves the active layer to an existing one', () => {
    const st = new Store();
    st.update((s) => { s.layers.push({ id: 'l_new', name: 'New', visible: true, page: s.pages![0].id }); });
    st.setActiveLayer('l_new');
    st.undo();
    expect(st.scene.layers.some((l) => l.id === st.activeLayer)).toBe(true);
  });

  it('redo/undo ping-pong never leaves a dangling active layer', () => {
    const st = new Store();
    st.update((s) => { s.layers.push({ id: 'l_a', name: 'A', visible: true, page: s.pages![0].id }); });
    st.setActiveLayer('l_a');
    st.update((s) => { s.layers.push({ id: 'l_b', name: 'B', visible: true, page: s.pages![0].id }); });
    st.setActiveLayer('l_b');
    for (let i = 0; i < 3; i++) {
      st.undo(); st.undo();
      expect(st.scene.layers.map((l) => l.id)).toContain(st.activeLayer);
      st.redo(); st.redo();
      expect(st.scene.layers.map((l) => l.id)).toContain(st.activeLayer);
    }
  });

  it('deleting the open page then opening the first page leaves a valid active layer', () => {
    // BUG: store.ts openPage() returns early when `pageId === this.activePage`. After deletePage() removed the
    // active layer, activePage falls back to the first page, so openPage(firstPage) — exactly what
    // LayersPanel.removePage and the agent's page delete do — is a no-op and activeLayer keeps pointing at a
    // deleted layer. New boxes then get created on a non-existent layer.
    const { st, p1, p2, opsLayer } = twoPageStore();
    st.openPage(p2);
    expect(st.activeLayer).toBe(opsLayer);
    st.update((s) => { deletePage(s, p2); });
    st.openPage(pagesOf(st.scene)[0].id);
    expect(st.activePage).toBe(p1);
    expect(st.scene.layers.map((l) => l.id)).toContain(st.activeLayer);
  });

  it('load picks the top layer when the active one is gone and selection is pruned to existing ids', () => {
    const st = new Store();
    const n = addNode(st);
    st.select([n.id, 'e_ghost', 'n_ghost']);
    const s2 = emptyScene();
    s2.layers.push({ id: 'l_up', name: 'Up', visible: true, page: s2.pages![0].id });
    st.load(s2);
    expect(st.activeLayer).toBe('l_up');
    expect(st.selection.size).toBe(0);
  });
});

// ------------------------------------------------------------------ pages / canvas

describe('hunt: openPage / onCanvas', () => {
  it('openPage on an unknown or empty page does nothing', () => {
    const { st, ground } = twoPageStore();
    const fn = vi.fn();
    st.subscribe(fn);
    st.openPage('p_nope');
    expect(st.activeLayer).toBe(ground);
    expect(fn).not.toHaveBeenCalled();
  });

  it('openPage drops selected nodes and edges from other pages, keeps those on the target page', () => {
    const { st, p1, p2, ground, opsLayer } = twoPageStore();
    const a = addNode(st, {}, ground), b = addNode(st, {}, ground);
    const c = addNode(st, {}, opsLayer);
    const e1 = makeEdge(a.id, b.id);
    st.update((s) => { s.edges[e1.id] = e1; });
    st.selection = new Set([a.id, e1.id, c.id]);
    st.openPage(p2);
    expect([...st.selection]).toEqual([c.id]);
    st.selection = new Set([a.id, e1.id, c.id]);
    st.openPage(p1);
    expect(new Set(st.selection)).toEqual(new Set([a.id, e1.id]));
  });

  it('onCanvas reflects visibility changes made through update', () => {
    const { st, ground, top } = twoPageStore();
    expect(st.onCanvas(ground)).toBe(true);
    st.update((s) => { s.layers.find((l) => l.id === ground)!.visible = false; });
    expect(st.onCanvas(ground)).toBe(false);
    expect(st.onCanvas(top)).toBe(true);
  });

  it('onCanvas shows every page whatever page is open, through openPage, setActiveLayer, undo and load', () => {
    const { st, p1, p2, ground, opsLayer } = twoPageStore();
    expect(st.onCanvas(opsLayer)).toBe(true);
    st.openPage(p2);
    expect(st.onCanvas(opsLayer)).toBe(true);
    expect(st.onCanvas(ground)).toBe(true);
    st.setActiveLayer(ground);
    expect(st.onCanvas(ground)).toBe(true);
    expect(st.onCanvas(opsLayer)).toBe(true);
    st.undo(); // removes page 2 (the addPage update)
    expect(st.activePage).toBe(p1);
    expect(st.onCanvas(opsLayer)).toBe(false); // gone with its page
    expect(st.onCanvas(ground)).toBe(true);
    st.load(emptyScene());
    expect(st.onCanvas(ground)).toBe(false);
    expect(st.onCanvas(st.activeLayer)).toBe(true);
  });

  it('onCanvas keeps both pages when a journey jumps to another page', () => {
    const { st, opsLayer, ground } = twoPageStore();
    const a = addNode(st, {}, opsLayer), b = addNode(st, {}, opsLayer);
    const e = makeEdge(a.id, b.id);
    st.update((s) => { s.edges[e.id] = e; s.journeys.push({ id: 'j', name: 'J', color: '#fff', steps: [{ edge: e.id }] }); });
    st.setJourney('j');
    expect(st.activeLayer).toBe(opsLayer);
    expect(st.onCanvas(opsLayer)).toBe(true);
    expect(st.onCanvas(ground)).toBe(true);
  });

  it('onCanvas hides a hidden floor on any page, open or not', () => {
    const { st, opsLayer, ground } = twoPageStore();
    st.update((s) => { s.layers.find((l) => l.id === opsLayer)!.visible = false; });
    expect(st.onCanvas(opsLayer)).toBe(false);
    st.select([addNode(st, {}, opsLayer).id]); // a box on the hidden floor's page opens that page
    expect(st.onCanvas(opsLayer)).toBe(false);
    expect(st.onCanvas(ground)).toBe(true);
  });

  it('onCanvas is false for unknown layers', () => {
    const st = new Store();
    expect(st.onCanvas('l_nope')).toBe(false);
  });

  it('undo of deletePage restores the page, its layers, boxes and edges exactly', () => {
    const { st, p2, opsLayer } = twoPageStore();
    const a = addNode(st, {}, opsLayer), b = addNode(st, {}, opsLayer);
    const e = makeEdge(a.id, b.id);
    st.update((s) => { s.edges[e.id] = e; });
    const before = json(st);
    st.update((s) => { deletePage(s, p2); });
    expect(pageLayers(st.scene, p2)).toHaveLength(0);
    expect(st.scene.edges[e.id]).toBeUndefined();
    st.undo();
    expect(json(st)).toBe(before);
  });
});

// ------------------------------------------------------------------ journeys

describe('hunt: journeys view state', () => {
  function chain() {
    const st = new Store();
    const a = addNode(st, { label: 'A' }), b = addNode(st, { label: 'B' }), c = addNode(st, { label: 'C' });
    const ab = makeEdge(a.id, b.id), bc = makeEdge(b.id, c.id);
    st.update((s) => { s.edges[ab.id] = ab; s.edges[bc.id] = bc; s.journeys.push({ id: 'j', name: 'J', color: '#fff', steps: [] }); });
    return { st, a, b, c, ab, bc };
  }

  it('undo of a recorded hop shrinks the journey and clamps the focused step', () => {
    const { st, a, c } = chain();
    st.startRecording('j');
    st.recordNode(a.id);
    expect(st.recordNode(c.id)).toBeNull();
    st.setJourney('j', 1);
    st.undo();
    expect(st.scene.journeys[0].steps).toHaveLength(0);
    expect(st.journey).toEqual({ id: 'j', step: -1 });
  });

  it('undo of journey creation clears journey and recording view state', () => {
    const st = new Store();
    st.update((s) => { s.journeys.push({ id: 'j2', name: 'J', color: '#fff', steps: [] }); });
    st.startRecording('j2');
    st.undo();
    expect(st.journey).toBeNull();
    expect(st.recording).toBeNull();
  });

  it('deleting the first-clicked node while recording clears the recording start', () => {
    // BUG: tidyJourneys() keeps `recording.from` even when that node no longer exists, so recordingHead
    // returns a dangling id and the next click fails with “?” and “X” aren't connected.
    const { st, a, b } = chain();
    st.startRecording('j');
    st.recordNode(a.id);
    st.select([a.id]);
    st.deleteSelection();
    expect(st.recordingHead).toBeNull();
    expect(st.recordNode(b.id)).toBeNull();
  });

  it('setJourney to an unknown id hides journeys and stops recording', () => {
    const { st } = chain();
    st.startRecording('j');
    st.setJourney('nope');
    expect(st.journey).toBeNull();
    expect(st.recording).toBeNull();
  });

  it('recordEdge on an unreachable connection returns an error and leaves history untouched', () => {
    const { st, a, b } = chain();
    const x = addNode(st), y = addNode(st);
    const xy = makeEdge(x.id, y.id);
    st.update((s) => { s.edges[xy.id] = xy; });
    st.startRecording('j');
    st.recordNode(a.id);
    st.recordNode(b.id);
    const depth = st.undoDepth;
    expect(st.recordEdge(xy.id)).toMatch(/can't be reached/);
    expect(st.undoDepth).toBe(depth);
  });
});

// ------------------------------------------------------------------ moveSet / deleteSelection

describe('hunt: moveSet', () => {
  it('nested zones carry the inner zone and its contents', () => {
    const st = new Store();
    const L = st.activeLayer;
    const outer = makeNode('zone', 0, 0, L, { w: 1000, h: 1000 });
    const inner = makeNode('zone', 100, 100, L, { w: 300, h: 300 });
    const n = makeNode('service', 150, 150, L, { w: 50, h: 50 });
    const outside = makeNode('service', 2000, 0, L);
    st.update((s) => { for (const x of [outer, inner, n, outside]) s.nodes[x.id] = x; });
    expect(new Set(st.moveSet([outer.id]))).toEqual(new Set([outer.id, inner.id, n.id]));
    expect(new Set(st.moveSet([inner.id]))).toEqual(new Set([inner.id, n.id]));
  });

  it('ignores contained nodes on other layers and partially overlapping nodes', () => {
    const st = new Store();
    const L = st.activeLayer;
    st.update((s) => { s.layers.push({ id: 'l2', name: 'Two', visible: true, page: s.pages![0].id }); });
    const z = makeNode('zone', 0, 0, L, { w: 100, h: 100 });
    const other = makeNode('service', 10, 10, 'l2', { w: 10, h: 10 });
    const edge = makeNode('service', 95, 10, L, { w: 10, h: 10 });
    const exact = makeNode('service', 0, 0, L, { w: 100, h: 100 });
    st.update((s) => { for (const x of [z, other, edge, exact]) s.nodes[x.id] = x; });
    expect(new Set(st.moveSet([z.id]))).toEqual(new Set([z.id, exact.id]));
  });

  it('drops edge ids, de-duplicates, and does not include nodes just because they are given twice', () => {
    const st = new Store();
    const n = addNode(st);
    const out = st.moveSet([n.id, n.id, 'e_x']);
    expect(out).toEqual([n.id]);
  });

  it('two identical zones on top of each other each carry the other', () => {
    const st = new Store();
    const L = st.activeLayer;
    const z1 = makeNode('zone', 0, 0, L), z2 = makeNode('zone', 0, 0, L);
    st.update((s) => { s.nodes[z1.id] = z1; s.nodes[z2.id] = z2; });
    expect(new Set(st.moveSet([z1.id]))).toEqual(new Set([z1.id, z2.id]));
  });
});

describe('hunt: deleteSelection', () => {
  it('removes edges of deleted nodes even when an edge is also selected, and prunes journeys', () => {
    const st = new Store();
    const a = addNode(st), b = addNode(st), c = addNode(st);
    const ab = makeEdge(a.id, b.id), bc = makeEdge(b.id, c.id);
    st.update((s) => { s.edges[ab.id] = ab; s.edges[bc.id] = bc; s.journeys.push({ id: 'j', name: 'J', color: '#fff', steps: [{ edge: ab.id }, { edge: bc.id }] }); });
    st.setJourney('j', 1);
    st.select([b.id, ab.id]);
    st.deleteSelection();
    expect(Object.keys(st.scene.edges)).toHaveLength(0);
    expect(st.scene.journeys[0].steps).toHaveLength(0);
    expect(st.journey).toEqual({ id: 'j', step: -1 });
    expect(st.selection.size).toBe(0);
    st.undo();
    expect(Object.keys(st.scene.edges)).toHaveLength(2);
    expect(st.scene.journeys[0].steps).toHaveLength(2);
  });

  it('is one undo step', () => {
    const st = new Store();
    const ns = [addNode(st), addNode(st), addNode(st)];
    const depth = st.undoDepth;
    st.select(ns.map((n) => n.id));
    st.deleteSelection();
    expect(st.undoDepth).toBe(depth + 1);
  });

  it('ignores ids that are neither nodes nor edges', () => {
    const st = new Store();
    const n = addNode(st);
    st.selection = new Set(['l_whatever', 'j1']);
    st.deleteSelection();
    expect(st.scene.nodes[n.id]).toBeTruthy();
  });
});

// ------------------------------------------------------------------ randomized

describe('hunt: random operation sequences keep invariants', () => {
  const KINDS: NodeKind[] = ['service', 'database', 'zone', 'client', 'queue'];

  function invariants(st: Store) {
    const s = st.scene;
    const layerIds = new Set(s.layers.map((l) => l.id));
    expect(s.layers.length).toBeGreaterThan(0);
    for (const n of Object.values(s.nodes)) expect(layerIds.has(n.layer)).toBe(true);
    for (const e of Object.values(s.edges)) {
      expect(s.nodes[e.from]).toBeTruthy();
      expect(s.nodes[e.to]).toBeTruthy();
    }
    for (const j of s.journeys) for (const step of j.steps) expect(s.edges[step.edge]).toBeTruthy();
    for (const id of st.selection) expect(!!(s.nodes[id] || s.edges[id])).toBe(true);
    expect(layerIds.has(st.activeLayer)).toBe(true);
    if (st.journey) {
      const j = s.journeys.find((x) => x.id === st.journey!.id);
      expect(j).toBeTruthy();
      expect(st.journey.step).toBeGreaterThanOrEqual(-1);
      expect(st.journey.step).toBeLessThan(Math.max(1, j!.steps.length));
    }
    if (st.recording) expect(s.journeys.some((x) => x.id === st.recording!.id)).toBe(true);
    const lp = layerPages(s);
    const pageIds = new Set(pagesOf(s).map((p) => p.id));
    for (const p of lp.values()) expect(pageIds.has(p)).toBe(true);
    // the onCanvas cache agrees with a fresh computation
    for (const l of s.layers) expect(st.onCanvas(l.id)).toBe(l.visible && lp.has(l.id));
  }

  let lastOp = -1;
  function step(st: Store, r: () => number, deleteOpenPage = true) {
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const nodes = Object.values(st.scene.nodes);
    const edges = Object.values(st.scene.edges);
    const op = Math.floor(r() * 16);
    lastOp = op;
    switch (op) {
      case 0: case 1: {
        const layer = pick(st.scene.layers).id;
        const n = makeNode(pick(KINDS), Math.round(r() * 800), Math.round(r() * 800), layer);
        st.update((s) => { s.nodes[n.id] = n; });
        break;
      }
      case 2: {
        if (nodes.length < 2) break;
        const a = pick(nodes), b = pick(nodes);
        if (a.id === b.id) break;
        const e = makeEdge(a.id, b.id);
        st.update((s) => { s.edges[e.id] = e; });
        break;
      }
      case 3: {
        const ids = [...nodes, ...edges].filter(() => r() < 0.3).map((x) => x.id);
        st.select(ids);
        st.deleteSelection();
        break;
      }
      case 4: st.undo(); break;
      case 5: st.redo(); break;
      case 6: st.update((s) => { addPage(s); }); break;
      case 7: {
        if (pagesOf(st.scene).length < 2) break;
        const p = pick(pagesOf(st.scene)).id;
        if (!deleteOpenPage && p === st.activePage) break;
        const wasOpen = st.activePage === p;
        st.update((s) => { deletePage(s, p); });
        if (wasOpen) st.openPage(pagesOf(st.scene)[0].id);
        // like update(), deletePage doesn't prune the selection; drop ids that went with the page
        st.select([...st.selection].filter((id) => st.scene.nodes[id] || st.scene.edges[id]));
        break;
      }
      case 8: st.openPage(pick(pagesOf(st.scene)).id); break;
      case 9: st.focusLayer(pick(st.scene.layers).id); break;
      case 10: {
        const l = pick(st.scene.layers).id;
        st.update((s) => { const x = s.layers.find((y) => y.id === l)!; x.visible = !x.visible; });
        break;
      }
      case 11: {
        if (!edges.length) break;
        const id = 'j_' + Math.floor(r() * 1e6);
        st.update((s) => { s.journeys.push({ id, name: 'J', color: '#fff', steps: edges.filter(() => r() < 0.5).map((e) => ({ edge: e.id })) }); });
        st.setJourney(id, Math.floor(r() * 4) - 1);
        break;
      }
      case 12: {
        const mark = st.historyMark();
        const n = makeNode('service', 0, 0, st.activeLayer);
        st.update((s) => { s.nodes[n.id] = n; });
        if (r() < 0.5) st.rollback(mark); else st.squash(mark);
        break;
      }
      case 13: {
        // update/transact don't prune the selection (only load does); callers deselect what they delete.
        try { st.transact((s) => { s.nodes = {}; s.edges = {}; if (r() < 0.5) throw new Error('x'); }); st.select([]); } catch { /* expected */ }
        break;
      }
      case 14: st.select(nodes.filter(() => r() < 0.2).map((n) => n.id)); break;
      case 15: {
        now += r() < 0.5 ? 100 : 2000;
        if (nodes.length) { const n = pick(nodes); st.update((s) => { if (s.nodes[n.id]) s.nodes[n.id].x += 1; }, 'nudge'); }
        break;
      }
    }
  }

  for (const seed of [1, 42, 2024]) {
    it(`seed ${seed}: invariants hold after every op`, () => {
      // BUG (same as 'deleting the open page...' above): op kind 7 deleting the open page leaves activeLayer
      // pointing at a deleted layer, so these seeds fail the activeLayer invariant.
      const r = rng(seed);
      const st = new Store();
      for (let i = 0; i < 300; i++) {
        step(st, r);
        try { invariants(st); } catch (e) { throw new Error(`after op #${i} (kind ${lastOp}): ${(e as Error).message}\n${(e as Error).stack}`); }
      }
    });
  }

  for (const seed of [8, 13, 21, 34, 55, 89, 144, 233]) {
    it(`seed ${seed}: invariants hold (never deleting the open page)`, () => {
      const r = rng(seed);
      const st = new Store();
      for (let i = 0; i < 400; i++) {
        step(st, r, false);
        try { invariants(st); } catch (e) { throw new Error(`after op #${i} (kind ${lastOp}): ${(e as Error).message}\n${(e as Error).stack}`); }
      }
    });
  }

  for (const seed of [5, 11, 77]) {
    it(`seed ${seed}: undo all then redo all reproduces the final JSON`, () => {
      const r = rng(seed);
      const st = new Store();
      // only recorded, non-coalesced edits so every op is exactly one history entry
      for (let i = 0; i < 60; i++) {
        const nodes = Object.values(st.scene.nodes);
        const k = Math.floor(r() * 3);
        if (k === 0 || nodes.length < 2) {
          const n = makeNode('service', Math.round(r() * 500), 0, st.activeLayer);
          st.update((s) => { s.nodes[n.id] = n; });
        } else if (k === 1) {
          const e = makeEdge(nodes[0].id, nodes[nodes.length - 1].id);
          st.update((s) => { s.edges[e.id] = e; });
        } else {
          st.update((s) => { delete s.nodes[nodes[Math.floor(r() * nodes.length)].id]; for (const e of Object.values(s.edges)) if (!s.nodes[e.from] || !s.nodes[e.to]) delete s.edges[e.id]; });
        }
      }
      const final = json(st);
      const states: string[] = [];
      while (st.canUndo) { st.undo(); states.push(json(st)); }
      expect(states).toHaveLength(60);
      while (st.canRedo) st.redo();
      expect(json(st)).toBe(final);
      for (const id of Object.keys(st.scene.nodes)) expect(isNodeId(id)).toBe(true);
      for (const id of Object.keys(st.scene.edges)) expect(isEdgeId(id)).toBe(true);
    });
  }
});

describe('hunt: load edge cases', () => {
  it('load of a legacy scene (no pages) keeps everything on the default page', () => {
    const st = new Store();
    const s: Scene = emptyScene();
    delete s.pages;
    delete s.layers[0].page;
    st.load(s);
    expect(st.activePage).toBe('p_main');
    expect(st.onCanvas(s.layers[0].id)).toBe(true);
  });

  it('load fills missing journeys and clears a journey view that no longer exists', () => {
    const st = new Store();
    st.update((s) => { s.journeys.push({ id: 'j', name: 'J', color: '#fff', steps: [] }); });
    st.setJourney('j');
    const s = emptyScene() as Partial<Scene>;
    delete s.journeys;
    st.load(s as Scene);
    expect(st.scene.journeys).toEqual([]);
    expect(st.journey).toBeNull();
  });
});
