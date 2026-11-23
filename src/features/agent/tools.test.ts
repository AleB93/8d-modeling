// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../shared/model/store';
import { decodeShare } from '../share/share';
import { emptyScene, JOURNEY_COLORS, makeEdge, makeNode, Scene } from '../../shared/model/types';
import { AgentUI, autoLayout, createTools, ToolDef } from './tools';

let store: Store;
let ui: { [K in keyof AgentUI]: ReturnType<typeof vi.fn> };
let tools: Record<string, ToolDef>;

const call = async (name: string, input?: unknown) => JSON.parse(await tools[`modeling8d_${name}`].execute(input));
const nodeByLabel = (label: string) => Object.values(store.scene.nodes).find((n) => n.label === label)!;
const layerByName = (name: string) => store.scene.layers.find((l) => l.name === name)!;
const edgeBetween = (a: string, b: string) =>
  Object.values(store.scene.edges).find((e) => e.from === nodeByLabel(a).id && e.to === nodeByLabel(b).id)!;

beforeEach(() => {
  store = new Store();
  ui = {
    setMode: vi.fn(async () => {}),
    focus: vi.fn(),
    setSimulation: vi.fn(),
    setFlows: vi.fn(),
    fit: vi.fn(),
    captureView: vi.fn(() => ({ mode: 'play' as const, sim: true })),
    captureStop: vi.fn(),
    goStop: vi.fn(),
    present: vi.fn(),
    overview: vi.fn(),
    setMultiplier: vi.fn(),
    playJourney: vi.fn(),
    exportFile: vi.fn(),
  };
  tools = Object.fromEntries(createTools(store, ui as unknown as AgentUI).map((t) => [t.name, t]));
});

/** Web → API → DB, plus API → Cache. */
async function seedChain() {
  await call('add_nodes', {
    nodes: [
      { ref: 'web', kind: 'client', label: 'Web' },
      { ref: 'api', kind: 'service', label: 'API' },
      { ref: 'db', kind: 'database', label: 'DB' },
      { ref: 'cache', kind: 'cache', label: 'Cache' },
    ],
  });
  await call('connect', { edges: [{ from: 'Web', to: 'API' }, { from: 'API', to: 'DB' }, { from: 'API', to: 'Cache' }] });
}

describe('tool definitions', () => {
  it('exposes the 17 modeling8d tools with schemas', () => {
    expect(Object.keys(tools)).toEqual([
      'modeling8d_get_scene', 'modeling8d_add_nodes', 'modeling8d_connect', 'modeling8d_update', 'modeling8d_delete',
      'modeling8d_layers', 'modeling8d_auto_layout', 'modeling8d_simulate', 'modeling8d_view', 'modeling8d_journeys',
      'modeling8d_undo', 'modeling8d_share_link', 'modeling8d_redo', 'modeling8d_tour', 'modeling8d_scene', 'modeling8d_pages', 'modeling8d_batch',
    ]);
    for (const t of Object.values(tools)) {
      expect(t.title).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
    }
    expect(tools.modeling8d_get_scene.annotations).toEqual({ readOnlyHint: true });
  });
});

describe('guard (input handling)', () => {
  it('accepts arguments as a JSON string', async () => {
    const r = await call('add_nodes', JSON.stringify({ nodes: [{ kind: 'service', label: 'S' }] }));
    expect(r.created).toHaveLength(1);
  });

  it('rejects a string that is not JSON', async () => {
    await expect(tools.modeling8d_get_scene.execute('{nope')).rejects.toThrow('Input must be a JSON object');
  });

  it('treats null/undefined input as {}', async () => {
    expect((await call('get_scene', null)).nodes).toEqual([]);
    expect(await call('undo', undefined)).toEqual({ undone: 0 });
  });
});

describe('modeling8d_get_scene', () => {
  it('reports layers, nodes, edges, stops, journeys and selection', async () => {
    const s = emptyScene();
    const ground = s.layers[0].id;
    s.layers.push({ id: 'l_top', name: 'Top', visible: false });
    const svc = makeNode('service', 10.4, 20.6, ground, { label: 'Svc', down: true });
    const zone = makeNode('zone', 0, 0, 'l_top', { label: 'Zone' });
    const ghost = makeNode('text', 0, 0, 'l_missing', { label: 'Ghost' });
    s.nodes = { [svc.id]: svc, [zone.id]: zone, [ghost.id]: ghost };
    const e1 = makeEdge(svc.id, zone.id, { label: 'calls', dashed: true, mult: 0.5 });
    const e2 = makeEdge(svc.id, 'n_gone');
    s.edges = { [e1.id]: e1, [e2.id]: e2 };
    s.stops = [{ id: 's1', name: 'Overview', pos: [0, 0, 0], target: [0, 0, 0] }];
    s.journeys = [{ id: 'j1', name: 'Login', color: '#fff', steps: [{ edge: e1.id }] }];
    store.load(s);
    store.select([svc.id]);

    const r = await call('get_scene');
    expect(r.layers).toEqual([
      { id: ground, name: 'Ground', page: 'Page 1', floor: 0, visible: true },
      { id: 'l_top', name: 'Top', page: 'Page 1', floor: 1, visible: false },
    ]);
    expect(r.pages).toEqual([{ id: expect.any(String), name: 'Page 1', open: true, floors: 2 }]);
    const svcOut = r.nodes.find((n: any) => n.label === 'Svc');
    expect(svcOut).toMatchObject({ kind: 'service', layer: 'Ground', x: 10, y: 21, capacity: 800, latency: 15, down: true });
    const zoneOut = r.nodes.find((n: any) => n.label === 'Zone');
    expect(zoneOut.layer).toBe('Top');
    expect(zoneOut).not.toHaveProperty('capacity');
    expect(zoneOut).not.toHaveProperty('down');
    expect(r.nodes.find((n: any) => n.label === 'Ghost').layer).toBe('l_missing'); // unknown layer → id
    expect(r.edges).toContainEqual({ id: e1.id, from: svc.id, to: zone.id, fromLabel: 'Svc', toLabel: 'Zone', mult: 0.5, async: true, label: 'calls' });
    const e2Out = r.edges.find((e: any) => e.id === e2.id);
    expect(e2Out.toLabel).toBeUndefined();
    expect(e2Out).not.toHaveProperty('async');
    expect(e2Out).not.toHaveProperty('label');
    expect(r.tourStops).toEqual(['Overview']);
    expect(r.journeys).toEqual([{ id: 'j1', name: 'Login', steps: 1 }]);
    expect(r.selection).toEqual([svc.id]);
  });
});

describe('modeling8d_add_nodes', () => {
  it('creates nodes with defaults, auto-placement, refs, selection and new layers', async () => {
    const r = await call('add_nodes', {
      nodes: [
        { ref: 'a', kind: 'service', label: 'A' },
        { ref: 'b', kind: 'database', label: 'B', layer: 'data', x: 5, y: 6, w: 50, h: 40, height: 12, color: '#123456', capacity: 9, latency: 3 },
        { kind: 'service', label: 'C', layer: 'Data' }, // case-insensitive name hit on the layer just created
        { kind: 'service', label: 'D', x: 7 }, // y missing → auto-placed
        { kind: 'zone', label: 'Z', layer: store.activeLayer }, // layer by id
      ],
    });
    expect(r.created.map((c: any) => c.label)).toEqual(['A', 'B', 'C', 'D', 'Z']);
    expect(r.newLayers).toEqual(['data']);
    expect(Object.keys(r.refs)).toEqual(['a', 'b']);
    expect(store.scene.layers.map((l) => l.name)).toEqual(['Ground', 'data']);

    const a = nodeByLabel('A'), b = nodeByLabel('B'), c = nodeByLabel('C'), d = nodeByLabel('D'), z = nodeByLabel('Z');
    expect(r.refs.a).toBe(a.id);
    expect(a).toMatchObject({ x: 0, y: 25, w: 160, h: 90, height: 70, color: '#4f7cff', capacity: 800, latency: 15, layer: store.activeLayer });
    expect(b).toMatchObject({ x: 5, y: 6, w: 50, h: 40, height: 12, color: '#123456', capacity: 9, latency: 3, layer: layerByName('data').id });
    // C is the 2nd placed node on "data" (B already placed) → next slot to the right; B is excluded from "existing content"
    expect(c).toMatchObject({ x: 220, y: 25, layer: layerByName('data').id });
    expect(d).toMatchObject({ x: 220, y: 25 });
    expect(z.layer).toBe(store.activeLayer);
    expect(z.x).toBe(440);
    // zones go first so they render under the boxes they contain
    expect(Object.keys(store.scene.nodes)[0]).toBe(z.id);
    expect([...store.selection].sort()).toEqual(r.created.map((c: any) => c.id).sort());
  });

  it('places new nodes below existing content on the floor', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'Old', x: 100, y: 50 }] });
    await call('add_nodes', { nodes: [{ kind: 'database', label: 'New' }] });
    // under Old (y 50 + h 90 + 60 gap), aligned to the leftmost x, centered in a 140px row
    expect(nodeByLabel('New')).toMatchObject({ x: 100, y: 200 + (140 - 110) / 2 });
  });

  it('rejects empty or missing nodes', async () => {
    await expect(call('add_nodes', { nodes: [] })).rejects.toThrow('nodes must be a non-empty array');
    await expect(call('add_nodes', {})).rejects.toThrow('nodes must be a non-empty array');
  });

  it('is atomic: an unknown kind rolls back the whole call', async () => {
    await expect(
      call('add_nodes', { nodes: [{ kind: 'service', label: 'ok', layer: 'New floor' }, { kind: 'robot', label: 'bad' }] }),
    ).rejects.toThrow('Unknown kind "robot"');
    expect(store.scene.nodes).toEqual({});
    expect(store.scene.layers.map((l) => l.name)).toEqual(['Ground']);
    expect(store.canUndo).toBe(false);
  });
});

describe('modeling8d_connect', () => {
  it('connects by label, ref map and id, with defaults and options', async () => {
    const added = await call('add_nodes', {
      nodes: [{ ref: 'w', kind: 'client', label: 'Web' }, { ref: 'a', kind: 'service', label: 'API' }, { kind: 'queue', label: 'Q' }],
    });
    const qId = added.created[2].id;
    const r = await call('connect', {
      refs: added.refs,
      edges: [
        { from: 'w', to: 'a' }, // refs
        { from: 'api', to: qId, async: true, mult: 0.3, label: 'publish' }, // label (case-insensitive) + id
        { from: 'Web', to: 'Web' }, // self
        { from: 'Web', to: 'API' }, // duplicate
      ],
    });
    expect(r.created).toHaveLength(2);
    expect(r.created[0]).toMatchObject({ fromLabel: 'Web', toLabel: 'API', mult: 1 });
    expect(r.created[0]).not.toHaveProperty('async');
    expect(r.created[1]).toMatchObject({ fromLabel: 'API', toLabel: 'Q', mult: 0.3, async: true, label: 'publish' });
    expect(r.skipped).toEqual(['Web → itself', 'Web → API (exists)']);
    expect(Object.keys(store.scene.edges)).toHaveLength(2);
    expect(edgeBetween('Web', 'API')).toMatchObject({ label: '', dashed: false, mult: 1 });
  });

  it('falls back to labels when a ref points to a missing node', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'A' }, { kind: 'service', label: 'B' }] });
    const r = await call('connect', { refs: { A: 'n_deleted' }, edges: [{ from: 'A', to: 'B' }] });
    expect(r.created[0]).toMatchObject({ fromLabel: 'A', toLabel: 'B' });
  });

  it('rejects empty edges', async () => {
    await expect(call('connect', { edges: [] })).rejects.toThrow('edges must be a non-empty array');
    await expect(call('connect', {})).rejects.toThrow('edges must be a non-empty array');
  });

  it('errors on unknown and ambiguous nodes and rolls back', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'A' }, { kind: 'service', label: 'dup' }, { kind: 'cache', label: 'DUP' }] });
    await expect(call('connect', { edges: [{ from: 'A', to: 'dup' }] })).rejects.toThrow(/"dup" matches 2 nodes \(n_\w+, n_\w+\); use an id/);
    await expect(call('connect', { edges: [{ from: 'A', to: 'zzz' }] })).rejects.toThrow('No node "zzz"');
    const before = JSON.stringify(store.scene);
    const dupId = Object.values(store.scene.nodes).find((n) => n.label === 'dup')!.id;
    await expect(call('connect', { edges: [{ from: 'A', to: dupId }, { from: 'A', to: 'nope' }] })).rejects.toThrow('No node "nope"');
    expect(JSON.stringify(store.scene)).toBe(before);
  });
});

describe('modeling8d_update', () => {
  it('updates connections', async () => {
    await seedChain();
    const e = edgeBetween('API', 'DB');
    const r = await call('update', { updates: [{ target: e.id, label: 'sql', mult: 0, async: 1, from: 'Web', to: 'Cache' }] });
    expect(r).toEqual({ changed: [e.id], newLayers: [] });
    expect(store.scene.edges[e.id]).toMatchObject({ label: 'sql', mult: 0, dashed: true, from: nodeByLabel('Web').id, to: nodeByLabel('Cache').id });
    // an update with no fields leaves the edge as is
    await call('update', { updates: [{ target: e.id }] });
    expect(store.scene.edges[e.id]).toMatchObject({ label: 'sql', mult: 0, dashed: true });
  });

  it('updates nodes, coercing types, kind, down and layer', async () => {
    await seedChain();
    const api = nodeByLabel('API');
    const r = await call('update', {
      updates: [
        { target: 'API', label: 42, x: '10', y: 20, w: 30, h: 40, height: 50, color: 123, capacity: '99', latency: 7, kind: 'cache', down: 1, layer: 'Upper' },
        { target: 'DB' },
      ],
    });
    expect(r.changed).toEqual([api.id, nodeByLabel('DB').id]);
    expect(r.newLayers).toEqual(['Upper']);
    expect(store.scene.nodes[api.id]).toMatchObject({
      label: '42', x: 10, y: 20, w: 30, h: 40, height: 50, color: '123', capacity: 99, latency: 7, kind: 'cache', down: true, layer: layerByName('Upper').id,
    });
    await call('update', { updates: [{ target: api.id, down: false }] });
    expect(store.scene.nodes[api.id].down).toBe(false);
  });

  it('rolls back on unknown kind or target', async () => {
    await seedChain();
    const before = JSON.stringify(store.scene);
    await expect(call('update', { updates: [{ target: 'API', label: 'X' }, { target: 'DB', kind: 'robot' }] })).rejects.toThrow('Unknown kind "robot"');
    await expect(call('update', { updates: [{ target: 'nobody' }] })).rejects.toThrow('No node "nobody"');
    const e = edgeBetween('Web', 'API');
    await expect(call('update', { updates: [{ target: e.id, to: 'nobody' }] })).rejects.toThrow('No node "nobody"');
    expect(JSON.stringify(store.scene)).toBe(before);
  });
});

describe('modeling8d_delete', () => {
  it('deletes nodes (with their connections) and edges, undoably', async () => {
    await seedChain();
    const cacheEdge = edgeBetween('API', 'Cache');
    const r = await call('delete', { targets: ['DB', cacheEdge.id] });
    expect(r).toEqual({ deleted: 2 });
    expect(Object.values(store.scene.nodes).map((n) => n.label).sort()).toEqual(['API', 'Cache', 'Web']);
    expect(Object.keys(store.scene.edges)).toEqual([edgeBetween('Web', 'API').id]);
    expect(store.selection.size).toBe(0);
    await call('undo');
    expect(nodeByLabel('DB')).toBeDefined();
    expect(Object.keys(store.scene.edges)).toHaveLength(3);
  });

  it('errors on unknown targets without deleting anything', async () => {
    await seedChain();
    await expect(call('delete', { targets: ['API', 'ghost'] })).rejects.toThrow('No node "ghost"');
    expect(Object.keys(store.scene.nodes)).toHaveLength(4);
  });
});

describe('modeling8d_layers', () => {
  it('adds, renames, hides/shows and reorders floors', async () => {
    let r = await call('layers', { action: 'add', names: ['A', 'B'] });
    expect(r.layers).toEqual([
      { name: 'Ground', floor: 0, visible: true },
      { name: 'A', floor: 1, visible: true },
      { name: 'B', floor: 2, visible: true },
    ]);
    r = await call('layers', { action: 'add' }); // nothing to add
    expect(r.layers).toHaveLength(3);
    r = await call('layers', { action: 'rename', target: 'a', name: 'Apps' });
    expect(r.layers[1].name).toBe('Apps');
    r = await call('layers', { action: 'hide', target: layerByName('B').id });
    expect(r.layers[2].visible).toBe(false);
    r = await call('layers', { action: 'show', target: 'B' });
    expect(r.layers[2].visible).toBe(true);
    r = await call('layers', { action: 'reorder', names: ['B', 'Ground', 'apps'] });
    expect(r.layers.map((l: any) => l.name)).toEqual(['B', 'Ground', 'Apps']);
  });

  it('rejects invalid operations and leaves floors unchanged', async () => {
    await call('layers', { action: 'add', names: ['A'] });
    const before = JSON.stringify(store.scene.layers);
    await expect(call('layers', { action: 'rename', target: 'Nope', name: 'X' })).rejects.toThrow('No layer "Nope"');
    await expect(call('layers', { action: 'reorder', names: ['A'] })).rejects.toThrow('reorder needs every floor of the open page exactly once');
    await expect(call('layers', { action: 'reorder' })).rejects.toThrow('reorder needs every floor of the open page exactly once');
    await expect(call('layers', { action: 'explode' })).rejects.toThrow('Unknown action "explode"');
    expect(JSON.stringify(store.scene.layers)).toBe(before);
  });
});

describe('modeling8d_auto_layout / autoLayout', () => {
  it('ranks nodes top-down by dependency depth, one block per floor, and fits the view', async () => {
    await seedChain();
    await call('update', { updates: [{ target: 'DB', layer: 'Data' }] });
    const r = await call('auto_layout');
    expect(r).toEqual({ ok: true });
    expect(ui.fit).toHaveBeenCalledTimes(1);
    const web = nodeByLabel('Web'), api = nodeByLabel('API'), db = nodeByLabel('DB'), cache = nodeByLabel('Cache');
    // top floor (Data) is laid out first, at y≈0
    expect(db.y).toBe(Math.round((170 - 40 - db.h) / 2));
    expect(db.x).toBe(-db.w / 2);
    // Ground floor starts after Data's single row + gap
    const base = 170 + 120;
    expect(web.y).toBe(base + Math.round((170 - 40 - web.h) / 2));
    expect(api.y).toBe(base + 170 + Math.round((170 - 40 - api.h) / 2));
    expect(cache.y).toBe(base + 2 * 170 + Math.round((170 - 40 - cache.h) / 2));
    expect(store.canUndo).toBe(true);
  });

  it('only moves the requested floors', async () => {
    await seedChain();
    await call('update', { updates: [{ target: 'DB', layer: 'Data', x: 999, y: 999 }, { target: 'Web', x: 555, y: 555 }] });
    await call('auto_layout', { layers: ['data'] });
    expect(nodeByLabel('DB')).toMatchObject({ x: -65, y: 10 });
    expect(nodeByLabel('Web')).toMatchObject({ x: 555, y: 555 });
    await call('auto_layout', { layers: [] }); // empty list = every floor
    expect(nodeByLabel('Web').x).not.toBe(555);
  });

  it('handles cycles, self-loops, zones/text, dangling edges, empty floors and row ordering', () => {
    const s: Scene = emptyScene();
    const g = s.layers[0].id;
    s.layers.push({ id: 'l_empty', name: 'Empty', visible: true });
    const a = makeNode('service', 50, 0, g, { label: 'A' });
    const b = makeNode('service', 10, 0, g, { label: 'B' });
    const c = makeNode('service', 10, 0, g, { label: 'C' }); // same x as B → label order
    const x = makeNode('service', 0, 0, g, { label: 'X' });
    const y = makeNode('service', 0, 0, g, { label: 'Y' });
    const zone = makeNode('zone', 7, 7, g);
    const text = makeNode('text', 8, 8, g);
    for (const n of [a, b, c, x, y, zone, text]) s.nodes[n.id] = n;
    const edges = [
      makeEdge(x.id, y.id), makeEdge(y.id, x.id), // cycle → rank after everything
      makeEdge(a.id, a.id), // self-loop ignored
      makeEdge(a.id, zone.id), makeEdge(a.id, 'n_missing'), // ignored
    ];
    for (const e of edges) s.edges[e.id] = e;
    autoLayout(s);
    // A, B, C are sources (rank 0), X/Y are stuck in a cycle (rank 1)
    expect([b, c, a].map((n) => n.x)).toEqual([-230 - 80, -80, 230 - 80]);
    expect(a.y).toBe(b.y);
    expect(x.y).toBe(a.y + 170);
    expect([x.x, y.x]).toEqual([-115 - 80, 115 - 80]);
    expect(zone).toMatchObject({ x: 7, y: 7 });
    expect(text).toMatchObject({ x: 8, y: 8 });
  });

  it('gives a node with several parents the deepest rank', () => {
    const s = emptyScene();
    const g = s.layers[0].id;
    const [p, q, r] = ['P', 'Q', 'R'].map((l) => makeNode('service', 0, 0, g, { label: l }));
    for (const n of [p, q, r]) s.nodes[n.id] = n;
    for (const e of [makeEdge(p.id, q.id), makeEdge(q.id, r.id), makeEdge(p.id, r.id)]) s.edges[e.id] = e;
    autoLayout(s);
    expect(q.y - p.y).toBe(170);
    expect(r.y - p.y).toBe(340);
  });

  it('rejects an unknown floor name without changing anything', async () => {
    await seedChain();
    await call('update', { updates: [{ target: 'Web', x: 555, y: 555 }] });
    await expect(call('auto_layout', { layers: ['Brand new'] })).rejects.toThrow('No layer "Brand new"');
    expect(nodeByLabel('Web')).toMatchObject({ x: 555, y: 555 });
    expect(store.scene.layers.map((l) => l.name)).toEqual(['Ground']);
  });
});

describe('modeling8d_simulate', () => {
  it('reports totals, clients and bottlenecks without changing the scene', async () => {
    await call('add_nodes', {
      nodes: [
        { kind: 'client', label: 'Users', capacity: 200 },
        { kind: 'service', label: 'API', capacity: 100 },
        { kind: 'queue', label: 'Jobs', capacity: 10 },
        { kind: 'service', label: 'Idle', capacity: 1000 },
      ],
    });
    await call('connect', { edges: [{ from: 'Users', to: 'API' }, { from: 'API', to: 'Jobs', async: true }, { from: 'Users', to: 'Idle', mult: 0.1 }] });
    const before = JSON.stringify(store.scene);
    const r = await call('simulate');
    expect(JSON.stringify(store.scene)).toBe(before);
    expect(r.simulatedSeconds).toBe(10);
    expect(r.totals.requestsPerSec).toBe(200);
    expect(r.totals.clients).toBe(1);
    expect(r.totals.errorPct).toBeGreaterThan(0);
    expect(r.clients).toEqual([expect.objectContaining({ label: 'Users', rps: 200 })]);
    const labels = r.bottlenecks.map((b: any) => b.label);
    expect(labels).toContain('API');
    expect(labels).toContain('Jobs');
    expect(labels).not.toContain('Idle');
    expect(labels).not.toContain('Users');
    const api = r.bottlenecks.find((b: any) => b.label === 'API');
    expect(api).toMatchObject({ kind: 'service', rpsIn: 200, utilizationPct: 200, droppedPct: 50 });
    expect(api).not.toHaveProperty('queued');
    expect(r.bottlenecks.find((b: any) => b.label === 'Jobs').queued).toBeGreaterThan(1);
    expect(r.note).toBeUndefined();
    // sorted by utilization, highest first
    const utils = r.bottlenecks.map((b: any) => b.utilizationPct);
    expect([...utils].sort((a, b) => b - a)).toEqual(utils);
  });

  it('applies multiplier, seconds and temporary failures', async () => {
    await call('add_nodes', { nodes: [{ kind: 'client', label: 'Users', capacity: 100 }, { kind: 'service', label: 'API', capacity: 1000 }] });
    await call('connect', { edges: [{ from: 'Users', to: 'API' }] });
    const calm = await call('simulate', { seconds: 0.01 });
    expect(calm.simulatedSeconds).toBe(0.1); // at least one step
    expect(calm.bottlenecks).toEqual([]);
    expect(calm.note).toBe('No node above 80% utilization.');
    const busy = await call('simulate', { multiplier: 9, seconds: 1 });
    expect(busy.totals.requestsPerSec).toBe(900);
    expect(busy.bottlenecks[0]).toMatchObject({ label: 'API', utilizationPct: 90 });
    const failed = await call('simulate', { down: ['API'], seconds: 9999 });
    expect(failed.simulatedSeconds).toBe(600); // capped
    expect(failed.bottlenecks[0]).toMatchObject({ label: 'API', down: true });
    expect(failed.totals.errorPct).toBe(100);
    expect(nodeByLabel('API').down).toBeUndefined(); // only for this run
  });

  it('errors on unknown nodes to fail', async () => {
    await expect(call('simulate', { down: ['ghost'] })).rejects.toThrow('No node "ghost"');
  });

  it('ignores hidden floors', async () => {
    await call('add_nodes', { nodes: [{ kind: 'client', label: 'Users', layer: 'Edge' }] });
    await call('layers', { action: 'hide', target: 'Edge' });
    const r = await call('simulate', { seconds: 0.1 });
    expect(r.totals.clients).toBe(0);
    expect(r.clients).toEqual([]);
  });
});

describe('modeling8d_view', () => {
  it('drives the UI', async () => {
    await seedChain();
    expect(await call('view', { mode: 'play', simulate: 1, flows: 0, focus: 'api', fit: true })).toEqual({ ok: true });
    expect(ui.setMode).toHaveBeenCalledWith('play');
    expect(ui.setSimulation).toHaveBeenCalledWith(true);
    expect(ui.setFlows).toHaveBeenCalledWith(false);
    expect(ui.focus).toHaveBeenCalledWith(nodeByLabel('API').id);
    expect(ui.fit).toHaveBeenCalledTimes(1);
  });

  it('does nothing without options', async () => {
    await call('view', {});
    for (const f of Object.values(ui)) expect(f).not.toHaveBeenCalled();
  });

  it('errors on an unknown focus node', async () => {
    await expect(call('view', { focus: 'ghost' })).rejects.toThrow('No node "ghost"');
  });
});

describe('modeling8d_journeys', () => {
  it('creates a journey (forward + response hops, notes), lists, shows, updates and deletes it', async () => {
    await seedChain();
    const created = await call('journeys', {
      action: 'create', start: 'Web',
      steps: [{ to: 'API', note: 'POST /login' }, { to: 'DB' }, { to: 'Web', note: '200' }],
    });
    expect(created.name).toBe('Journey 1');
    expect(created.color).toBe(JOURNEY_COLORS[0]);
    expect(created.steps).toEqual([
      { n: 1, from: 'Web', to: 'API', connection: edgeBetween('Web', 'API').id, note: 'POST /login' },
      { n: 2, from: 'API', to: 'DB', connection: edgeBetween('API', 'DB').id },
      { n: 3, from: 'DB', to: 'API', connection: edgeBetween('API', 'DB').id, response: true },
      { n: 4, from: 'API', to: 'Web', connection: edgeBetween('Web', 'API').id, response: true, note: '200' },
    ]);
    expect(store.journey).toEqual({ id: created.id, step: -1 });

    const second = await call('journeys', { action: 'create', name: 'Cache read', color: '#010203', start: 'API', steps: [{ to: 'Cache' }] });
    expect(second).toMatchObject({ name: 'Cache read', color: '#010203' });

    const list = await call('journeys', { action: 'list' });
    expect(list.journeys.map((j: any) => j.name)).toEqual(['Journey 1', 'Cache read']);
    expect(list.journeys[0].steps).toHaveLength(4);

    expect(await call('journeys', { action: 'show', id: 'journey 1', step: 2 })).toEqual({ shown: 'Journey 1', step: 2 });
    expect(store.journey).toEqual({ id: created.id, step: 1 });
    expect(await call('journeys', { action: 'show', id: second.id })).toEqual({ shown: 'Cache read', step: 'all' });
    expect(await call('journeys', { action: 'show' })).toEqual({ shown: null });
    expect(store.journey).toBeNull();

    // rename + recolor only: steps untouched
    const renamed = await call('journeys', { action: 'update', id: created.id, name: 'Login', color: '#abcdef' });
    expect(renamed).toMatchObject({ name: 'Login', color: '#abcdef' });
    expect(renamed.steps).toHaveLength(4);
    // replace steps only
    const replaced = await call('journeys', { action: 'update', id: 'login', start: 'web', steps: [{ to: 'Cache' }] });
    expect(replaced).toMatchObject({ name: 'Login', color: '#abcdef' });
    expect(replaced.steps.map((s: any) => [s.from, s.to])).toEqual([['Web', 'API'], ['API', 'Cache']]);

    expect(await call('journeys', { action: 'delete', id: 'Cache read' })).toEqual({ deleted: 'Cache read' });
    expect(store.scene.journeys.map((j) => j.name)).toEqual(['Login']);
    await call('undo');
    expect(store.scene.journeys.map((j) => j.name)).toEqual(['Login', 'Cache read']);
  });

  it('picks the next unused color, then cycles once all are used', async () => {
    await seedChain();
    for (let i = 0; i < JOURNEY_COLORS.length; i++) {
      const j = await call('journeys', { action: 'create', start: 'Web', steps: [{ to: 'API' }] });
      expect(j.color).toBe(JOURNEY_COLORS[i]);
      expect(j.name).toBe(`Journey ${i + 1}`);
    }
    const extra = await call('journeys', { action: 'create', start: 'Web', steps: [{ to: 'API' }] });
    expect(extra.color).toBe(JOURNEY_COLORS[JOURNEY_COLORS.length % JOURNEY_COLORS.length]);
  });

  it('validates create input', async () => {
    await seedChain();
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'Island' }] });
    await expect(call('journeys', { action: 'create', steps: [{ to: 'API' }] })).rejects.toThrow('create needs `start` and `steps`');
    await expect(call('journeys', { action: 'create', start: 'Web' })).rejects.toThrow('steps must list at least one hop');
    await expect(call('journeys', { action: 'create', start: 'Web', steps: [] })).rejects.toThrow('steps must list at least one hop');
    await expect(call('journeys', { action: 'create', start: 'Web', steps: [{ to: 'Island' }] })).rejects.toThrow(
      '"Web" and "Island" aren\'t connected; add a connection with modeling8d_connect first',
    );
    await expect(call('journeys', { action: 'create', start: 'Web', steps: [{ to: 'API' }, { to: 'API' }] })).rejects.toThrow(
      'Hop to "API" starts and ends on the same node',
    );
    await expect(call('journeys', { action: 'create', start: 'Nobody', steps: [{ to: 'API' }] })).rejects.toThrow('No node "Nobody"');
    expect(store.scene.journeys).toEqual([]);
    expect(store.canUndo).toBe(true); // only the seed edits are in history
  });

  it('errors on unknown journeys, missing start and unknown actions', async () => {
    await seedChain();
    await expect(call('journeys', { action: 'delete', id: 'x' })).rejects.toThrow('No journey "x" (have: none)');
    await call('journeys', { action: 'create', name: 'Login', start: 'Web', steps: [{ to: 'API' }] });
    await expect(call('journeys', { action: 'show', id: 'x' })).rejects.toThrow('No journey "x" (have: Login)');
    await expect(call('journeys', { action: 'update', id: 'x' })).rejects.toThrow('No journey "x"');
    await expect(call('journeys', { action: 'update', id: 'Login', steps: [{ to: 'DB' }] })).rejects.toThrow('Replacing steps needs `start`');
    await expect(call('journeys', { action: 'fly' })).rejects.toThrow('Unknown action "fly"');
    expect(store.scene.journeys[0].steps).toHaveLength(1);
  });

  it('lists steps whose connection or nodes vanished as unknown ends', async () => {
    const s = emptyScene();
    const a = makeNode('service', 0, 0, s.layers[0].id, { label: 'A' });
    s.nodes[a.id] = a;
    const e = makeEdge(a.id, 'n_gone');
    s.edges[e.id] = e;
    // set directly (no tidy) to reach the defensive branches
    store.scene = { ...s, journeys: [{ id: 'j', name: 'J', color: '#fff', steps: [{ edge: 'e_gone' }, { edge: e.id }] }] };
    const r = await call('journeys', { action: 'list' });
    expect(r.journeys[0].steps).toEqual([
      { n: 1, from: null, to: null, connection: 'e_gone' },
      { n: 2, from: 'A', to: undefined, connection: e.id },
    ]);
  });
});

describe('modeling8d_undo', () => {
  it('undoes one or several steps, stopping when history is empty', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'A' }] });
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'B' }] });
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'C' }] });
    expect(await call('undo')).toEqual({ undone: 1 });
    expect(Object.values(store.scene.nodes).map((n) => n.label).sort()).toEqual(['A', 'B']);
    expect(await call('undo', { steps: 10 })).toEqual({ undone: 2 });
    expect(store.scene.nodes).toEqual({});
  });
});

describe('modeling8d_share_link', () => {
  it('encodes the scene and, by default, the current view', async () => {
    await seedChain();
    const { url } = await call('share_link');
    expect(url.startsWith(`${location.origin}${location.pathname}#z=`)).toBe(true);
    expect(ui.captureView).toHaveBeenCalledTimes(1);
    const shared = await decodeShare(url.slice(url.indexOf('#')));
    expect(Object.values(shared!.scene.nodes).map((n) => n.label).sort()).toEqual(['API', 'Cache', 'DB', 'Web']);
    expect(shared!.view).toEqual({ mode: 'play', sim: true });
  });

  it('can leave the view out', async () => {
    const { url } = await call('share_link', { includeView: false });
    expect(ui.captureView).not.toHaveBeenCalled();
    const shared = await decodeShare(url.slice(url.indexOf('#')));
    expect(shared!.view).toBeUndefined();
  });
});
