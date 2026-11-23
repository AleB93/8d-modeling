// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../shared/model/store';
import type { Stop } from '../../shared/model/types';
import { AgentUI, createTools, ToolDef } from './tools';

// Tools added for full app coverage: floors (delete/focus), view extras, journey playback, redo, tour, scene, batch.

let store: Store;
let ui: { [K in keyof AgentUI]: ReturnType<typeof vi.fn> };
let tools: Record<string, ToolDef>;
let cam = 0;

const call = async (name: string, input?: unknown) => JSON.parse(await tools[`modeling8d_${name}`].execute(input));
const names = () => store.scene.layers.map((l) => l.name);
const nodeCount = () => Object.keys(store.scene.nodes).length;

beforeEach(() => {
  store = new Store();
  cam = 0;
  ui = {
    setMode: vi.fn(async () => {}), focus: vi.fn(), setSimulation: vi.fn(), setFlows: vi.fn(), fit: vi.fn(),
    captureView: vi.fn(() => ({ mode: 'play' as const })),
    captureStop: vi.fn(async (name: string): Promise<Stop> => ({ id: `s${++cam}`, name, pos: [cam, 1, 1], target: [0, 0, 0], journey: store.journey?.id })),
    goStop: vi.fn(async () => {}), present: vi.fn(async () => {}), overview: vi.fn(async () => {}),
    setMultiplier: vi.fn(), playJourney: vi.fn(), exportFile: vi.fn(async (f: string) => `file.${f}`),
  };
  tools = Object.fromEntries(createTools(store, ui as unknown as AgentUI).map((t) => [t.name, t]));
});

async function seed() {
  await call('add_nodes', { nodes: [
    { kind: 'client', label: 'Web', layer: 'Edge' },
    { kind: 'service', label: 'API', layer: 'Services' },
  ] });
  await call('connect', { edges: [{ from: 'Web', to: 'API' }] });
}

describe('layers: delete and focus', () => {
  it('deletes an empty floor', async () => {
    await call('layers', { action: 'add', names: ['Spare'] });
    const r = await call('layers', { action: 'delete', target: 'spare' });
    expect(r.layers.map((l: any) => l.name)).not.toContain('Spare');
  });

  it('refuses a floor with boxes unless deleteNodes, then removes boxes and their connections', async () => {
    await seed();
    await call('add_nodes', { nodes: [{ kind: 'client', label: 'Mobile', layer: 'Edge' }, { kind: 'database', label: 'DB', layer: 'Services' }] });
    await call('connect', { edges: [{ from: 'API', to: 'Mobile' }, { from: 'API', to: 'DB' }] });
    await expect(call('layers', { action: 'delete', target: 'Edge' })).rejects.toThrow('Floor "Edge" has 2 boxes; pass deleteNodes: true');
    expect(names()).toContain('Edge');
    await call('layers', { action: 'delete', target: 'Edge', deleteNodes: true });
    expect(names()).not.toContain('Edge');
    expect(Object.values(store.scene.nodes).map((n) => n.label).sort()).toEqual(['API', 'DB']);
    // connections out of and into the deleted floor are gone; API → DB stays
    expect(Object.values(store.scene.edges).map((e) => `${store.scene.nodes[e.from].label}→${store.scene.nodes[e.to].label}`)).toEqual(['API→DB']);
  });

  it('says "1 box" for a single box', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'Solo', layer: 'Lonely' }] });
    await expect(call('layers', { action: 'delete', target: 'Lonely' })).rejects.toThrow('Floor "Lonely" has 1 box; pass deleteNodes');
  });

  it('never deletes the only floor', async () => {
    await expect(call('layers', { action: 'delete', target: store.scene.layers[0].name })).rejects.toThrow('only floor');
  });

  it('focuses one floor or all of them', async () => {
    await seed();
    expect(await call('layers', { action: 'focus', target: 'services' })).toEqual({ focus: 'Services' });
    expect(store.allLayers).toBe(false);
    expect(await call('layers', { action: 'focus', target: 'ALL' })).toEqual({ focus: 'all' });
    expect(store.allLayers).toBe(true);
    await expect(call('layers', { action: 'focus', target: 'Nope' })).rejects.toThrow('No layer "Nope"');
  });
});

describe('view extras', () => {
  it('sets the live load and resets the 3D camera', async () => {
    await call('view', { multiplier: 2.5, overview: true });
    expect(ui.setMultiplier).toHaveBeenCalledWith(2.5);
    expect(ui.overview).toHaveBeenCalled();
    await call('view', { multiplier: 0 });
    expect(ui.setMultiplier).toHaveBeenLastCalledWith(0);
  });
  it('rejects a bad multiplier', async () => {
    await expect(call('view', { multiplier: -1 })).rejects.toThrow('multiplier must be ≥ 0');
    await expect(call('view', { multiplier: 'lots' })).rejects.toThrow('multiplier');
  });
});

describe('journeys: play', () => {
  it('animates a journey, and refuses an empty one', async () => {
    await seed();
    const j = await call('journeys', { action: 'create', name: 'Load', start: 'Web', steps: [{ to: 'API' }] });
    expect(await call('journeys', { action: 'play', id: 'Load' })).toEqual({ playing: 'Load', steps: 1 });
    expect(ui.playJourney).toHaveBeenCalledWith(j.id);
    store.update((s) => { s.journeys.push({ id: 'jE', name: 'Empty', color: '#fff', steps: [] }); });
    await expect(call('journeys', { action: 'play', id: 'Empty' })).rejects.toThrow('Journey "Empty" has no steps');
  });
});

describe('redo', () => {
  it('redoes undone changes, up to what is available', async () => {
    await seed();
    await call('undo', { steps: 2 });
    expect(nodeCount()).toBe(0);
    expect(await call('redo')).toEqual({ redone: 1 });
    expect(nodeCount()).toBe(2);
    expect(await call('redo', { steps: 5 })).toEqual({ redone: 1 });
    expect(Object.keys(store.scene.edges)).toHaveLength(1);
  });
});

describe('tour', () => {
  const stops = () => store.scene.stops.map((s) => s.name);

  it('adds stops from the current 3D view, with default names and the shown journey', async () => {
    await seed();
    const j = await call('journeys', { action: 'create', name: 'Load', start: 'Web', steps: [{ to: 'API' }] });
    const r = await call('tour', { action: 'add', name: 'Entry' });
    expect(r.stops).toEqual([{ n: 1, id: 's1', name: 'Entry', journey: 'Load' }]);
    store.setJourney(null);
    await call('tour', { action: 'add' });
    expect(stops()).toEqual(['Entry', 'View 2']);
    expect(store.scene.stops[0].journey).toBe(j.id);
    expect((await call('tour', { action: 'list' })).stops[1].journey).toBeNull();
  });

  it('finds stops by number, name or id; updates, renames, reorders and deletes them', async () => {
    await call('tour', { action: 'add', name: 'A' });
    await call('tour', { action: 'add', name: 'B' });
    await call('tour', { action: 'update', target: 1 });
    expect(store.scene.stops[0].pos[0]).toBe(3); // re-captured
    await call('tour', { action: 'rename', target: 'b', name: 'Bee' });
    await call('tour', { action: 'reorder', names: ['Bee', 's1'] });
    expect(stops()).toEqual(['Bee', 'A']);
    await call('tour', { action: 'delete', target: '2' });
    expect(stops()).toEqual(['Bee']);
    await expect(call('tour', { action: 'rename', target: 1 })).rejects.toThrow('rename needs `name`');
    await expect(call('tour', { action: 'go', target: 'Nope' })).rejects.toThrow('No tour stop "Nope"');
  });

  it('rejects a reorder that misses or repeats a stop', async () => {
    await call('tour', { action: 'add', name: 'A' });
    await call('tour', { action: 'add', name: 'B' });
    await expect(call('tour', { action: 'reorder', names: ['A'] })).rejects.toThrow('every stop exactly once');
    await expect(call('tour', { action: 'reorder', names: ['A', 'A'] })).rejects.toThrow('every stop exactly once');
    await expect(call('tour', { action: 'reorder' })).rejects.toThrow('every stop exactly once');
  });

  it('flies to a stop and presents', async () => {
    await expect(call('tour', { action: 'present' })).rejects.toThrow('Add a tour stop first');
    await call('tour', { action: 'add', name: 'A' });
    await call('tour', { action: 'add', name: 'B' });
    expect(await call('tour', { action: 'go', target: 'B' })).toEqual({ at: 'B' });
    expect(ui.goStop).toHaveBeenCalledWith(1);
    expect(await call('tour', { action: 'present' })).toEqual({ presenting: true, stops: 2 });
    expect(ui.present).toHaveBeenCalledWith(true);
    expect(await call('tour', { action: 'stop' })).toEqual({ presenting: false });
    expect(ui.present).toHaveBeenLastCalledWith(false);
    await expect(call('tour', { action: 'fly' })).rejects.toThrow('Unknown action "fly"');
  });
});

describe('scene', () => {
  it('starts empty or from the demo, undoably', async () => {
    await seed();
    expect(await call('scene', { action: 'new' })).toEqual({ pages: 1, nodes: 0, edges: 0, floors: 1 });
    expect(ui.fit).toHaveBeenCalled();
    await call('undo');
    expect(nodeCount()).toBe(2);
    const d = await call('scene', { action: 'demo' });
    expect(d.nodes).toBe(46);
    expect(d.pages).toBe(4);
  });

  it('exports JSON and loads it back', async () => {
    await seed();
    const { scene } = await call('scene', { action: 'export' });
    await call('scene', { action: 'new' });
    expect(await call('scene', { action: 'load', scene })).toMatchObject({ nodes: 2, edges: 1 });
    await expect(call('scene', { action: 'load', scene: { nope: 1 } })).rejects.toThrow(/^Invalid scene: /);
  });

  it('downloads HTML and PNG for the user', async () => {
    expect(await call('scene', { action: 'export', format: 'html' })).toEqual({ downloaded: 'file.html' });
    expect(await call('scene', { action: 'export', format: 'png' })).toEqual({ downloaded: 'file.png' });
    await expect(call('scene', { action: 'export', format: 'pdf' })).rejects.toThrow('Unknown format "pdf"');
    await expect(call('scene', { action: 'wipe' })).rejects.toThrow('Unknown action "wipe"');
  });
});

describe('batch', () => {
  it('runs calls in order and undoes them as one step', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'Keep' }] });
    const r = await call('batch', { calls: [
      { tool: 'add_nodes', input: { nodes: [{ kind: 'client', label: 'Web' }, { kind: 'service', label: 'API' }] } },
      { tool: 'modeling8d_connect', input: { edges: [{ from: 'Web', to: 'API' }] } },
      { tool: 'get_scene' },
    ] });
    expect(r.results).toHaveLength(3);
    expect(r.results[2].nodes).toHaveLength(3);
    await call('undo');
    expect(Object.values(store.scene.nodes).map((n) => n.label)).toEqual(['Keep']);
  });

  it('rolls everything back when a call fails', async () => {
    await expect(call('batch', { calls: [
      { tool: 'add_nodes', input: { nodes: [{ kind: 'service', label: 'API' }] } },
      { tool: 'connect', input: { edges: [{ from: 'API', to: 'Ghost' }] } },
    ] })).rejects.toThrow(/^Call 2 \(modeling8d_connect\) failed, nothing was changed: /);
    expect(nodeCount()).toBe(0);
    expect(store.canUndo).toBe(false);
  });

  it('validates the call list before running anything', async () => {
    await expect(call('batch', { calls: [] })).rejects.toThrow('calls must be a non-empty array');
    await expect(call('batch', {})).rejects.toThrow('calls must be a non-empty array');
    await expect(call('batch', { calls: [{ tool: 'add_nodes', input: { nodes: [{ kind: 'service', label: 'X' }] } }, { tool: 'nope' }] }))
      .rejects.toThrow('Call 2: unknown tool "nope"');
    await expect(call('batch', { calls: [{ tool: 'batch' }] })).rejects.toThrow('Call 1: unknown tool "batch"');
    await expect(call('batch', { calls: [null] })).rejects.toThrow('Call 1: unknown tool "undefined"');
    expect(nodeCount()).toBe(0);
  });
});

describe('scene load safety', () => {
  it('a load that fails part-way changes nothing', async () => {
    await seed();
    const before = JSON.stringify(store.scene), depth = store.undoDepth;
    const orig = store.load.bind(store);
    vi.spyOn(store, 'load').mockImplementationOnce(() => { throw new Error('boom'); });
    await expect(call('scene', { action: 'new' })).rejects.toThrow('Invalid scene: boom');
    expect(JSON.stringify(store.scene)).toBe(before);
    expect(store.undoDepth).toBe(depth);
    store.load = orig;
  });
});

describe('input checks before any change', () => {
  it('simulate needs `down` to be a list; view needs a known mode', async () => {
    await seed();
    await expect(call('simulate', { down: 'API' })).rejects.toThrow('down must be an array');
    await expect(call('view', { mode: '3d', simulate: true })).rejects.toThrow('mode must be "design" or "play"');
    expect(ui.setSimulation).not.toHaveBeenCalled();
  });
});
