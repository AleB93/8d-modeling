// @vitest-environment node
// Adversarial tests for share links: seeded random scenes with hostile strings and numbers, round-tripped
// through #z= and legacy #s= links, URI handling, corruption, and payloads crafted by hand.
import { encode } from '@ab19993/zip-string';
import { describe, expect, it } from 'vitest';
import { decodeShare, encodeShare, ShareView } from './share';
import { SHARE_DICT } from './shareDict';
import { validateScene } from '../persistence/persist';
import { sceneOutline } from '../outline/outline';
import { sceneToHtml } from '../export/html';
import { demoScene } from '../samples/demo';
import { stressScene } from '../samples/stress';
import { layerShifts, pagePlacements } from '../../shared/model/pages';
import { JStep, KINDS, Layer, NodeKind, Scene, SEdge, SNode } from '../../shared/model/types';

// ---------- seeded random scene generator ----------
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
const NASTY = [
  '', 'Web', 'Service', 'Text', 'Database', '</script>', '</SCRIPT >', '<!--', '-->', '<script>alert(1)</script>',
  '"\'`', '\\', '\\u003c', ' ', ' ', 'a b c', '😀👩‍💻🏳️‍🌈', 'naïve ☃ 中文 עברית', '\ud800', '\udfff x',
  '__proto__', 'constructor', 'toString', '%', '%25', '%zz', '#z=abc', '#s=', '\n\t\r', '\0', ' ', 'x'.repeat(5000), '&amp;', '${x}',
];
const NUMS = [0, 1, -1, 0.5, -0.25, 1e21, -1e21, 1 / 3, 0.1 + 0.2, 123456789.123, 2 ** 31, -(2 ** 31), 2 ** 32 + 1, 2 ** 53 - 1, -(2 ** 53 - 1), 1e-7, 5e-324, Number.MAX_VALUE, -Number.MAX_VALUE, 7, 160, 90];

function genScene(seed: number, opts: { pages?: boolean } = {}): Scene {
  const R = rng(seed);
  const int = (n: number) => Math.floor(R() * n);
  const pick = <T,>(a: readonly T[]) => a[int(a.length)];
  const chance = (p: number) => R() < p;
  const uni = () => {
    let s = '';
    const len = int(12);
    for (let i = 0; i < len; i++) {
      const r = R();
      const cp = r < 0.5 ? 32 + int(95) : r < 0.8 ? 0xa0 + int(0x2000) : r < 0.95 ? 0x10000 + int(0x10000) : int(32);
      s += String.fromCodePoint(cp);
    }
    return s;
  };
  const str = () => (chance(0.5) ? pick(NASTY) : uni());
  const num = () => (chance(0.4) ? pick(NUMS) : Math.round((R() - 0.5) * 4000 * 100) / (chance(0.5) ? 1 : 100));
  const usePages = opts.pages ?? chance(0.6);
  const pages = usePages ? Array.from({ length: 1 + int(3) }, (_, i) => ({ id: `p_${seed}_${i}`, name: str() })) : undefined;
  const layers: Layer[] = Array.from({ length: 1 + int(4) }, (_, i) => {
    const l: Layer = { id: `l_${seed}_${i}`, name: str(), visible: chance(0.75) };
    if (pages && chance(0.85)) l.page = pick(pages).id;
    return l;
  });
  const nodes: Record<string, SNode> = {};
  const nN = int(14);
  for (let i = 0; i < nN; i++) {
    const kind = pick(KIND_LIST);
    const d = KINDS[kind];
    const n: SNode = {
      id: `n_${seed}_${i}`, kind, x: num(), y: num(), w: chance(0.5) ? d.w : num(), h: chance(0.5) ? d.h : num(),
      layer: pick(layers).id, height: chance(0.5) ? d.height : num(), color: chance(0.5) ? d.color : pick(['#000000', '#ffffff', str()]),
      label: chance(0.3) ? (kind === 'text' ? 'Text' : d.name) : str(),
      capacity: chance(0.5) ? d.capacity : num(), latency: chance(0.5) ? d.latency : num(),
    };
    const dn = int(3);
    if (dn === 1) n.down = true;
    else if (dn === 2) n.down = false;
    nodes[n.id] = n;
  }
  const ids = Object.keys(nodes);
  const edges: Record<string, SEdge> = {};
  if (ids.length) {
    for (let i = 0, m = int(20); i < m; i++) {
      const e: SEdge = {
        id: `e_${seed}_${i}`, from: pick(ids), to: pick(ids), label: chance(0.5) ? '' : str(), dashed: chance(0.3),
        mult: pick([1, 1, 0, 0.3, 2, 1e-9, 1000]), flow: chance(0.7),
      };
      edges[e.id] = e;
    }
  }
  const eids = Object.keys(edges);
  const journeys = eids.length
    ? Array.from({ length: int(3) }, (_, i) => ({
      id: `j_${seed}_${i}`, name: str(), color: pick(['#f472b6', '#38bdf8', str()]),
      steps: Array.from({ length: int(6) }, () => {
        const st: JStep = { edge: pick(eids) };
        const b = int(3);
        if (b === 1) st.back = true;
        else if (b === 2) st.back = false;
        const nt = int(3);
        if (nt === 1) st.note = str();
        else if (nt === 2) st.note = '';
        return st;
      }),
    }))
    : [];
  const stops = Array.from({ length: int(3) }, (_, i) => {
    const s: Scene['stops'][number] = { id: `s_${seed}_${i}`, name: str(), pos: [num(), num(), num()], target: [num(), num(), num()] };
    if (journeys.length && chance(0.5)) s.journey = pick(journeys).id;
    return s;
  });
  const s: Scene = { v: 1, nodes, edges, layers, stops, journeys };
  if (pages) s.pages = pages;
  return s;
}

/** What a share link is documented to keep: defaults restored, `down: false`/`back: false`/empty notes dropped, -0 → 0. */
function expectedAfterShare(s: Scene): Scene {
  const o: Scene = JSON.parse(JSON.stringify(s));
  for (const n of Object.values(o.nodes)) if (!n.down) delete n.down;
  for (const j of o.journeys) for (const st of j.steps) { if (!st.back) delete st.back; if (!st.note) delete st.note; }
  return o;
}

/** Things the app does with a loaded scene; none of them may throw. */
function renderable(s: Scene) {
  sceneOutline(s);
  pagePlacements(s);
  layerShifts(s);
  sceneToHtml(s);
  encodeShare(s);
}

const zHash = (p: unknown) => '#z=' + encode(p, { dictionary: SHARE_DICT });

async function legacyCode(scene: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(scene));
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (const b of out) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe('share links: randomized round trips', () => {
  it('generator is deterministic', () => {
    expect(genScene(42)).toEqual(genScene(42));
    expect(genScene(42)).not.toEqual(genScene(43));
  });

  it('decodeShare(encodeShare(s)) restores every random scene (300 seeds)', async () => {
    for (const seed of SEEDS) {
      const s = genScene(seed);
      const out = await decodeShare('#' + encodeShare(s));
      expect(out!.scene, `seed ${seed}`).toEqual(expectedAfterShare(s));
      expect(out!.view).toBeUndefined();
    }
  });

  // Not byte-identical on the first pass (decoded objects get a different key order), but a decoded
  // scene re-shares to the same scene, and from then on to the same bytes.
  it('re-sharing a decoded scene is stable: same scene, then same bytes', async () => {
    for (const seed of SEEDS.slice(0, 120)) {
      const s1 = (await decodeShare('#' + encodeShare(genScene(seed))))!.scene;
      const c2 = encodeShare(s1);
      const s2 = (await decodeShare('#' + c2))!.scene;
      expect(s2, `seed ${seed}`).toEqual(s1);
      expect(encodeShare(s2), `seed ${seed}`).toBe(c2);
    }
  });

  it('decoded scenes are renderable and stable under validateScene', async () => {
    for (const seed of SEEDS.slice(0, 120)) {
      const out = (await decodeShare('#' + encodeShare(genScene(seed))))!.scene;
      expect(() => renderable(out)).not.toThrow();
      expect(validateScene(structuredClone(out))).toEqual(out);
    }
  });

  it('pages and layer.page survive (scenes with explicit pages)', async () => {
    for (const seed of SEEDS.slice(0, 80)) {
      const s = genScene(seed, { pages: true });
      const out = (await decodeShare('#' + encodeShare(s)))!.scene;
      expect(out.pages).toEqual(s.pages);
      expect(out.layers.map((l) => l.page)).toEqual(s.layers.map((l) => l.page));
      expect(pagePlacements(out)).toEqual(pagePlacements(expectedAfterShare(s)));
    }
  });

  it('legacy scenes without pages stay without pages', async () => {
    for (const seed of SEEDS.slice(0, 60)) {
      const s = genScene(seed, { pages: false });
      const out = (await decodeShare('#' + encodeShare(s)))!.scene;
      expect(out).not.toHaveProperty('pages');
      for (const l of out.layers) expect(l).not.toHaveProperty('page');
    }
  });

  it('hostile numbers are exact: 1e21, 5e-324, MAX_VALUE, 2^53-1, 0.1+0.2; -0 becomes 0', async () => {
    const s = genScene(7);
    const n = Object.values(s.nodes)[0] ?? genScene(8).nodes[Object.keys(genScene(8).nodes)[0]];
    const sc: Scene = { v: 1, nodes: {}, edges: {}, layers: [{ id: 'l1', name: 'G', visible: true }], stops: [], journeys: [] };
    const vals = [1e21, 5e-324, Number.MAX_VALUE, 2 ** 53 - 1, 0.1 + 0.2, -1e-300, 1.7976931348623157e308, 4294967296.5];
    vals.forEach((x, i) => { sc.nodes['n' + i] = { ...n, id: 'n' + i, layer: 'l1', x, y: -x, w: x, h: x / 3 }; });
    sc.nodes.neg = { ...n, id: 'neg', layer: 'l1', x: -0, y: -0 };
    sc.stops.push({ id: 's', name: 's', pos: [1e21, -0, 1 / 3], target: [5e-324, 2 ** 53 - 1, -(2 ** 31)] });
    const out = (await decodeShare('#' + encodeShare(sc)))!.scene;
    vals.forEach((x, i) => {
      expect(out.nodes['n' + i].x).toBe(x);
      expect(out.nodes['n' + i].y).toBe(-x);
      expect(out.nodes['n' + i].h).toBe(x / 3);
    });
    expect(Object.is(out.nodes.neg.x, 0)).toBe(true);
    expect(out.stops[0].pos).toEqual([1e21, 0, 1 / 3]);
    expect(out.stops[0].target).toEqual([5e-324, 2 ** 53 - 1, -(2 ** 31)]);
  });

  it('hostile strings are exact, incl. lone surrogates, U+2028, NUL and 5000-char labels', async () => {
    const sc: Scene = { v: 1, nodes: {}, edges: {}, layers: [{ id: 'l1', name: '\ud800', visible: false }], stops: [], journeys: [] };
    NASTY.forEach((label, i) => { sc.nodes['n_' + i] = { id: 'n_' + i, kind: 'service', x: i, y: 0, w: 160, h: 90, layer: 'l1', height: 70, color: '#4f7cff', label, capacity: 800, latency: 15 }; });
    const out = (await decodeShare('#' + encodeShare(sc)))!.scene;
    NASTY.forEach((label, i) => expect(out.nodes['n_' + i].label).toBe(label));
    expect(out.layers[0].name).toBe('\ud800');
  });
});

describe('share links: view state', () => {
  function genView(seed: number): ShareView {
    const R = rng(seed * 7919);
    const f = () => (R() - 0.5) * 10 ** Math.floor(R() * 8);
    const v: ShareView = { mode: R() < 0.5 ? 'design' : 'play' };
    if (R() < 0.5) v.view2d = { cx: f(), cy: f(), width: Math.abs(f()) + 1 };
    if (R() < 0.5) v.cam = { pos: [f(), f(), f()], target: [f(), f(), f()] };
    if (R() < 0.5) v.stop = Math.floor(R() * 4);
    if (R() < 0.5) v.sim = R() < 0.5;
    if (R() < 0.5) v.mult = [0, 0.5, 1, 2, 10][Math.floor(R() * 5)];
    if (R() < 0.5) v.flows = R() < 0.5;
    if (R() < 0.5) v.sel = R() < 0.3 ? [] : ['n_1', '__proto__', '</script>'];
    if (R() < 0.5) v.journey = { id: 'j_x', step: Math.floor(R() * 5) - 1 };
    return v;
  }

  it('view survives with the documented normalization (rounded, defaults dropped) and is a fixed point', async () => {
    for (const seed of SEEDS.slice(0, 150)) {
      const s = genScene(seed);
      const v = genView(seed);
      const out = (await decodeShare('#' + encodeShare(s, v)))!;
      expect(out.scene).toEqual(expectedAfterShare(s));
      const w = out.view!;
      expect(w.mode).toBe(v.mode);
      if (v.view2d) {
        expect(w.view2d!.cx).toBeCloseTo(v.view2d.cx, 1);
        expect(w.view2d!.width).toBeCloseTo(v.view2d.width, 1);
      } else expect(w.view2d).toBeUndefined();
      if (v.cam) w.cam!.pos.forEach((x, i) => expect(x).toBeCloseTo(v.cam!.pos[i], 2));
      expect(w.stop).toBe(v.stop);
      expect(!!w.sim).toBe(!!v.sim);
      expect(w.mult ?? 1).toBe(v.mult ?? 1);
      expect(w.flows ?? true).toBe(v.flows ?? true);
      expect(w.sel ?? []).toEqual(v.sel ?? []);
      expect(w.journey).toEqual(v.journey);
      // re-sharing what was received changes nothing
      const again = (await decodeShare('#' + encodeShare(out.scene, w)))!;
      expect(again.view).toEqual(w);
    }
  });

  it('keeps falsy-but-meaningful view values: stop 0, mult 0, journey step -1', async () => {
    const s = genScene(3);
    const out = (await decodeShare('#' + encodeShare(s, { mode: 'play', stop: 0, mult: 0, journey: { id: 'j', step: -1 } })))!;
    expect(out.view).toEqual({ mode: 'play', stop: 0, mult: 0, journey: { id: 'j', step: -1 } });
  });
});

describe('share links: legacy #s= links', () => {
  it('decode random legacy scenes (JSON-normalized, journeys normalized by validateScene)', async () => {
    for (const seed of SEEDS.slice(0, 60)) {
      const s = genScene(seed, { pages: false });
      const out = await decodeShare('#s=' + (await legacyCode(s)));
      expect(out!.view).toBeUndefined();
      expect(out!.scene, `seed ${seed}`).toEqual(JSON.parse(JSON.stringify(s)));
    }
  });

  it('accepts base64 with standard alphabet and with = padding', async () => {
    const s = genScene(11, { pages: false });
    const code = await legacyCode(s);
    const std = code.replace(/-/g, '+').replace(/_/g, '/');
    const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
    expect((await decodeShare('#s=' + padded))!.scene).toEqual(JSON.parse(JSON.stringify(s)));
  });

  it('garbage after #s= rejects with an Error', async () => {
    for (const junk of ['!!!', 'AAAA', 'not base64 at all', '%%']) {
      await expect(decodeShare('#s=' + junk)).rejects.toBeInstanceOf(Error);
    }
  });
});

describe('share links: hash handling', () => {
  it('survives encodeURIComponent of the payload (messengers that escape ! $ * + , ; = : @ / ?)', async () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const s = genScene(seed);
      const code = encodeShare(s).slice(2);
      const out = await decodeShare('#z=' + encodeURIComponent(code));
      expect(out!.scene).toEqual(expectedAfterShare(s));
    }
  });

  it('the payload never contains % so decodeURIComponent cannot throw on a fresh link', () => {
    for (const seed of SEEDS) expect(encodeShare(genScene(seed))).not.toMatch(/[%#\s]/);
  });

  it('non-share hashes return null', async () => {
    for (const h of ['', '#', '#z=', '#s=', '#x=abc', 'z=abc', '#Z=abc', '#zz=abc', ' #z=abc']) {
      expect(await decodeShare(h)).toBeNull();
    }
  });

  it('trailing junk, truncation and double-encoding reject with an Error or decode to the same scene, never a different one', async () => {
    const s = genScene(5);
    const want = expectedAfterShare(s);
    const code = encodeShare(s);
    const variants = [
      code + '&utm_source=x', code + ' ', code + '\n', code + '#', code + '.', code + ')', code + 'A', code + 'AAAA',
      code.slice(0, -1), code.slice(0, -5), code.slice(0, code.length >> 1),
      'z=' + encodeURIComponent(encodeURIComponent(code.slice(2))), 'z=%E0%A4%A', 'z=' + code.slice(2).toUpperCase(),
    ];
    for (const v of variants) {
      let out: Awaited<ReturnType<typeof decodeShare>> | undefined;
      try { out = await decodeShare('#' + v); } catch (e) { expect(e, v).toBeInstanceOf(Error); continue; }
      expect(out?.scene, v).toEqual(want);
    }
  });

  it('random single-character corruption never yields a scene the app cannot render', async () => {
    const R = rng(99);
    const B77 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$*+,;=:@/?';
    for (const seed of SEEDS.slice(0, 40)) {
      const code = encodeShare(genScene(seed));
      for (let k = 0; k < 5; k++) {
        const i = 2 + Math.floor(R() * (code.length - 2));
        const bad = code.slice(0, i) + B77[Math.floor(R() * 77)] + code.slice(i + 1);
        let out: Awaited<ReturnType<typeof decodeShare>> = null;
        try { out = await decodeShare('#' + bad); } catch { continue; }
        expect(() => renderable(out!.scene), `seed ${seed} pos ${i}`).not.toThrow();
      }
    }
  });
});

describe('share links: hand-crafted payloads', () => {
  const base = { v: 2, edges: [], layers: [{ id: 'l1', name: 'G' }], stops: [] };

  it('rejects a payload that is not v2 / has no node array', async () => {
    for (const p of [null, 5, 'x', [], {}, { v: 1, nodes: [], edges: [] }, { v: 2, nodes: {}, edges: [] }, { v: 2, nodes: [], edges: 'x' }]) {
      await expect(decodeShare(zHash(p))).rejects.toThrow();
    }
  });

  it('rejects unknown node kinds', async () => {
    await expect(decodeShare(zHash({ ...base, nodes: [{ id: 'n', kind: 'bogus', x: 0, y: 0, layer: 'l1' }] }))).rejects.toThrow(/Unknown node kind/);
  });

  // BUG: share.ts:51 checks `KINDS[c.kind]`, which is truthy for inherited Object.prototype names. A link with
  // kind "constructor" / "toString" / "__proto__" passes the check and yields a node with w/h/height/... undefined.
  // Expected: "Unknown node kind" like any other bad kind. Fix: `if (!Object.hasOwn(KINDS, c.kind)) throw ...`.
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('rejects inherited Object.prototype names as node kinds (%s)', async (kind) => {
    await expect(decodeShare(zHash({ ...base, nodes: [{ id: 'n', kind, x: 0, y: 0, layer: 'l1' }] }))).rejects.toThrow(/Unknown node kind/);
  });

  // BUG: persist.ts:53 keeps a journey step when `s.edges[st.edge]` is truthy, which includes inherited names
  // ("constructor", "toString", "__proto__"). The step then points at no edge: the outline prints "? → ?".
  // Expected: the dangling step is dropped like any other. Fix: `Object.hasOwn(s.edges, st.edge)` there
  // (and in journeys.ts pruneJourneys / stepEnds).
  it('drops journey steps that point at inherited property names instead of edges', async () => {
    const out = (await decodeShare(zHash({
      ...base, nodes: [{ id: 'n_a', kind: 'service', x: 0, y: 0, layer: 'l1' }],
      journeys: [{ id: 'j', name: 'J', color: '#fff', steps: [{ edge: 'constructor' }, { edge: '__proto__' }, { edge: 'toString' }] }],
    })))!.scene;
    expect(out.journeys[0].steps).toEqual([]);
  });

  it('node ids like __proto__ round-trip as own keys and do not pollute prototypes', async () => {
    const sc: Scene = { v: 1, nodes: {}, edges: {}, layers: [{ id: 'l1', name: 'G', visible: true }], stops: [], journeys: [] };
    for (const id of ['__proto__', 'constructor', 'toString']) {
      Object.defineProperty(sc.nodes, id, { value: { id, kind: 'service', x: 0, y: 0, w: 160, h: 90, layer: 'l1', height: 70, color: '#4f7cff', label: id, capacity: 800, latency: 15 }, enumerable: true, writable: true, configurable: true });
    }
    const out = (await decodeShare('#' + encodeShare(sc)))!.scene;
    expect(Object.keys(out.nodes).sort()).toEqual(['__proto__', 'constructor', 'toString']);
    expect(Object.hasOwn(out.nodes, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).label).toBeUndefined();
    expect(Object.getPrototypeOf(out.nodes)).toBe(Object.prototype);
  });

  it('a payload carrying a __proto__ key does not pollute Object.prototype', async () => {
    const p = JSON.parse('{"v":2,"nodes":[],"edges":[],"layers":[{"id":"l1","name":"G"}],"stops":[],"__proto__":{"polluted":1}}');
    await decodeShare(zHash(p)).catch(() => undefined);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('missing optional arrays default (stops, journeys, layer visible)', async () => {
    const out = (await decodeShare(zHash({ v: 2, nodes: [], edges: [], layers: [{ id: 'l1', name: 'G' }] })))!.scene;
    expect(out).toEqual({ v: 1, nodes: {}, edges: {}, layers: [{ id: 'l1', name: 'G', visible: true }], stops: [], journeys: [] });
  });

  it('no layers at all is rejected cleanly', async () => {
    await expect(decodeShare(zHash({ v: 2, nodes: [], edges: [] }))).rejects.toThrow('Not an 8D modeling scene');
    await expect(decodeShare(zHash({ v: 2, nodes: [], edges: [], layers: [] }))).rejects.toThrow('Not an 8D modeling scene');
  });

  it('empty pages array is dropped (scene reads as single page)', async () => {
    const out = (await decodeShare(zHash({ v: 2, nodes: [], edges: [], layers: [{ id: 'l1', name: 'G', page: 'p_x' }], pages: [] })))!.scene;
    expect(out).not.toHaveProperty('pages');
    expect(pagePlacements(out).size).toBe(1);
  });
});

describe('share links: bundled samples', () => {
  it('demo scene round-trips exactly and stays renderable', async () => {
    const s = demoScene();
    const out = (await decodeShare('#' + encodeShare(s)))!.scene;
    expect(out).toEqual(s);
    expect(() => renderable(out)).not.toThrow();
  });

  it('stress scene (2000 nodes) round-trips exactly', async () => {
    const s = stressScene();
    const code = encodeShare(s);
    const out = (await decodeShare('#' + code))!.scene;
    expect(out).toEqual(s);
    expect(encodeShare(out).length).toBeLessThanOrEqual(code.length * 1.02);
  });

  it('a link with all defaults is short: one default node costs little', () => {
    const sc: Scene = { v: 1, nodes: {}, edges: {}, layers: [{ id: 'l1', name: 'G', visible: true }], stops: [], journeys: [] };
    const empty = encodeShare(sc).length;
    sc.nodes.n_a = { id: 'n_a', kind: 'service', x: 0, y: 0, w: 160, h: 90, layer: 'l1', height: 70, color: '#4f7cff', label: 'Service', capacity: 800, latency: 15 };
    expect(encodeShare(sc).length - empty).toBeLessThan(30);
  });
});
