// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../shared/model/store';
import type { Stop } from '../../shared/model/types';
import { layerPages } from '../../shared/model/pages';
import { AgentUI, createTools, ToolDef } from './tools';
import { createPageApi } from './pageApi';

// Batch atomicity, undo accounting and a seeded random walk over the tools checking scene invariants.

let store: Store;
let ui: { [K in keyof AgentUI]: ReturnType<typeof vi.fn> };
let tools: Record<string, ToolDef>;
let list: ToolDef[];
let cam = 0;

const call = async (name: string, input?: unknown) => JSON.parse(await tools[`modeling8d_${name}`].execute(input));
const node = (label: string) => Object.values(store.scene.nodes).find((n) => n.label === label)!;
const snap = () => ({ scene: JSON.stringify(store.scene), mark: store.undoDepth, redo: store.canRedo });

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
  list = createTools(store, ui as unknown as AgentUI);
  tools = Object.fromEntries(list.map((t) => [t.name, t]));
});

async function seed() {
  await call('add_nodes', { nodes: [{ kind: 'client', label: 'Web' }, { kind: 'service', label: 'API' }, { kind: 'database', label: 'DB' }] });
  await call('connect', { edges: [{ from: 'Web', to: 'API' }, { from: 'API', to: 'DB' }] });
}

const BAD = { tool: 'add_nodes', input: { nodes: [{ kind: 'bogus', label: 'X' }] } };

describe('batch', () => {
  it('success is exactly one undo step back to the start', async () => {
    await seed();
    const before = JSON.stringify(store.scene);
    const mark = store.undoDepth;
    await call('batch', {
      calls: [
        { tool: 'add_nodes', input: { nodes: [{ kind: 'cache', label: 'C' }] } },
        { tool: 'connect', input: { edges: [{ from: 'API', to: 'C' }] } },
        { tool: 'layers', input: { action: 'add', names: ['Top'] } },
        { tool: 'update', input: JSON.stringify({ updates: [{ target: 'C', layer: 'Top' }] }) },
        { tool: 'journeys', input: { action: 'create', name: 'J', start: 'Web', steps: [{ to: 'C' }] } },
        { tool: 'tour', input: { action: 'add', name: 'V' } },
        { tool: 'pages', input: { action: 'add', name: 'Two' } },
        { tool: 'auto_layout' },
      ],
    });
    expect(store.undoDepth).toBe(mark + 1);
    await call('undo');
    expect(JSON.stringify(store.scene)).toBe(before);
  });

  it('a batch of read-only tools adds no undo step', async () => {
    await seed();
    const before = snap();
    await call('batch', { calls: [{ tool: 'get_scene' }, { tool: 'simulate', input: { seconds: 1 } }, { tool: 'journeys', input: { action: 'list' } }, { tool: 'share_link' }] });
    expect(snap()).toEqual(before);
  });

  it('failure after scene new restores the scene and history', async () => {
    await seed();
    const before = snap();
    await expect(call('batch', { calls: [{ tool: 'scene', input: { action: 'new' } }, BAD] })).rejects.toThrow(/Call 2/);
    expect(snap()).toEqual(before);
  });

  it('failure keeps the open page', async () => {
    await seed();
    await call('pages', { action: 'add', name: 'Two' });
    await call('pages', { action: 'open', target: 1 });
    const page = store.activePage;
    const layer = store.activeLayer;
    await expect(call('batch', { calls: [{ tool: 'pages', input: { action: 'add', name: 'Three' } }, BAD] })).rejects.toThrow();
    // BUG: Store.rollback reloads the scene but not the view state; the active layer (deleted by the rollback)
    // falls back to the *last* layer in the scene (store.ts:136), which is on page "Two". A failed batch, that
    // promises "nothing was changed", switches the open page.
    expect(store.activeLayer).toBe(layer);
    expect(store.activePage).toBe(page);
  });

  it('failure keeps the selection', async () => {
    await seed();
    store.select([node('API').id]);
    await expect(call('batch', { calls: [{ tool: 'add_nodes', input: { nodes: [{ kind: 'cache', label: 'C' }] } }, BAD] })).rejects.toThrow();
    // BUG (minor, view state): add_nodes inside the batch replaced the selection; rollback only prunes ids that no longer exist,
    // so the user's selection (API) is lost after a batch that "changed nothing".
    expect([...store.selection]).toEqual([node('API').id]);
  });

  it('failure keeps the focused floor', async () => {
    await call('layers', { action: 'add', names: ['Top'] });
    await call('layers', { action: 'focus', target: 'Ground' });
    const active = store.activeLayer;
    await expect(call('batch', { calls: [{ tool: 'layers', input: { action: 'focus', target: 'Top' } }, BAD] })).rejects.toThrow();
    // BUG (minor, view state): layers focus inside a failed batch is not rolled back (rollback restores only the scene JSON).
    expect(store.activeLayer).toBe(active);
  });

  it('failure keeps the journey on screen', async () => {
    await seed();
    await call('journeys', { action: 'create', name: 'J', start: 'Web', steps: [{ to: 'DB' }] });
    await call('journeys', { action: 'show' }); // hide
    await expect(call('batch', { calls: [{ tool: 'journeys', input: { action: 'show', id: 'J' } }, BAD] })).rejects.toThrow();
    // BUG (minor, view state): store.journey changed by a call inside a failed batch survives the rollback.
    expect(store.journey).toBeNull();
  });

  it('failure after an undo inside the batch keeps the undo history', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'A' }] });
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'B' }] });
    const before = snap();
    await expect(call('batch', { calls: [{ tool: 'undo' }, BAD] })).rejects.toThrow();
    expect(JSON.stringify(store.scene)).toBe(before.scene);
    // BUG: rollback truncates history to min(past.length, mark) (store.ts:108). The undo inside the batch popped a
    // pre-batch entry, so after rollback that entry is gone: the user can no longer undo adding B.
    expect(store.undoDepth).toBe(before.mark);
    await call('undo');
    expect(Object.values(store.scene.nodes).map((n) => n.label)).toEqual(['A']);
  });

  it('failure after a redo inside the batch keeps redo available', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'A' }] });
    await call('undo');
    const before = snap();
    await expect(call('batch', { calls: [{ tool: 'redo' }, BAD] })).rejects.toThrow();
    // BUG: redo inside the failed batch consumed the redo stack (future), rollback does not restore it.
    expect(snap()).toEqual(before);
  });

  it('successful batch with an undo of a pre-batch change undoes cleanly', async () => {
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'A' }] });
    await call('add_nodes', { nodes: [{ kind: 'service', label: 'B' }] });
    const beforeBatch = JSON.stringify(store.scene);
    await call('batch', { calls: [{ tool: 'undo' }, { tool: 'add_nodes', input: { nodes: [{ kind: 'service', label: 'C' }] } }] });
    expect(Object.values(store.scene.nodes).map((n) => n.label).sort()).toEqual(['A', 'C']);
    // BUG: squash (store.ts:100) returns early when past.length <= mark; the inner undo popped one pre-batch entry and
    // add_nodes pushed one, so nothing is squashed and one Ctrl+Z only removes C, leaving {A} instead of {A, B}.
    await call('undo');
    expect(JSON.stringify(store.scene)).toBe(beforeBatch);
  });

  it('ui side effects in a failed batch are reported but the scene is intact', async () => {
    await seed();
    const before = snap();
    await expect(call('batch', { calls: [{ tool: 'view', input: { mode: 'play' } }, { tool: 'auto_layout' }, BAD] })).rejects.toThrow(/nothing was changed/);
    expect(snap()).toEqual(before);
  });

  it('a null call entry is a clear error', async () => {
    await expect(call('batch', { calls: [null] })).rejects.toThrow('Call 1: unknown tool "undefined"');
    await expect(call('batch', { calls: 'x' })).rejects.toThrow('calls must be a non-empty array');
  });

  it('batch of a no-op mutation adds no undo step', async () => {
    await seed();
    const mark = store.undoDepth;
    await call('batch', { calls: [{ tool: 'connect', input: { edges: [{ from: 'Web', to: 'API' }] } }] });
    // BUG (minor): a batch that changed nothing still squashes into one (empty) undo step.
    expect(store.undoDepth).toBe(mark);
  });
});

describe('page API', () => {
  it('failures resolve to {error} and change nothing', async () => {
    const api = createPageApi(async () => list, 'docs');
    await seed();
    const before = snap();
    expect(await api.call('add_nodes', { nodes: 'x' })).toEqual({ error: 'nodes must be a non-empty array' });
    expect(await api.batch([{ tool: 'add_nodes', input: { nodes: [{ kind: 'cache', label: 'C' }] } }, BAD])).toEqual({ error: expect.stringContaining('nothing was changed') });
    expect(await api.call('nope')).toEqual({ error: expect.stringContaining('Unknown tool "nope"') });
    expect(snap()).toEqual(before);
    expect(await api.tools.get_scene()).toMatchObject({ nodes: expect.any(Array) });
    expect((await api.help()).tools).toHaveLength(17);
  });

  it('call with a JSON-string input works', async () => {
    const api = createPageApi(async () => list, 'docs');
    const r: any = await api.call('add_nodes', JSON.stringify({ nodes: [{ kind: 'service', label: 'S' }] }));
    expect(r.created).toHaveLength(1);
  });

  it('a proxy property like then does not make the tools object a thenable', async () => {
    const api = createPageApi(async () => list, 'docs');
    // `await api.tools` would call tools.then(...) and hang if the Proxy answered every name.
    const t: any = api.tools;
    // BUG (minor): the Proxy returns a function for *every* string key, including "then", so `await modeling8d.tools`
    // (or returning it from an async function) treats it as a thenable and calls tool "then" with the resolve callbacks.
    expect(typeof t.then).toBe('undefined');
  });
});

// ---------------------------------------------------------------- seeded random walk

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

function invariants() {
  const s = store.scene;
  const layerIds = new Set(s.layers.map((l) => l.id));
  const problems: string[] = [];
  for (const n of Object.values(s.nodes)) {
    if (!layerIds.has(n.layer)) problems.push(`node ${n.label} on missing layer`);
    for (const k of ['x', 'y', 'w', 'h', 'capacity'] as const) if (typeof n[k] !== 'number' || !Number.isFinite(n[k])) problems.push(`node ${n.label}.${k}=${n[k]}`);
  }
  const lp = layerPages(s);
  for (const e of Object.values(s.edges)) {
    if (!s.nodes[e.from] || !s.nodes[e.to]) problems.push(`dangling edge ${e.id}`);
    else if (lp.get(s.nodes[e.from].layer) !== lp.get(s.nodes[e.to].layer)) problems.push(`cross-page edge ${e.id}`);
    if (e.from === e.to) problems.push(`self edge ${e.id}`);
  }
  if (!layerIds.has(store.activeLayer)) problems.push('active layer missing');
  for (const j of s.journeys) for (const st of j.steps) if (!s.edges[st.edge]) problems.push(`journey step on missing edge`);
  return problems;
}

describe('random walk', () => {
  const KINDS = ['service', 'database', 'queue', 'cache', 'lb', 'client', 'zone', 'text'];
  for (const [seedNo, heal] of [1, 2, 3, 4, 5, 6, 7, 8].flatMap((k) => [[k, false], [k, true]] as [number, boolean][])) {
    it(`seed ${seedNo}${heal ? ' (dangling active floor healed)' : ''}: failures change nothing, successes undo in one step, invariants hold`, async () => {
      const r = rng(seedNo);
      const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)];
      const labels = () => Object.values(store.scene.nodes).map((n) => n.label);
      const someLabel = () => (labels().length && r() < 0.9 ? pick(labels()) : 'Ghost');
      const floor = () => pick([...store.scene.layers.map((l) => l.name), 'New floor', 'Ground']);
      const gen = (): [string, any] => {
        switch (Math.floor(r() * 11)) {
          case 0: case 1:
            return ['add_nodes', { nodes: Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ kind: r() < 0.95 ? pick(KINDS) : 'bogus', label: `N${Math.floor(r() * 12)}`, ...(r() < 0.3 ? { layer: floor() } : {}) })) }];
          case 2: case 3:
            return ['connect', { edges: [{ from: someLabel(), to: someLabel(), mult: Math.round(r() * 3 * 10) / 10 }] }];
          case 4:
            return ['update', { updates: [{ target: someLabel(), ...(r() < 0.5 ? { x: Math.round(r() * 500) } : { layer: floor() }) }] }];
          case 5:
            return ['delete', { targets: [someLabel()] }];
          case 6:
            return ['layers', pick([{ action: 'add', names: ['F' + Math.floor(r() * 5)] }, { action: 'delete', target: floor(), deleteNodes: r() < 0.5 }, { action: 'focus', target: floor() }])];
          case 7:
            return ['pages', pick([{ action: 'add' }, { action: 'open', target: 1 + Math.floor(r() * 3) }, { action: 'delete', target: 1 + Math.floor(r() * 3) }])];
          case 8:
            return ['journeys', { action: 'create', start: someLabel(), steps: [{ to: someLabel() }] }];
          case 9:
            return ['auto_layout', {}];
          default:
            return ['batch', { calls: [{ tool: 'add_nodes', input: { nodes: [{ kind: 'service', label: `B${Math.floor(r() * 5)}` }] } }, { tool: 'connect', input: { edges: [{ from: someLabel(), to: someLabel() }] } }] }];
        }
      };
      const VIEW_ONLY = new Set(['layers:focus', 'pages:open']);
      const log: string[] = [];
      for (let i = 0; i < 120; i++) {
        const [name, input] = gen();
        const before = snap();
        const tag = `${i} ${name} ${JSON.stringify(input)}`;
        let ok = true;
        try { await call(name, input); } catch (e) { ok = false; log.push(`${tag} -> ${(e as Error).message}`); }
        if (!ok) {
          expect(snap(), `failed call changed state: ${tag}`).toEqual(before);
        } else if (!VIEW_ONLY.has(`${name}:${input.action}`)) {
          const after = JSON.stringify(store.scene);
          if (store.undoDepth === before.mark + 1) {
            const activeLayer = store.activeLayer;
            await call('undo');
            expect(JSON.stringify(store.scene), `undo of ${tag}`).toBe(before.scene);
            await call('redo');
            expect(JSON.stringify(store.scene), `redo of ${tag}`).toBe(after);
            store.setActiveLayer(activeLayer); // undo/redo may move the active floor; keep the walk deterministic
          } else {
            expect(store.undoDepth, `history of ${tag}`).toBe(before.mark); // delete with nothing selected etc.
          }
        }
        // heal: re-point a dangling active floor (known bug) so the walk can look for other defects
        if (heal && !store.scene.layers.some((l) => l.id === store.activeLayer)) store.setActiveLayer(store.scene.layers[0].id);
        const p = invariants();
        expect(p, `after ${tag}\n${log.slice(-5).join('\n')}`).toEqual([]);
      }
    });
  }
});
