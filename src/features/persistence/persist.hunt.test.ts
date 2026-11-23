// @vitest-environment node
// Adversarial tests for validateScene / decodeScene / IndexedDB autosave: idempotence, JSON round trips,
// hostile shapes (prototype keys, arrays for objects, nulls), and "accepted means the app can render it".
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { decodeScene, idbGet, idbSet, validateScene } from './persist';
import { sceneOutline } from '../outline/outline';
import { sceneToHtml } from '../export/html';
import { encodeShare } from '../share/share';
import { demoScene } from '../samples/demo';
import { stressScene } from '../samples/stress';
import { pruneJourneys } from '../journeys/journeys';
import { layerShifts, pagePlacements } from '../../shared/model/pages';
import { emptyScene, KINDS, NodeKind, Scene, SNode } from '../../shared/model/types';

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
const KIND_LIST = Object.keys(KINDS) as NodeKind[];
const STRS = ['', 'A', '</script>', ' ', '😀', '__proto__', 'constructor', 'x'.repeat(300), '\ud800'];

/** Valid scene plus messy journeys/pages that validateScene is documented to clean. */
function genMessy(seed: number): any {
  const R = rng(seed);
  const int = (n: number) => Math.floor(R() * n);
  const pick = <T,>(a: readonly T[]) => a[int(a.length)];
  const pages = R() < 0.5 ? Array.from({ length: 1 + int(3) }, (_, i) => ({ id: `p${i}`, name: pick(STRS), extra: 1 })) : undefined;
  const layers = Array.from({ length: 1 + int(4) }, (_, i) => ({ id: `l${i}`, name: pick(STRS), visible: R() < 0.7, ...(pages && R() < 0.8 ? { page: pick(pages).id } : {}) }));
  const nodes: Record<string, SNode> = {};
  for (let i = 0; i < int(10); i++) {
    const kind = pick(KIND_LIST), d = KINDS[kind];
    nodes[`n_${i}`] = { id: `n_${i}`, kind, x: (R() - 0.5) * 2000, y: (R() - 0.5) * 2000, w: d.w, h: d.h, layer: pick(layers).id, height: d.height, color: d.color, label: pick(STRS), capacity: d.capacity, latency: d.latency, ...(R() < 0.2 ? { down: true } : {}) };
  }
  const ids = Object.keys(nodes);
  const edges: Record<string, unknown> = {};
  if (ids.length) for (let i = 0; i < int(12); i++) edges[`e_${i}`] = { id: `e_${i}`, from: pick(ids), to: pick(ids), label: pick(STRS), dashed: R() < 0.3, mult: pick([0, 1, 0.5]), flow: R() < 0.5 };
  const eids = Object.keys(edges);
  const junkSteps = () => [null, 5, 'x', {}, { edge: 'missing' }, { edge: pick(eids.length ? eids : ['missing']), note: pick(STRS), back: R() < 0.5 }];
  const journeys = R() < 0.2 ? 'nope' : [
    null, 7, { id: 5, steps: [] }, { id: 'nosteps' }, { id: 'j_ok', name: R() < 0.5 ? undefined : 42, color: R() < 0.5 ? null : '#fff', steps: junkSteps().filter(() => R() < 0.7), extra: 'x' },
  ];
  const s: any = { v: pick([1, 2, 0, undefined]), nodes, edges, layers, stops: R() < 0.3 ? undefined : [], journeys };
  if (pages) s.pages = R() < 0.2 ? [null, { id: 3 }] : [...pages, null, { name: 'no id' }];
  else if (R() < 0.3) s.pages = pick([null, 'x', {}, []]);
  return s;
}

/** What the app does with a loaded scene (store.load, outline, 3D layout, export, share); none may throw. */
function renderable(s: Scene) {
  pruneJourneys(s);
  void s.layers[s.layers.length - 1].id; // store.load picks the top layer as active
  sceneOutline(s);
  pagePlacements(s);
  layerShifts(s);
  sceneToHtml(s);
  encodeShare(s);
}

/** Either a clean rejection, or a scene the app can render. */
function acceptOrReject(input: unknown) {
  let s: Scene;
  try { s = validateScene(input); } catch (e) {
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(TypeError);
    return 'rejected';
  }
  expect(() => renderable(s)).not.toThrow();
  return 'accepted';
}

const node = (id: string, layer: string, over: Partial<SNode> = {}): SNode => ({ id, kind: 'service', x: 0, y: 0, w: 160, h: 90, layer, height: 70, color: '#4f7cff', label: id, capacity: 800, latency: 15, ...over });
const L = [{ id: 'l1', name: 'G', visible: true }];

async function legacyCode(text: string): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (const b of out) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('validateScene: properties over random messy scenes', () => {
  const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

  it('is idempotent: validate(validate(x)) deep-equals validate(x)', () => {
    for (const seed of SEEDS) {
      const a = validateScene(genMessy(seed));
      const b = validateScene(structuredClone(a));
      expect(b, `seed ${seed}`).toEqual(a);
    }
  });

  it('survives a JSON round trip (file save/open) unchanged', () => {
    for (const seed of SEEDS) {
      const a = validateScene(genMessy(seed));
      expect(validateScene(JSON.parse(JSON.stringify(a))), `seed ${seed}`).toEqual(JSON.parse(JSON.stringify(a)));
    }
  });

  it('normalizes journeys: only objects with string id and steps array; steps point at existing edges', () => {
    for (const seed of SEEDS) {
      const s = validateScene(genMessy(seed));
      expect(Array.isArray(s.journeys)).toBe(true);
      for (const j of s.journeys) {
        expect(typeof j.id).toBe('string');
        expect(typeof j.name).toBe('string');
        expect(typeof j.color).toBe('string');
        expect(Object.keys(j).sort()).toEqual(['color', 'id', 'name', 'steps']);
        for (const st of j.steps) expect(Object.hasOwn(s.edges, st.edge)).toBe(true);
      }
    }
  });

  it('normalizes pages: absent, or a non-empty list of {id: string, name: string}', () => {
    for (const seed of SEEDS) {
      const s = validateScene(genMessy(seed));
      if (!('pages' in s)) continue;
      expect(s.pages!.length).toBeGreaterThan(0);
      for (const p of s.pages!) {
        expect(Object.keys(p).sort()).toEqual(['id', 'name']);
        expect(typeof p.id).toBe('string');
        expect(typeof p.name).toBe('string');
      }
    }
  });

  it('always yields v: 1 and a stops array', () => {
    for (const seed of SEEDS) {
      const s = validateScene(genMessy(seed));
      expect(s.v).toBe(1);
      expect(Array.isArray(s.stops)).toBe(true);
    }
  });

  it('every accepted random scene is renderable', () => {
    for (const seed of SEEDS) expect(acceptOrReject(genMessy(seed)), `seed ${seed}`).toBe('accepted');
  });

  it('bundled samples pass unchanged', () => {
    for (const s of [demoScene(), stressScene(300), emptyScene()]) expect(validateScene(structuredClone(s))).toEqual(s);
  });
});

describe('validateScene: garbage is rejected with a clean Error', () => {
  it.each([
    ['null', null], ['undefined', undefined], ['number', 0], ['string', 'scene'], ['true', true], ['array', []], ['empty object', {}],
    ['no edges', { nodes: {}, layers: L }], ['no nodes', { edges: {}, layers: L }], ['layers object', { nodes: {}, edges: {}, layers: { 0: L[0] } }],
    ['empty layers', { nodes: {}, edges: {}, layers: [] }], ['layers string', { nodes: {}, edges: {}, layers: 'l1' }],
    ['nodes null', { nodes: null, edges: {}, layers: L }], ['edges 0', { nodes: {}, edges: 0, layers: L }],
  ])('%s', (_, input) => {
    expect(() => validateScene(input)).toThrow('Not an 8D modeling scene');
  });

  it('JSON with __proto__ keys does not pollute Object.prototype', () => {
    const s = validateScene(JSON.parse('{"__proto__":{"polluted":1},"nodes":{"__proto__":{"polluted2":1}},"edges":{},"layers":[{"id":"l1","name":"G","visible":true}],"journeys":[{"id":"j","steps":[],"__proto__":{"p3":1}}],"pages":[{"id":"p","__proto__":{"p4":1}}]}'));
    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    expect(probe.polluted2).toBeUndefined();
    expect(probe.p3).toBeUndefined();
    expect(probe.p4).toBeUndefined();
    expect(s.journeys[0]).toEqual({ id: 'j', name: 'Journey', color: '#f472b6', steps: [] });
    expect(s.pages).toEqual([{ id: 'p', name: 'Page' }]);
  });

  it('journey ids that are not strings and steps that are not arrays are dropped', () => {
    const s = validateScene({ nodes: {}, edges: {}, layers: L, journeys: [{ id: 1, steps: [] }, { id: 'a', steps: {} }, { id: 'b', steps: 'x' }, { id: 'c', steps: [] }] });
    expect(s.journeys.map((j) => j.id)).toEqual(['c']);
  });
});

// The checks above only look at the top-level shape. These inputs pass validateScene but then crash the
// app (store.load / outline / 3D layout / export), which is the "accepted means renderable" contract.
// App.tsx:105 loads the autosave with `store.load(validateScene(saved))`, so a corrupt autosave that passes
// validation but crashes rendering would break every reload; the agent's set_scene tool also relies on it.
describe('validateScene: accepted scenes must be renderable', () => {
  // BUG: persist.ts:47 accepts `nodes` entries that are null; sceneOutline / pagePlacements then throw
  // "Cannot read properties of null". Expected: reject (or drop the entry). Fix: validate each node is an
  // object with a known kind, string id and layer, numeric x/y/w/h (or drop bad ones).
  it('null node entry', () => {
    expect(acceptOrReject({ nodes: { a: null }, edges: {}, layers: L })).toBeDefined();
  });

  // BUG: persist.ts:47 accepts a string for `nodes` (truthy); Object.values('ab') = ['a','b'] become "nodes".
  // Expected: rejected as not a scene. Fix: require plain objects for nodes and edges.
  it('nodes given as a string', () => {
    expect(acceptOrReject({ nodes: 'ab', edges: {}, layers: L })).toBeDefined();
  });

  // BUG: persist.ts:47 accepts nodes with an unknown kind (legacy #s= links and opened files never check kinds,
  // unlike #z= links); sceneOutline then throws reading KINDS[kind].name. Expected: reject or drop the node.
  it('unknown node kind', () => {
    expect(acceptOrReject({ nodes: { a: node('a', 'l1', { kind: 'bogus' as NodeKind }) }, edges: {}, layers: L })).toBeDefined();
  });

  // BUG: persist.ts:47 accepts null edge entries; sceneOutline throws reading e.from. Expected: reject or drop.
  it('null edge entry', () => {
    expect(acceptOrReject({ nodes: { a: node('a', 'l1') }, edges: { e: null }, layers: L })).toBeDefined();
  });

  // BUG: persist.ts:47 accepts `layers: [null]` (non-empty array); layerPages throws reading l.id. Expected:
  // reject or drop non-object layers (and reject if none are left).
  it('null layer entry', () => {
    expect(acceptOrReject({ nodes: {}, edges: {}, layers: [null] })).toBeDefined();
  });

  // BUG: persist.ts:50 only defaults stops when null/undefined; `stops: {}` or a string is kept and the exported
  // viewer crashes at `stops.map` (html.ts:277; `sc.stops || []` lets a truthy non-array through). Expected: non-arrays reset to []. Fix: `if (!Array.isArray(s.stops)) s.stops = []`.
  it('stops that are not an array are reset', () => {
    for (const stops of [{}, 'x', 5]) {
      const s = validateScene({ nodes: {}, edges: {}, layers: L, stops });
      expect(Array.isArray(s.stops)).toBe(true);
    }
  });

  // BUG: persist.ts:53 keeps steps whose edge is an inherited name ("constructor", "toString", "__proto__")
  // because `s.edges[st.edge]` is truthy for them. Expected: dropped. Fix: `Object.hasOwn(s.edges, st.edge)`.
  it('journey steps naming Object.prototype members are dropped', () => {
    const s = validateScene({ nodes: {}, edges: {}, layers: L, journeys: [{ id: 'j', steps: [{ edge: 'constructor' }, { edge: 'toString' }, { edge: '__proto__' }, { edge: 'valueOf' }] }] });
    expect(s.journeys[0].steps).toEqual([]);
  });

  it('edges whose ends are missing are tolerated by every view', () => {
    expect(acceptOrReject({ nodes: { a: node('a', 'l1') }, edges: { e: { id: 'e', from: 'a', to: 'ghost', label: 'x', dashed: false, mult: 1, flow: true } }, layers: L })).toBe('accepted');
  });

  it('layer.page pointing at a missing page and pages with no layers are tolerated', () => {
    expect(acceptOrReject({ nodes: { a: node('a', 'l1') }, edges: {}, layers: [{ ...L[0], page: 'nope' }], pages: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }] })).toBe('accepted');
  });

  it('a node on a layer that does not exist does not crash (but see the orphan note in outline.hunt)', () => {
    expect(acceptOrReject({ nodes: { a: node('a', 'ghost') }, edges: {}, layers: L })).toBe('accepted');
  });

  it('nodes as an array is rejected (ids would be indexes)', () => {
    expect(() => validateScene({ nodes: [node('a', 'l1')], edges: {}, layers: L })).toThrow('Not an 8D modeling scene');
  });
});

describe('decodeScene (legacy #s= payload)', () => {
  it('round-trips random scenes as JSON', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const a = validateScene(genMessy(seed));
      const text = JSON.stringify(a);
      expect(await decodeScene(await legacyCode(text))).toEqual(JSON.parse(text));
    }
  });

  it('valid deflate of non-JSON or a non-scene rejects with an Error', async () => {
    for (const text of ['', 'not json', 'null', '[]', '{"nodes":{}}', '"str"', '{"nodes":{},"edges":{},"layers":[]}']) {
      await expect(decodeScene(await legacyCode(text))).rejects.toBeInstanceOf(Error);
    }
  });

  it('handles U+2028 and lone surrogates (escaped by JSON.stringify) in labels', async () => {
    const s = validateScene({ nodes: { a: node('a', 'l1', { label: ' \ud800😀' }) }, edges: {}, layers: L });
    expect((await decodeScene(await legacyCode(JSON.stringify(s)))).nodes.a.label).toBe(' \ud800😀');
  });
});

describe('IndexedDB autosave', () => {
  it('stores and returns random scenes unchanged, last write wins', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const a = validateScene(genMessy(seed));
      await idbSet('scene', a);
      const back = await idbGet<Scene>('scene');
      expect(back).toEqual(a);
      expect(validateScene(back)).toEqual(a);
    }
  });

  it('keys are independent; missing keys read as undefined', async () => {
    await idbSet('k1', { a: 1 });
    await idbSet('k2', [1, 2]);
    expect(await idbGet('k1')).toEqual({ a: 1 });
    expect(await idbGet('k2')).toEqual([1, 2]);
    expect(await idbGet('never-written')).toBeUndefined();
    expect(await idbGet('')).toBeUndefined();
  });

  it('concurrent writes all complete and the last one queued wins', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => idbSet('race', i)));
    expect(await idbGet('race')).toBe(19);
  });

  it('a stress scene (2000 nodes) survives', async () => {
    const s = stressScene();
    await idbSet('big', s);
    expect(await idbGet('big')).toEqual(s);
  });

  it('an uncloneable value rejects instead of hanging', async () => {
    await expect(idbSet('bad', { f: () => 1 })).rejects.toBeDefined();
    expect(await idbGet('bad')).toBeUndefined();
  });

  // A transient open failure (e.g. "blocked" or a quota error) must not break autosave until reload.
  it('a failed open is retried on the next call', async () => {
    vi.resetModules();
    const real = globalThis.indexedDB;
    const failing = { open: () => { const r: any = {}; queueMicrotask(() => { r.error = new Error('boom'); r.onerror?.(); }); return r; } };
    vi.stubGlobal('indexedDB', failing);
    const fresh = await import('./persist');
    await expect(fresh.idbGet('scene')).rejects.toThrow('boom');
    vi.stubGlobal('indexedDB', real);
    await fresh.idbSet('k', 1);
    expect(await fresh.idbGet('k')).toBe(1);
    vi.unstubAllGlobals();
  });
});
