// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../shared/model/store';
import type { Scene, Stop } from '../../shared/model/types';
import { AgentUI, createTools, ToolDef } from './tools';

// Adversarial tests for the agent tools: hostile inputs, atomicity, undo accounting.

let store: Store;
let ui: { [K in keyof AgentUI]: ReturnType<typeof vi.fn> };
let tools: Record<string, ToolDef>;
let cam = 0;

const call = async (name: string, input?: unknown) => JSON.parse(await tools[`modeling8d_${name}`].execute(input));
const node = (label: string) => Object.values(store.scene.nodes).find((n) => n.label === label)!;
const nodeCount = () => Object.keys(store.scene.nodes).length;
const edgeCount = () => Object.keys(store.scene.edges).length;

beforeEach(() => {
  store = new Store();
  cam = 0;
  ui = {
    setMode: vi.fn(async () => {}), focus: vi.fn(), setSimulation: vi.fn(), setFlows: vi.fn(), fit: vi.fn(),
    captureView: vi.fn(() => ({ mode: 'play' as const })),
    captureStop: vi.fn(async (name: string): Promise<Stop> => ({ id: `s${++cam}`, name, pos: [cam, 1, 1], target: [0, 0, 0] })),
    goStop: vi.fn(async () => {}), present: vi.fn(async () => {}), overview: vi.fn(async () => {}),
    setMultiplier: vi.fn(), playJourney: vi.fn(), exportFile: vi.fn(async (f: string) => `file.${f}`),
  };
  tools = Object.fromEntries(createTools(store, ui as unknown as AgentUI).map((t) => [t.name, t]));
});

/** Everything a failed call must leave untouched. */
const snap = () => ({ scene: JSON.stringify(store.scene), mark: store.undoDepth, redo: store.canRedo });

async function expectRejectedUnchanged(name: string, input: unknown, msg?: string | RegExp) {
  const before = snap();
  const p = call(name, input);
  if (msg) await expect(p).rejects.toThrow(msg);
  else await expect(p).rejects.toThrow();
  expect(snap()).toEqual(before);
}

/** A successful mutation must undo, in exactly one step, back to the scene before it. */
async function expectOneUndo(name: string, input: unknown) {
  const before = JSON.stringify(store.scene);
  const mark = store.undoDepth;
  const r = await call(name, input);
  expect(store.undoDepth).toBe(mark + 1);
  await call('undo');
  expect(JSON.stringify(store.scene)).toBe(before);
  return r;
}

async function seed() {
  await call('add_nodes', {
    nodes: [
      { kind: 'client', label: 'Web' }, { kind: 'service', label: 'API' },
      { kind: 'database', label: 'DB' }, { kind: 'cache', label: 'Cache' },
    ],
  });
  await call('connect', { edges: [{ from: 'Web', to: 'API' }, { from: 'API', to: 'DB' }, { from: 'API', to: 'Cache' }] });
}

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

describe('hostile shapes are rejected without side effects', () => {
  it.each([
    ['add_nodes', {}], ['add_nodes', { nodes: {} }], ['add_nodes', { nodes: 'x' }], ['add_nodes', { nodes: [] }],
    ['add_nodes', { nodes: [{ kind: 'nope', label: 'X' }] }],
    ['add_nodes', { nodes: [{ kind: 'service', label: 'A' }, { kind: 'bogus', label: 'B' }] }],
    ['connect', {}], ['connect', { edges: 'x' }], ['connect', { edges: [] }],
    ['connect', { edges: [{ from: 'Web', to: 'API' }, { from: 'Web', to: 'Nope' }] }],
    ['update', { updates: [{ target: 'API', capacity: 5 }, { target: 'Nope', capacity: 1 }] }],
    ['update', { updates: [{ target: 'API', kind: 'bogus' }] }],
    ['delete', { targets: ['API', 'Nope'] }],
    ['layers', { action: 'explode' }], ['layers', { action: 'rename', target: 'Nope', name: 'x' }],
    ['layers', { action: 'reorder', names: ['Ground', 'Ground'] }],
    ['auto_layout', { layers: ['Nope'] }],
    ['journeys', { action: 'create', start: 'Web' }], ['journeys', { action: 'create', start: 'Web', steps: [{ to: 'Nope' }] }],
    ['journeys', { action: 'update', id: 'nope' }], ['journeys', { action: 'zzz' }],
    ['tour', { action: 'go', target: 9 }], ['tour', { action: 'zzz' }],
    ['scene', { action: 'load', scene: { nodes: {} } }], ['scene', { action: 'zzz' }],
    ['pages', { action: 'delete', target: 1 }], ['pages', { action: 'zzz' }], ['pages', { action: 'open', target: 0 }],
    ['batch', { calls: [] }], ['batch', { calls: [{ tool: 'nope' }] }], ['batch', { calls: [{ tool: 'batch', input: {} }] }],
  ] as [string, unknown][])('%s %j', async (name, input) => {
    await seed();
    await expectRejectedUnchanged(name, input);
  });

  it('a non-JSON string input is rejected', async () => {
    await expectRejectedUnchanged('add_nodes', '{nodes:', 'Input must be a JSON object');
  });

  it('null input behaves like {} (clear error, not a crash)', async () => {
    await expectRejectedUnchanged('add_nodes', null, 'nodes must be a non-empty array');
    await expectRejectedUnchanged('add_nodes', 'null', 'nodes must be a non-empty array');
  });

  it('update without `updates` gives a clear error, not a TypeError', async () => {
    await seed();
    // BUG: modeling8d_update never checks `updates` (tools.ts:398, `for (const u of updates)`), so
    // { } or { updates: {} } throws "updates is not iterable" (a TypeError) instead of a ToolError like
    // add_nodes/connect ("updates must be a non-empty array"). The scene is rolled back, but the agent sees a JS crash.
    for (const input of [{}, { updates: {} }, { updates: 'API' }]) {
      const before = snap();
      const err = await call('update', input).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TypeError);
      expect(snap()).toEqual(before);
    }
  });

  it('delete with a non-array `targets` gives a clear error', async () => {
    await seed();
    // BUG: modeling8d_delete calls `targets.map` unchecked (tools.ts:433): { targets: "API" } or {} crash with
    // a TypeError ("targets.map is not a function" / "Cannot read properties of undefined").
    for (const input of [{}, { targets: 'API' }]) {
      const err = await call('delete', input).catch((e) => e);
      expect(err).not.toBeInstanceOf(TypeError);
    }
    expect(nodeCount()).toBe(4);
  });

  it('a null entry inside nodes/edges/updates is a clear error, scene unchanged', async () => {
    await seed();
    for (const [name, input] of [
      ['add_nodes', { nodes: [{ kind: 'service', label: 'Z' }, null] }],
      ['connect', { edges: [null] }],
      ['update', { updates: [null] }],
    ] as const) {
      const before = snap();
      const err = await call(name, input).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(snap()).toEqual(before);
      // BUG: tools.ts:301/356/399 dereference each spec unchecked: a null entry throws
      // "Cannot read properties of null" (TypeError). Rolled back, but it's a crash rather than a clear error.
      expect(err).not.toBeInstanceOf(TypeError);
    }
  });
});

describe('numeric input hygiene', () => {
  it('add_nodes stores numeric strings as numbers', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'S', x: '5', y: '6', w: '100', h: '50', capacity: '300', latency: '7', height: '40' }] });
    const n = node('S');
    // BUG: add_nodes copies x/y/w/h/height/capacity/latency verbatim (tools.ts:305-312), so "5" stays a string;
    // later math like n.x + n.w becomes string concatenation ("5100"). modeling8d_update coerces with `+`.
    for (const k of ['x', 'y', 'w', 'h', 'height', 'capacity', 'latency'] as const) expect(typeof n[k], k).toBe('number');
  });

  it('connect stores a numeric-string mult as a number and rejects negatives', async () => {
    await seed();
    await call('add_nodes', { nodes: [{ kind: 'queue', label: 'Q' }, { kind: 'queue', label: 'R' }] });
    await call('connect', { edges: [{ from: 'API', to: 'Q', mult: '0.5' }] });
    const e = Object.values(store.scene.edges).find((x) => x.to === node('Q').id)!;
    // BUG: connect stores spec.mult as given (tools.ts:361): "0.5" stays a string; update coerces (Math.max(0, +mult)).
    expect(e.mult).toBe(0.5);
    const before = snap();
    const r = await call('connect', { edges: [{ from: 'API', to: 'R', mult: -3 }] }).catch((x) => x);
    // Schema says minimum 0 and update clamps to 0; connect must not store a negative multiplier.
    if (!(r instanceof Error)) {
      const e2 = Object.values(store.scene.edges).find((x) => x.to === node('R').id)!;
      // BUG: connect accepts mult -3 and stores it (negative downstream calls).
      expect(e2.mult).toBeGreaterThanOrEqual(0);
    } else expect(snap()).toEqual(before);
  });

  it('update with a non-numeric string must not write NaN', async () => {
    await seed();
    const r = await call('update', { updates: [{ target: 'API', x: 'left', capacity: 'lots' }] }).catch((e) => e);
    const n = node('API');
    // BUG: update writes `+u[k]` (tools.ts:411) without checking it is finite, so x: "left" stores NaN
    // (JSON-serialized as null, breaking layout, rendering and saves). It should throw and change nothing.
    expect(isNum(n.x)).toBe(true);
    expect(isNum(n.capacity)).toBe(true);
    expect(r).toBeInstanceOf(Error);
  });

  it('update of an edge mult with junk must not write NaN', async () => {
    await seed();
    const id = Object.keys(store.scene.edges)[0];
    await call('update', { updates: [{ target: id, mult: 'many' }] }).catch(() => {});
    // BUG: Math.max(0, +"many") is NaN (tools.ts:402).
    expect(isNum(store.scene.edges[id].mult)).toBe(true);
  });

  it('numeric strings are coerced by update', async () => {
    await seed();
    await expectOneUndo('update', { updates: [{ target: 'API', x: '12', capacity: '99' }] });
    await call('update', { updates: [{ target: 'API', x: '12', capacity: '99' }] });
    expect(node('API').x).toBe(12);
    expect(node('API').capacity).toBe(99);
  });

  it('simulate rejects (or clamps) a negative multiplier', async () => {
    await seed();
    const r = await call('simulate', { multiplier: -2 }).catch((e) => e);
    // BUG: simulate passes `multiplier` straight to the Simulation (tools.ts:534) although the schema says
    // minimum 0 (modeling8d_view validates the same field): clients then emit negative traffic.
    if (!(r instanceof Error)) expect(r.totals.requestsPerSec).toBeGreaterThanOrEqual(0);
  });

  it('simulate with seconds 0, negative and huge stays bounded', async () => {
    await seed();
    expect((await call('simulate', { seconds: 0 })).simulatedSeconds).toBe(0.1);
    expect((await call('simulate', { seconds: -50 })).simulatedSeconds).toBe(0.1);
    expect((await call('simulate', { seconds: 1e9 })).simulatedSeconds).toBe(600);
    expect((await call('simulate', { seconds: '3' })).simulatedSeconds).toBe(3);
  });

  it('simulate with junk seconds reports a number', async () => {
    await seed();
    const r = await call('simulate', { seconds: 'long' }).catch((e) => e);
    // BUG: seconds "long" → NaN steps: no step runs and simulatedSeconds is NaN (null in JSON). Should throw or default.
    if (!(r instanceof Error)) expect(isNum(r.simulatedSeconds)).toBe(true);
  });

  it('simulate does not touch the scene or history', async () => {
    await seed();
    const before = snap();
    await call('simulate', { multiplier: 3, seconds: 5, down: ['DB', 'cache'] });
    expect(snap()).toEqual(before);
    await expectRejectedUnchanged('simulate', { down: ['Nope'] }, 'No node "Nope"');
  });
});

describe('label and id resolution', () => {
  it('a node labelled like an Object.prototype key resolves to that node', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'constructor' }, { kind: 'service', label: 'toString' }] });
    // BUG: resolveNodeOn (tools.ts:97) and update/delete (tools.ts:399, 433) index s.nodes / s.edges with the
    // raw ref, so "constructor" / "toString" hit Object.prototype: update treats Object.prototype.constructor
    // as an edge (writing props onto the global Object function) and never updates the node.
    await call('update', { updates: [{ target: 'constructor', capacity: 5 }] });
    expect(node('constructor').capacity).toBe(5);
    expect((Object as any).capacity).toBeUndefined();
    await call('connect', { edges: [{ from: 'constructor', to: 'toString' }] });
    expect(edgeCount()).toBe(1);
    const r = await call('delete', { targets: ['toString'] });
    expect(r.deleted).toBe(1);
    expect(nodeCount()).toBe(1);
  });

  it('accepts a numeric label given as a number (as tour/pages targets do)', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: '5' }, { kind: 'service', label: 'B' }] });
    await call('connect', { edges: [{ from: 5, to: 'B' }] }); // connect stringifies
    // BUG: resolveNodeOn calls ref.toLowerCase() (tools.ts:100) on non-strings: delete/journeys/view/simulate/update.from
    // with a number ref throw "ref.toLowerCase is not a function" instead of resolving label "5".
    for (const [name, input] of [
      ['view', { focus: 5 }],
      ['simulate', { down: [5] }],
      ['journeys', { action: 'create', start: 5, steps: [{ to: 'B' }] }],
    ] as const) {
      const err = await call(name, input).then(() => null, (e) => e);
      expect(err, name).toBeNull();
    }
  });

  it('a journey hop missing `to` gives a clear error', async () => {
    await seed();
    const before = snap();
    const err = await call('journeys', { action: 'create', start: 'Web', steps: [{ note: 'x' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(snap()).toEqual(before);
    // BUG: h.to undefined reaches ref.toLowerCase() (tools.ts:100): TypeError.
    expect(err).not.toBeInstanceOf(TypeError);
  });

  it('ambiguous label is refused without change', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'Svc' }, { kind: 'service', label: 'svc' }] });
    await expectRejectedUnchanged('delete', { targets: ['SVC'] }, /matches 2 nodes/);
    await expectRejectedUnchanged('update', { updates: [{ target: 'svc', x: 1 }] }, /matches 2 nodes/);
  });

  it('delete works on scenes whose ids lack the n_/e_ prefix (loaded scenes)', async () => {
    const scene: Scene = {
      v: 1,
      nodes: {
        api: { id: 'api', kind: 'service', x: 0, y: 0, w: 100, h: 50, layer: 'g', height: 40, color: '#4f7cff', label: 'API', capacity: 100, latency: 1 },
        db: { id: 'db', kind: 'database', x: 0, y: 200, w: 100, h: 50, layer: 'g', height: 40, color: '#f59e0b', label: 'DB', capacity: 100, latency: 1 },
      },
      edges: { link: { id: 'link', from: 'api', to: 'db', label: '', dashed: false, mult: 1, flow: true } },
      layers: [{ id: 'g', name: 'Ground', visible: true }], stops: [], journeys: [],
    };
    await call('scene', { action: 'load', scene });
    const r = await call('delete', { targets: ['DB'] });
    expect(r.deleted).toBe(1);
    // BUG: Store.deleteSelection (store.ts:309-314) only deletes ids starting with "n_"/"e_", so on a scene loaded
    // with ids like "api"/"db" (validateScene accepts any id) delete reports {deleted: 1} but removes nothing,
    // and still pushes an (empty) undo step.
    expect(store.scene.nodes.db).toBeUndefined();
    expect(store.scene.edges.link).toBeUndefined();
  });

  it('delete reports distinct deletions', async () => {
    await seed();
    const r = await call('delete', { targets: ['API', 'api', node('API').id] });
    expect(nodeCount()).toBe(3);
    // BUG (minor): duplicate targets are counted: reports deleted 3 for one node (tools.ts:436).
    expect(r.deleted).toBe(1);
  });

  it('delete of a node and one of its edges in one call is one undo step', async () => {
    await seed();
    const eid = Object.values(store.scene.edges).find((e) => e.to === node('DB').id)!.id;
    await expectOneUndo('delete', { targets: [eid, 'API'] });
  });
});

describe('graph consistency', () => {
  it('update must not turn a connection into a self-loop', async () => {
    await seed();
    const id = Object.values(store.scene.edges).find((e) => e.to === node('API').id)!.id;
    const before = snap();
    const r = await call('update', { updates: [{ target: id, to: 'Web' }] }).catch((e) => e);
    // BUG: update rewires e.from/e.to without the self-loop check connect has (tools.ts:404-405): Web → Web is stored.
    expect(r).toBeInstanceOf(Error);
    expect(snap()).toEqual(before);
  });

  it('update must not create a duplicate connection', async () => {
    await seed();
    const toCache = Object.values(store.scene.edges).find((e) => e.to === node('Cache').id)!.id;
    const r = await call('update', { updates: [{ target: toCache, to: 'DB' }] }).catch((e) => e);
    const dup = Object.values(store.scene.edges).filter((e) => e.from === node('API').id && e.to === node('DB').id);
    // BUG: rewiring API→Cache to API→DB yields two identical API→DB edges; connect refuses duplicates.
    expect(dup.length).toBe(1);
    void r;
  });

  it('connect skips self-loops and duplicates and reports them', async () => {
    await seed();
    const r = await call('connect', { edges: [{ from: 'API', to: 'api' }, { from: 'Web', to: 'API' }, { from: 'DB', to: 'Cache' }, { from: 'DB', to: 'Cache' }] });
    expect(r.created).toHaveLength(1);
    expect(r.skipped).toEqual(['API → itself', 'Web → API (exists)', 'DB → Cache (exists)']);
  });

  it('connect where everything is skipped leaves no undo step', async () => {
    await seed();
    const mark = store.undoDepth;
    await call('connect', { edges: [{ from: 'Web', to: 'API' }] });
    // A no-op should not cost the user a Ctrl+Z that does nothing.
    // BUG (minor): Store.transact always checkpoints (store.ts:80), so no-op tools push an empty undo step.
    expect(store.undoDepth).toBe(mark);
  });

  it('update kind to zone keeps the scene coherent and undoes once', async () => {
    await seed();
    await expectOneUndo('update', { updates: [{ target: 'Cache', kind: 'zone', down: true, label: 'Ζώνη 🚀' }] });
  });
});

describe('active floor and page stay valid', () => {
  it('deleting the active floor moves new boxes to an existing floor', async () => {
    await call('layers', { action: 'add', names: ['Top'] });
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'S', layer: 'Top' }] }); // selects S → active = Top
    expect(store.scene.layers.find((l) => l.id === store.activeLayer)!.name).toBe('Top');
    await call('layers', { action: 'delete', target: 'Top', deleteNodes: true });
    // BUG: layers delete (tools.ts:477-486) doesn't move store.activeLayer off the deleted floor, so it dangles
    // and the next add_nodes puts the box on a layer that doesn't exist.
    expect(store.scene.layers.some((l) => l.id === store.activeLayer)).toBe(true);
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'T' }] });
    expect(store.scene.layers.some((l) => l.id === node('T').layer)).toBe(true);
  });

  it('deleting the open page opens another page with a real floor', async () => {
    await call('pages', { action: 'add', name: 'Two' });
    const two = store.activePage;
    await call('pages', { action: 'delete', target: 'Two' });
    expect(store.activePage).not.toBe(two);
    // BUG: pages delete (tools.ts:874-876) calls store.openPage(first page), but Store.openPage returns early
    // because activePage already *falls back* to the first page (store.ts:153), so activeLayer still points at
    // the deleted page's floor and new boxes land on a non-existent layer.
    expect(store.scene.layers.some((l) => l.id === store.activeLayer)).toBe(true);
    await call('add_nodes', { nodes: [{ kind: 'cache', label: 'C' }] });
    expect(store.scene.layers.some((l) => l.id === node('C').layer)).toBe(true);
  });

  it('deleting the open first page leaves a valid active floor', async () => {
    const first = store.activePage;
    await call('pages', { action: 'add', name: 'Two' });
    await call('pages', { action: 'open', target: 1 });
    await call('pages', { action: 'delete', target: first });
    // BUG: same as above (fallback page == page openPage is asked to open).
    expect(store.scene.layers.some((l) => l.id === store.activeLayer)).toBe(true);
  });

  it('deleting a page removes its boxes, journeys steps and selection', async () => {
    await seed();
    await call('journeys', { action: 'create', name: 'J', start: 'Web', steps: [{ to: 'DB' }] });
    await call('pages', { action: 'add', name: 'Two' });
    await call('pages', { action: 'open', target: 1 });
    store.select([node('API').id]);
    await expectOneUndo('pages', { action: 'delete', target: 1 });
    await call('pages', { action: 'delete', target: 1 });
    expect(nodeCount()).toBe(0);
    expect(edgeCount()).toBe(0);
    expect(store.scene.journeys[0].steps).toEqual([]);
    // selection of deleted boxes must not linger
    // BUG: pages delete uses store.update, which never prunes selection: get_scene keeps listing deleted ids.
    expect((await call('get_scene')).selection).toEqual([]);
  });

  it('deleting a floor with deleteNodes drops them from the selection', async () => {
    await call('layers', { action: 'add', names: ['Top'] });
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'S', layer: 'Top' }] });
    await call('layers', { action: 'focus', target: 'Ground' });
    await call('layers', { action: 'delete', target: 'Top', deleteNodes: true });
    // BUG: selection still holds the deleted box id (tools.ts:483 deletes nodes behind the store's back).
    expect((await call('get_scene')).selection).toEqual([]);
  });

  it('layers add with a string `names` does not split it into characters', async () => {
    const r = await call('layers', { action: 'add', names: 'Edge' }).catch((e) => e);
    // BUG: `for (const nm of names ?? [])` (tools.ts:474) iterates a string, creating floors "E","d","g","e".
    expect(store.scene.layers.map((l) => l.name)).not.toContain('E');
    void r;
  });

  it('a floor named with a number does not break later lookups', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'S', layer: 2 as unknown as string }] });
    // BUG: resolveLayer stores the raw ref as the layer name (tools.ts:70), here the number 2; findLayer then calls
    // l.name.toLowerCase() (tools.ts:63) and every later floor lookup by name crashes with a TypeError.
    const err = await call('add_nodes', { nodes: [{ kind: 'service', label: 'T', layer: 'Other' }] }).then(() => null, (e) => e);
    expect(err).toBeNull();
    expect(store.scene.layers.every((l) => typeof l.name === 'string')).toBe(true);
  });

  it('layers add with a numeric name does not break later lookups', async () => {
    await call('layers', { action: 'add', names: [7] });
    const err = await call('layers', { action: 'rename', target: 'Ground', name: 'G' }).then(() => null, (e) => e);
    // BUG: names are pushed unconverted (tools.ts:474); findLayer then throws "l.name.toLowerCase is not a function".
    expect(err).toBeNull();
  });

  it('layers rename without a name does not rename to "undefined"', async () => {
    const r = await call('layers', { action: 'rename', target: 'Ground' }).catch((e) => e);
    // BUG: String(undefined) (tools.ts:475); tour/pages rename refuse a missing name.
    expect(store.scene.layers[0].name).toBe('Ground');
    void r;
  });

  it('add_nodes without a label does not create a box called "undefined"', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service' }] }).catch(() => {});
    // BUG: label is required by the schema but String(spec.label) (tools.ts:308) yields "undefined".
    expect(Object.values(store.scene.nodes).map((n) => n.label)).not.toContain('undefined');
  });

  it('layers reorder on a multi-page scene only touches the open page', async () => {
    await call('layers', { action: 'add', names: ['P1 top'] });
    const p1 = store.scene.layers.map((l) => l.id);
    await call('pages', { action: 'add', name: 'Two' });
    await call('layers', { action: 'add', names: ['P2 mid', 'P2 top'] });
    await expectOneUndo('layers', { action: 'reorder', names: ['P2 top', 'Ground', 'P2 mid'] });
    const r = await call('layers', { action: 'reorder', names: ['P2 top', 'Ground', 'P2 mid'] });
    expect(r.layers.map((l: any) => l.name)).toEqual(['P2 top', 'Ground', 'P2 mid']);
    // page 1 floors untouched; "Ground" resolved on the open page
    expect(store.scene.layers.filter((l) => p1.includes(l.id)).map((l) => l.name)).toEqual(['Ground', 'P1 top']);
    await expectRejectedUnchanged('layers', { action: 'reorder', names: ['P2 top', 'Ground', p1[1]] }, /every floor/);
  });

  it('cannot delete the last floor of a non-open page by id', async () => {
    const g1 = store.scene.layers[0].id;
    await call('pages', { action: 'add', name: 'Two' });
    await expectRejectedUnchanged('layers', { action: 'delete', target: g1 }, /only floor/);
  });
});

describe('cross-page rules', () => {
  it('update cannot move a connected box to another page', async () => {
    await seed();
    await call('pages', { action: 'add', name: 'Two' });
    const other = store.activeLayer;
    await call('pages', { action: 'open', target: 1 });
    await expectRejectedUnchanged('update', { updates: [{ target: 'API', layer: other }] }, /different pages/);
  });

  it('update cannot rewire an edge to a box on another page', async () => {
    await seed();
    await call('pages', { action: 'add', name: 'Two' });
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'Far' }] });
    const id = Object.keys(store.scene.edges)[0];
    await expectRejectedUnchanged('update', { updates: [{ target: id, to: 'Far' }] }, /different pages/);
  });

  it('labels resolve on the open page first', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'API' }] });
    await call('pages', { action: 'add' });
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'api' }, { kind: 'client', label: 'Web' }] });
    const r = await call('connect', { edges: [{ from: 'Web', to: 'API' }] });
    expect(r.created[0].toLabel).toBe('api');
  });

  it('journeys show switches to the journey page', async () => {
    await seed();
    await call('journeys', { action: 'create', name: 'J', start: 'Web', steps: [{ to: 'API' }] });
    const p1 = store.activePage;
    await call('pages', { action: 'add' });
    await call('journeys', { action: 'show', id: 'j' });
    // BUG: create already put J on screen, so Store.setJourney returns early ("same journey, same step",
    // store.ts:211) before its page switch: `show` of the journey on another page leaves the user looking at
    // an empty page. The page switch should not depend on the journey having changed.
    expect(store.activePage).toBe(p1);
  });
});

describe('journeys', () => {
  it('create and update are one undo step each', async () => {
    await seed();
    await expectOneUndo('journeys', { action: 'create', name: 'Login', start: 'Web', steps: [{ to: 'DB', note: 'q' }, { to: 'Web' }] });
    await call('journeys', { action: 'create', name: 'Login', start: 'Web', steps: [{ to: 'DB' }] });
    await expectOneUndo('journeys', { action: 'update', id: 'login', name: 'L2', start: 'Web', steps: [{ to: 'Cache' }] });
    await expectOneUndo('journeys', { action: 'delete', id: 'LOGIN' });
  });

  it('show with step 0 / string / huge clamps', async () => {
    await seed();
    await call('journeys', { action: 'create', name: 'J', start: 'Web', steps: [{ to: 'DB' }] });
    expect((await call('journeys', { action: 'show', id: 'J', step: 0 })).step).toBe('all');
    expect((await call('journeys', { action: 'show', id: 'J', step: '2' })).step).toBe(2);
    expect((await call('journeys', { action: 'show', id: 'J', step: 99 })).step).toBe(2);
    expect((await call('journeys', { action: 'show', id: 'J', step: -5 })).step).toBe('all');
  });

  it('hop that returns to the same node is refused', async () => {
    await seed();
    await expectRejectedUnchanged('journeys', { action: 'create', start: 'Web', steps: [{ to: 'API' }, { to: 'API' }] }, /same node/);
  });

  it('update steps without start is refused unchanged', async () => {
    await seed();
    await call('journeys', { action: 'create', name: 'J', start: 'Web', steps: [{ to: 'DB' }] });
    await expectRejectedUnchanged('journeys', { action: 'update', id: 'J', steps: [{ to: 'Cache' }] }, /needs `start`/);
  });

  it('deleting a box prunes journey steps and is undone in one step', async () => {
    await seed();
    await call('journeys', { action: 'create', name: 'J', start: 'Web', steps: [{ to: 'DB' }] });
    await expectOneUndo('delete', { targets: ['DB'] });
    expect(store.scene.journeys[0].steps).toHaveLength(2);
  });
});

describe('undo / redo step counts', () => {
  it.each([[0, 0], [-3, 0], ['2', 2], [1e9, 3], ['x', 0], [null, 1]])('undo steps=%j → %j', async (steps, n) => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'A' }] });
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'B' }] });
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'C' }] });
    // null → default not applied (destructuring default only for undefined) → `n < null` is false
    const expected = steps === null ? 0 : n;
    expect((await call('undo', { steps })).undone).toBe(expected);
    expect((await call('redo', { steps: 1e9 })).redone).toBe(expected);
    expect(nodeCount()).toBe(3);
  });
});

describe('tour', () => {
  async function stops(...names: string[]) {
    for (const n of names) await call('tour', { action: 'add', name: n });
  }

  it('target "0" and numeric-looking names', async () => {
    await stops('Intro', '0', '2');
    expect((await call('tour', { action: 'go', target: '0' })).at).toBe('0');
    expect((await call('tour', { action: 'go', target: 2 })).at).toBe('0'); // 1-based number wins over a name
    expect((await call('tour', { action: 'go', target: 'intro' })).at).toBe('Intro');
    await expect(call('tour', { action: 'go', target: 7 })).rejects.toThrow('No tour stop "7"');
  });

  it('every mutating action is one undo step', async () => {
    await stops('A', 'B');
    await expectOneUndo('tour', { action: 'add', name: 'C' });
    await expectOneUndo('tour', { action: 'rename', target: 1, name: 'AA' });
    await expectOneUndo('tour', { action: 'reorder', names: ['B', 'A'] });
    await expectOneUndo('tour', { action: 'delete', target: 'b' });
    await expectOneUndo('tour', { action: 'update', target: 'A' });
  });

  it('reorder with a stop named twice (by number and name) is refused unchanged', async () => {
    await stops('A', 'B');
    await expectRejectedUnchanged('tour', { action: 'reorder', names: ['1', 'A'] }, /exactly once/);
    await expectRejectedUnchanged('tour', { action: 'rename', target: 'A', name: '' }, /needs `name`/);
  });

  it('a failing captureStop changes nothing', async () => {
    ui.captureStop.mockRejectedValueOnce(new Error('3D not ready'));
    await expectRejectedUnchanged('tour', { action: 'add' }, '3D not ready');
  });
});

describe('scene load hostility', () => {
  it('load is one undo step and keeps history', async () => {
    await seed();
    await expectOneUndo('scene', { action: 'new' });
    await expectOneUndo('scene', { action: 'demo' });
  });

  it.each([
    ['layers with null', { nodes: {}, edges: {}, layers: [null] }],
    ['nodes is a number', { nodes: 5, edges: {}, layers: [{ id: 'g', name: 'G', visible: true }] }],
    ['edges is a string', { nodes: {}, edges: 'x', layers: [{ id: 'g', name: 'G', visible: true }] }],
    ['layer without id', { nodes: {}, edges: {}, layers: [{}] }],
  ])('rejects junk scene (%s) and changes nothing', async (_n, scene) => {
    await seed();
    const before = snap();
    const r = await call('scene', { action: 'load', scene }).then(() => 'loaded', (e) => e);
    // BUG: validateScene (persist.ts:46-61) only checks that nodes/edges are truthy and layers is a non-empty
    // array. layers: [null] passes validation, then Store.load (store.ts:135) crashes *after* replacing the
    // scene and after replace() pushed a checkpoint: the call throws but the scene is now the junk one.
    // nodes: 5 / edges: "x" / a layer without an id load "successfully" and later edits crash or misbehave.
    expect(r).toBeInstanceOf(Error);
    expect(snap()).toEqual(before);
  });

  it('a loaded scene with edges to missing nodes does not crash readers', async () => {
    const scene = {
      nodes: { n_a: { id: 'n_a', kind: 'service', x: 0, y: 0, w: 10, h: 10, layer: 'g', height: 1, color: '#fff', label: 'A', capacity: 1, latency: 1 } },
      edges: { e_x: { id: 'e_x', from: 'n_a', to: 'n_ghost', label: '', dashed: false, mult: 1, flow: true } },
      layers: [{ id: 'g', name: 'G', visible: true }],
    };
    await call('scene', { action: 'load', scene });
    await call('get_scene');
    await call('simulate', {});
    await call('auto_layout', {});
    await call('journeys', { action: 'list' });
  });

  it('load with pages keeps every floor reachable', async () => {
    const scene = {
      nodes: {}, edges: {},
      layers: [{ id: 'a', name: 'A', visible: true, page: 'p1' }, { id: 'b', name: 'B', visible: true, page: 'p2' }],
      pages: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }, null, { name: 'no id' }],
    };
    const r = await call('scene', { action: 'load', scene });
    expect(r.pages).toBe(2);
    expect((await call('pages', { action: 'list' })).pages.map((p: any) => p.floors)).toEqual([['A'], ['B']]);
  });

  it('load of an exported scene round-trips', async () => {
    await seed();
    await call('pages', { action: 'add', name: 'Two' });
    const { scene } = await call('scene', { action: 'export' });
    await call('scene', { action: 'new' });
    await call('scene', { action: 'load', scene });
    expect(JSON.stringify(store.scene)).toBe(JSON.stringify(scene));
  });
});

describe('view', () => {
  it('an invalid focus applies nothing', async () => {
    await seed();
    const err = await call('view', { mode: 'play', simulate: true, multiplier: 2, focus: 'Nope' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // BUG: modeling8d_view applies mode/simulation/multiplier (tools.ts:577-582) before validating `focus`
    // (tools.ts:585), so a call that throws "No node" has still switched to 3D and started the simulation,
    // breaking the "applies fully or not at all" contract.
    expect(ui.setMode).not.toHaveBeenCalled();
    expect(ui.setSimulation).not.toHaveBeenCalled();
  });

  it('an invalid multiplier applies nothing', async () => {
    const err = await call('view', { mode: 'play', multiplier: -1 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // BUG: same ordering issue: setMode ran before the multiplier check.
    expect(ui.setMode).not.toHaveBeenCalled();
  });
});
