import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from './store';
import { emptyScene, makeEdge, makeNode, Scene } from './types';

/** a → b → c on the ground layer, plus a journey "J" with no steps. */
function setup() {
  const st = new Store();
  const L = st.activeLayer;
  const a = makeNode('client', 0, 0, L, { label: 'A' });
  const b = makeNode('service', 200, 0, L, { label: 'B' });
  const c = makeNode('database', 400, 0, L, { label: 'C' });
  const d = makeNode('cache', 600, 0, L, { label: 'D' }); // isolated
  const ab = makeEdge(a.id, b.id);
  const bc = makeEdge(b.id, c.id);
  st.update((s) => {
    for (const n of [a, b, c, d]) s.nodes[n.id] = n;
    s.edges[ab.id] = ab;
    s.edges[bc.id] = bc;
    s.journeys.push({ id: 'j1', name: 'J', color: '#fff', steps: [] });
  }, false);
  return { st, L, a, b, c, d, ab, bc };
}

let now = 0;
beforeEach(() => {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

describe('Store basics', () => {
  it('starts with an empty scene and the ground layer active', () => {
    const st = new Store();
    expect(Object.keys(st.scene.nodes)).toHaveLength(0);
    expect(st.activeLayer).toBe(st.scene.layers[0].id);
    expect(st.canUndo).toBe(false);
    expect(st.canRedo).toBe(false);
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    const st = new Store();
    const fn = vi.fn();
    const off = st.subscribe(fn);
    st.emit();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    st.emit();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('history', () => {
  it('update records, undo/redo restore snapshots', () => {
    const st = new Store();
    const fn = vi.fn();
    st.subscribe(fn);
    st.update((s) => { s.layers[0].name = 'One'; });
    st.update((s) => { s.layers[0].name = 'Two'; });
    expect(fn).toHaveBeenCalledTimes(2);
    st.undo();
    expect(st.scene.layers[0].name).toBe('One');
    expect(st.canRedo).toBe(true);
    st.undo();
    expect(st.scene.layers[0].name).toBe('Ground');
    expect(st.canUndo).toBe(false);
    st.undo(); // no-op
    expect(st.scene.layers[0].name).toBe('Ground');
    st.redo();
    st.redo();
    expect(st.scene.layers[0].name).toBe('Two');
    st.redo(); // no-op
    expect(st.scene.layers[0].name).toBe('Two');
  });

  it('update(fn, false) does not record', () => {
    const st = new Store();
    st.update((s) => { s.layers[0].name = 'X'; }, false);
    expect(st.canUndo).toBe(false);
  });

  it('a new checkpoint clears redo', () => {
    const st = new Store();
    st.update((s) => { s.layers[0].name = 'A'; });
    st.undo();
    expect(st.canRedo).toBe(true);
    st.update((s) => { s.layers[0].name = 'B'; });
    expect(st.canRedo).toBe(false);
  });

  it('coalesces string-keyed updates within 1.2s, not after', () => {
    const st = new Store();
    st.update((s) => { s.layers[0].name = 'a'; }, 'typing');
    now = 500;
    st.update((s) => { s.layers[0].name = 'ab'; }, 'typing');
    now = 1500; // 1000ms after the last coalesced call: still within the window
    st.update((s) => { s.layers[0].name = 'abc'; }, 'typing');
    st.undo();
    expect(st.scene.layers[0].name).toBe('Ground');
    expect(st.canUndo).toBe(false);

    st.redo();
    now = 5000;
    st.update((s) => { s.layers[0].name = 'later'; }, 'typing');
    st.undo();
    expect(st.scene.layers[0].name).toBe('abc');
  });

  it('different keys do not coalesce', () => {
    const st = new Store();
    st.update((s) => { s.layers[0].name = 'a'; }, 'k1');
    st.update((s) => { s.layers[0].name = 'b'; }, 'k2');
    st.undo();
    expect(st.scene.layers[0].name).toBe('a');
  });

  it('caps history at 200 entries', () => {
    const st = new Store();
    for (let i = 1; i <= 205; i++) st.update((s) => { s.layers[0].name = String(i); });
    let n = 0;
    while (st.canUndo) { st.undo(); n++; }
    expect(n).toBe(200);
    expect(st.scene.layers[0].name).toBe('5'); // oldest 5 snapshots were dropped
  });

  it('transact commits on success with one undo entry', () => {
    const st = new Store();
    const fn = vi.fn();
    st.subscribe(fn);
    st.transact((s) => { s.layers[0].name = 'T'; s.layers.push({ id: 'l2', name: 'Two', visible: true }); });
    expect(st.scene.layers).toHaveLength(2);
    expect(fn).toHaveBeenCalledTimes(1);
    st.undo();
    expect(st.scene.layers).toHaveLength(1);
    expect(st.scene.layers[0].name).toBe('Ground');
  });

  it('transact rolls back and leaves no history when fn throws', () => {
    const st = new Store();
    const fn = vi.fn();
    st.subscribe(fn);
    expect(() => st.transact((s) => { s.layers[0].name = 'broken'; throw new Error('boom'); })).toThrow('boom');
    expect(st.scene.layers[0].name).toBe('Ground');
    expect(st.canUndo).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('load resets history by default, keeps it with resetHistory=false', () => {
    const st = new Store();
    st.update((s) => { s.layers[0].name = 'x'; });
    const sc = emptyScene();
    st.load(sc, false);
    expect(st.canUndo).toBe(true);
    st.load(emptyScene());
    expect(st.canUndo).toBe(false);
  });
});

describe('load', () => {
  it('prunes selection, moves activeLayer to the top layer if missing, fills journeys', () => {
    const { st, a, ab } = setup();
    st.select([a.id, ab.id]);
    const sc = emptyScene();
    sc.layers.push({ id: 'top', name: 'Top', visible: true });
    const keep = makeNode('service', 0, 0, 'top');
    sc.nodes[keep.id] = keep;
    delete (sc as Partial<Scene>).journeys;
    st.selection.add(keep.id);
    st.load(sc);
    expect([...st.selection]).toEqual([keep.id]);
    expect(st.activeLayer).toBe('top');
    expect(st.scene.journeys).toEqual([]);
  });

  it('keeps the active layer when it still exists', () => {
    const st = new Store();
    const sc: Scene = JSON.parse(JSON.stringify(st.scene));
    sc.layers.push({ id: 'other', name: 'O', visible: true });
    st.load(sc);
    expect(st.activeLayer).toBe(sc.layers[0].id);
  });
});

describe('selection and layers', () => {
  it('select syncs the active layer only when all selected nodes share one layer', () => {
    const { st, L, a, b, ab } = setup();
    st.update((s) => { s.layers.push({ id: 'l2', name: 'Two', visible: false }); });
    const z = makeNode('service', 0, 0, 'l2');
    st.update((s) => { s.nodes[z.id] = z; });
    st.select([z.id]);
    expect(st.activeLayer).toBe('l2');
    st.select([a.id, z.id]); // two layers: unchanged
    expect(st.activeLayer).toBe('l2');
    st.select([a.id, b.id, ab.id]);
    expect(st.activeLayer).toBe(L);
    expect(st.selectedNodes.map((n) => n.id)).toEqual([a.id, b.id]);
  });

  it('setActiveLayer / focusLayer / setAllLayers / inFocus', () => {
    const st = new Store();
    const fn = vi.fn();
    st.subscribe(fn);
    const L = st.activeLayer;
    st.setActiveLayer(L);
    expect(fn).not.toHaveBeenCalled();
    st.setAllLayers(true);
    expect(fn).toHaveBeenCalledTimes(1);
    st.setAllLayers(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(st.inFocus('anything')).toBe(true);

    st.setActiveLayer('l2'); // stays in all-layers mode
    expect(st.activeLayer).toBe('l2');
    expect(st.allLayers).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);

    st.focusLayer('l2'); // same layer, but leaves all-layers mode
    expect(st.allLayers).toBe(false);
    expect(fn).toHaveBeenCalledTimes(3);
    st.focusLayer('l2'); // no-op
    expect(fn).toHaveBeenCalledTimes(3);
    expect(st.inFocus('l2')).toBe(true);
    expect(st.inFocus(L)).toBe(false);
    st.focusLayer(L);
    expect(st.activeLayer).toBe(L);
    st.setAllLayers(false); // no-op
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('layerIndex and isLayerVisible', () => {
    const st = new Store();
    st.update((s) => { s.layers.push({ id: 'l2', name: 'Two', visible: false }); });
    expect(st.layerIndex('l2')).toBe(1);
    expect(st.layerIndex('nope')).toBe(-1);
    expect(st.isLayerVisible(st.scene.layers[0].id)).toBe(true);
    expect(st.isLayerVisible('l2')).toBe(false);
    expect(st.isLayerVisible('nope')).toBe(false);
  });

  it('moveSet includes nodes fully inside a moved zone on the same layer', () => {
    const st = new Store();
    const L = st.activeLayer;
    const zone = makeNode('zone', 0, 0, L, { w: 400, h: 300 });
    const inside = makeNode('service', 10, 10, L, { w: 100, h: 50 });
    const partly = makeNode('service', 350, 10, L, { w: 100, h: 50 });
    const otherLayer = makeNode('service', 10, 10, 'l2', { w: 100, h: 50 });
    const loner = makeNode('service', 1000, 1000, L);
    st.update((s) => { for (const n of [zone, inside, partly, otherLayer, loner]) s.nodes[n.id] = n; });
    const e = makeEdge(inside.id, loner.id);
    expect(st.moveSet([zone.id, e.id, 'n_missing']).sort()).toEqual([zone.id, inside.id].sort()); // ids that aren't boxes are ignored
    expect(st.moveSet([loner.id])).toEqual([loner.id]);
  });

  it('deleteSelection removes nodes with their edges and selected edges', () => {
    const { st, a, b, c, d, ab, bc } = setup();
    const cd = makeEdge(c.id, d.id);
    st.update((s) => { s.edges[cd.id] = cd; });
    st.select([a.id, bc.id, 'other']);
    st.deleteSelection();
    expect(st.scene.nodes[a.id]).toBeUndefined();
    expect(st.scene.edges[ab.id]).toBeUndefined();
    expect(st.scene.edges[bc.id]).toBeUndefined();
    expect(st.scene.edges[cd.id]).toBeDefined();
    expect(st.scene.nodes[b.id]).toBeDefined();
    expect(st.selection.size).toBe(0);
    st.undo();
    expect(st.scene.nodes[a.id]).toBeDefined();
  });

  it('deleteSelection with nothing selected does nothing', () => {
    const st = new Store();
    st.deleteSelection();
    expect(st.canUndo).toBe(false);
  });
});

describe('journeys', () => {
  it('journeyById / activeJourney', () => {
    const { st } = setup();
    expect(st.journeyById(null)).toBeUndefined();
    expect(st.journeyById(undefined)).toBeUndefined();
    expect(st.journeyById('j1')?.name).toBe('J');
    expect(st.activeJourney).toBeUndefined();
    st.setJourney('j1');
    expect(st.activeJourney?.id).toBe('j1');
  });

  it('setJourney clamps the step, skips no-op updates and clears an unrelated recording', () => {
    const { st, ab, bc } = setup();
    st.update((s) => { s.journeys[0].steps.push({ edge: ab.id }, { edge: bc.id }); });
    st.update((s) => { s.journeys.push({ id: 'j2', name: 'K', color: '#000', steps: [] }); });
    const fn = vi.fn();
    st.subscribe(fn);
    st.setJourney('j1', 9);
    expect(st.journey).toEqual({ id: 'j1', step: 1 });
    st.setJourney('j1', 1);
    expect(fn).toHaveBeenCalledTimes(1);
    st.setJourney('j1', -5);
    expect(st.journey).toEqual({ id: 'j1', step: -1 });

    st.startRecording('j1');
    st.setJourney('j1', 0); // same journey: recording kept
    expect(st.recording?.id).toBe('j1');
    st.setJourney('j2');
    expect(st.recording).toBeNull();

    st.setJourney('missing');
    expect(st.journey).toBeNull();
    st.setJourney(null); // already null: no-op
    expect(st.journey).toBeNull();
  });

  it('startRecording ignores unknown journeys; stopRecording ignores when idle', () => {
    const { st } = setup();
    const fn = vi.fn();
    st.subscribe(fn);
    st.startRecording('nope');
    st.stopRecording();
    expect(fn).not.toHaveBeenCalled();
    st.startRecording('j1');
    expect(st.recording).toEqual({ id: 'j1', from: null });
    expect(st.journey).toEqual({ id: 'j1', step: -1 });
    st.stopRecording();
    expect(st.recording).toBeNull();
  });

  it('records a journey by clicking nodes', () => {
    const { st, a, c, d, ab, bc } = setup();
    expect(st.recordNode(a.id)).toBeNull(); // not recording: ignored
    expect(st.recordingHead).toBeNull();
    st.startRecording('j1');
    expect(st.recordingHead).toBeNull();

    expect(st.recordNode(a.id)).toBeNull();
    expect(st.recording?.from).toBe(a.id);
    expect(st.recordingHead).toBe(a.id);
    expect(st.recordNode(a.id)).toBeNull(); // clicking the head again: no-op
    expect(st.journeyById('j1')!.steps).toEqual([]);

    expect(st.recordNode(c.id)).toBeNull();
    expect(st.journeyById('j1')!.steps).toEqual([{ edge: ab.id }, { edge: bc.id }]);
    expect(st.recordingHead).toBe(c.id);
    expect(st.journey).toEqual({ id: 'j1', step: -1 });

    expect(st.recordNode(d.id)).toBe('“C” and “D” aren\'t connected. Draw a connection first.');
    expect(st.recordNode('n_ghost')).toBe('“C” and “?” aren\'t connected. Draw a connection first.');

    // walking back reuses the edges the journey already took
    expect(st.recordNode(a.id)).toBeNull();
    expect(st.journeyById('j1')!.steps.slice(2)).toEqual([{ edge: bc.id, back: true }, { edge: ab.id, back: true }]);
    st.undo();
    expect(st.journeyById('j1')!.steps).toHaveLength(2);
  });

  it('records a journey by clicking connections', () => {
    const { st, c, d, ab, bc } = setup();
    expect(st.recordEdge(ab.id)).toBeNull(); // not recording
    expect(st.journeyById('j1')!.steps).toEqual([]);
    st.startRecording('j1');
    expect(st.recordEdge(bc.id)).toBeNull(); // no head: starts at the edge
    expect(st.journeyById('j1')!.steps).toEqual([{ edge: bc.id }]);
    const dc = makeEdge(d.id, 'n_elsewhere');
    st.update((s) => { s.edges[dc.id] = dc; }, false);
    expect(st.recordEdge(dc.id)).toBe("That connection can't be reached from where the journey ends.");
    expect(st.recordEdge('e_missing')).toBe("That connection can't be reached from where the journey ends.");
    expect(st.recordEdge(bc.id)).toBeNull(); // at c: walk bc backwards
    expect(st.journeyById('j1')!.steps[1]).toEqual({ edge: bc.id, back: true });
    expect(c.id).toBe(st.scene.edges[bc.id].to);
  });

  it('tidies journeys after edits: prunes steps, clamps and clears view state', () => {
    const { st, ab, bc } = setup();
    st.update((s) => { s.journeys[0].steps.push({ edge: ab.id }, { edge: bc.id }); });
    st.setJourney('j1', 1);
    st.update((s) => { delete s.edges[bc.id]; });
    expect(st.journeyById('j1')!.steps).toEqual([{ edge: ab.id }]);
    expect(st.journey).toEqual({ id: 'j1', step: 0 });
    st.update((s) => { delete s.edges[ab.id]; });
    expect(st.journey).toEqual({ id: 'j1', step: -1 });
    st.update((s) => { s.layers[0].name = 'still here'; });
    expect(st.journey).toEqual({ id: 'j1', step: -1 });

    st.startRecording('j1');
    st.update((s) => { s.journeys = []; });
    expect(st.journey).toBeNull();
    expect(st.recording).toBeNull();
  });

  it('keeps a recording whose journey still exists', () => {
    const { st } = setup();
    st.startRecording('j1');
    st.update((s) => { s.layers[0].name = 'x'; });
    expect(st.recording?.id).toBe('j1');
  });
});

describe('history grouping (squash / rollback)', () => {
  const nodeCount = (st: Store) => Object.keys(st.scene.nodes).length;
  const addNode = (st: Store) => st.update((s) => { const n = makeNode('service', 0, 0, s.layers[0].id); s.nodes[n.id] = n; });

  it('squash merges several changes into one undo step', () => {
    const st = new Store();
    addNode(st);
    const mark = st.historyMark();
    addNode(st);
    addNode(st);
    st.squash(mark);
    expect(nodeCount(st)).toBe(3);
    st.undo();
    expect(nodeCount(st)).toBe(1);
  });

  it('squash does nothing when nothing changed', () => {
    const st = new Store();
    addNode(st);
    const mark = st.historyMark();
    const depth = st.undoDepth;
    st.squash(mark);
    expect(st.undoDepth).toBe(depth);
  });

  it('rollback restores the scene and drops the history in between', () => {
    const st = new Store();
    addNode(st);
    const mark = st.historyMark();
    addNode(st);
    st.rollback(mark);
    expect(nodeCount(st)).toBe(1);
    expect(st.undoDepth).toBe(1);
  });
});
