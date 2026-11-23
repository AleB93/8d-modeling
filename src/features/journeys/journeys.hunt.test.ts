import { describe, expect, it } from 'vitest';
import {
  findPath, journeyEdges, journeyEnd, journeyNodes, pruneJourneys, STEP_MS, stepEnds, stepsToEdge, stepText, tokenAt,
} from './journeys';
import { emptyScene, Journey, JStep, makeEdge, makeNode, Scene } from '../../shared/model/types';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random multigraph incl. self-loops, parallel edges, cycles and isolated nodes. */
function randomScene(seed: number) {
  const r = mulberry32(seed);
  const s = emptyScene();
  const n = 1 + Math.floor(r() * 9);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const node = makeNode('service', 0, 0, s.layers[0].id, { id: `n_${i}`, label: `N${i}` });
    s.nodes[node.id] = node;
    ids.push(node.id);
  }
  const m = Math.floor(r() * n * 1.6);
  for (let k = 0; k < m; k++) {
    const e = makeEdge(ids[Math.floor(r() * n)], ids[Math.floor(r() * n)], { id: `e_${k}` });
    s.edges[e.id] = e;
  }
  return { s, ids, r };
}

/** Reference: Bellman-Ford with the documented costs (forward 4, back 6, preferred −1). */
function refCost(s: Scene, from: string, to: string, prefer?: Set<string>): number | null {
  const dist = new Map<string, number>([[from, 0]]);
  const es = Object.values(s.edges);
  for (let i = 0; i < Object.keys(s.nodes).length + 1; i++) {
    for (const e of es) {
      const d = prefer?.has(e.id) ? 1 : 0;
      const relax = (a: string, b: string, c: number) => {
        const da = dist.get(a);
        if (da != null && da + c < (dist.get(b) ?? Infinity)) dist.set(b, da + c);
      };
      relax(e.from, e.to, 4 - d);
      relax(e.to, e.from, 6 - d);
    }
  }
  return dist.get(to) ?? null;
}

const pathCost = (steps: JStep[], prefer?: Set<string>) =>
  steps.reduce((a, st) => a + (st.back ? 6 : 4) - (prefer?.has(st.edge) ? 1 : 0), 0);

/** The steps form a connected walk from → to over existing edges. */
function expectChain(s: Scene, steps: JStep[], from: string, to: string) {
  let at = from;
  for (const st of steps) {
    const ends = stepEnds(s, st);
    expect(ends, `step ${st.edge} exists`).not.toBeNull();
    expect(ends!.from).toBe(at);
    at = ends!.to;
  }
  expect(at).toBe(to);
}

const journey = (steps: JStep[]): Journey => ({ id: 'j', name: 'J', color: '#fff', steps });

describe('findPath on random graphs', () => {
  it('returns a valid chain of existing edges, of minimal cost, or null exactly when unreachable', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { s, ids } = randomScene(seed);
      for (const a of ids) for (const b of ids) {
        const p = findPath(s, a, b);
        const ref = refCost(s, a, b);
        if (a === b) { expect(p).toEqual([]); continue; }
        if (ref == null) { expect(p, `seed ${seed} ${a}->${b}`).toBeNull(); continue; }
        expect(p, `seed ${seed} ${a}->${b}`).not.toBeNull();
        expectChain(s, p!, a, b);
        expect(pathCost(p!), `seed ${seed} ${a}->${b}`).toBe(ref);
      }
    }
  });

  it('with preferred edges, still valid and minimal under the discounted costs', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { s, ids, r } = randomScene(seed);
      const prefer = new Set(Object.keys(s.edges).filter(() => r() < 0.4));
      for (const a of ids) for (const b of ids) {
        if (a === b) continue;
        const p = findPath(s, a, b, prefer);
        const ref = refCost(s, a, b, prefer);
        if (ref == null) { expect(p).toBeNull(); continue; }
        expectChain(s, p!, a, b);
        expect(pathCost(p!, prefer)).toBe(ref);
      }
    }
  });

  it('never repeats a node (a shortest path is simple) and never uses self-loops', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { s, ids } = randomScene(seed);
      for (const a of ids) for (const b of ids) {
        const p = findPath(s, a, b);
        if (!p) continue;
        const seen = new Set([a]);
        for (const st of p) {
          const e = stepEnds(s, st)!;
          expect(e.from).not.toBe(e.to);
          expect(seen.has(e.to)).toBe(false);
          seen.add(e.to);
        }
      }
    }
  });

  it('is symmetric in reachability (edges can be walked both ways)', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { s, ids } = randomScene(seed);
      for (const a of ids) for (const b of ids) expect(findPath(s, a, b) === null).toBe(findPath(s, b, a) === null);
    }
  });

  it('handles nodes that are not in the scene at all', () => {
    const { s, ids } = randomScene(7);
    expect(findPath(s, 'n_ghost', ids[0])).toBeNull();
    expect(findPath(s, ids[0], 'n_ghost')).toBeNull();
    expect(findPath(s, 'n_ghost', 'n_ghost')).toEqual([]);
  });

  it('does not mutate the scene or the prefer set', () => {
    const { s, ids } = randomScene(11);
    const before = structuredClone(s);
    const prefer = new Set(Object.keys(s.edges).slice(0, 1));
    findPath(s, ids[0], ids[ids.length - 1], prefer);
    expect(s).toEqual(before);
    expect(prefer.size).toBe(Math.min(1, Object.keys(s.edges).length));
  });

  it('long chain (500 nodes) is found without blowing the stack', () => {
    const s = emptyScene();
    let prev = makeNode('service', 0, 0, s.layers[0].id);
    s.nodes[prev.id] = prev;
    const first = prev.id;
    for (let i = 0; i < 500; i++) {
      const n = makeNode('service', 0, 0, s.layers[0].id);
      s.nodes[n.id] = n;
      const e = makeEdge(prev.id, n.id);
      s.edges[e.id] = e;
      prev = n;
    }
    const p = findPath(s, first, prev.id)!;
    expect(p).toHaveLength(500);
    expect(p.every((st) => !st.back)).toBe(true);
    expect(findPath(s, prev.id, first)!.every((st) => st.back)).toBe(true);
  });
});

describe('stepsToEdge on random graphs', () => {
  it('ends by traversing the target edge (forward, or backwards when standing at its head)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { s, ids } = randomScene(seed);
      for (const start of [null, ...ids]) for (const eid of Object.keys(s.edges)) {
        const steps = stepsToEdge(s, start, eid);
        const e = s.edges[eid];
        if (!steps) {
          expect(start && findPath(s, start, e.from)).toBeNull();
          continue;
        }
        const last = steps[steps.length - 1];
        expect(last.edge).toBe(eid);
        const origin = start ?? e.from;
        const end = start === e.to && start !== e.from ? e.from : e.to;
        expectChain(s, steps, origin, end);
      }
    }
  });

  it('appending stepsToEdge to a journey keeps it a connected walk', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { s, r } = randomScene(seed);
      const eids = Object.keys(s.edges);
      if (!eids.length) continue;
      const j = journey([]);
      let first: string | null = null;
      for (let k = 0; k < 6; k++) {
        const eid = eids[Math.floor(r() * eids.length)];
        const add = stepsToEdge(s, journeyEnd(s, j), eid, new Set(j.steps.map((x) => x.edge)));
        if (!add) continue;
        if (first == null) first = stepEnds(s, add[0])!.from;
        j.steps.push(...add);
      }
      if (first != null) expectChain(s, j.steps, first, journeyEnd(s, j)!);
    }
  });
});

describe('pruneJourneys / journeyEnd / journeyNodes on broken data', () => {
  it('drops exactly the dangling steps, keeps order, and is idempotent', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { s, r } = randomScene(seed);
      const eids = Object.keys(s.edges);
      const steps: JStep[] = [];
      for (let k = 0; k < 10; k++) steps.push(r() < 0.5 || !eids.length ? { edge: `e_gone${k}` } : { edge: eids[Math.floor(r() * eids.length)], back: r() < 0.5 });
      s.journeys = [journey(steps.slice()), { ...journey([]), id: 'j2' }];
      const expected = steps.filter((st) => s.edges[st.edge]);
      const changed = pruneJourneys(s);
      expect(changed).toBe(expected.length !== steps.length);
      expect(s.journeys[0].steps).toEqual(expected);
      expect(pruneJourneys(s)).toBe(false);
    }
  });

  it('pruneJourneys on a scene with no journeys is a no-op', () => {
    expect(pruneJourneys(emptyScene())).toBe(false);
  });

  it('journeyEnd of a back step is the edge tail; skips trailing dangling steps', () => {
    const { s, ids } = randomScene(1);
    const e = makeEdge(ids[0], 'n_other', { id: 'e_x' });
    s.edges[e.id] = e;
    expect(journeyEnd(s, journey([{ edge: 'e_x', back: true }]))).toBe(ids[0]);
    expect(journeyEnd(s, journey([{ edge: 'e_x' }, { edge: 'e_gone' }]))).toBe('n_other');
    expect(journeyEnd(s, journey([{ edge: 'e_gone' }]))).toBeNull();
    expect(journeyEnd(s, journey([]))).toBeNull();
  });

  it('journeyNodes equals the set of step endpoints; journeyEdges indexes every step', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { s, ids } = randomScene(seed);
      const steps: JStep[] = [];
      for (let k = 0; k + 1 < ids.length; k++) {
        const p = findPath(s, ids[k], ids[k + 1]);
        if (p) steps.push(...p);
      }
      const j = journey(steps);
      const want = new Set<string>();
      for (const st of steps) { const e = s.edges[st.edge]; want.add(e.from); want.add(e.to); }
      expect(journeyNodes(s, j)).toEqual(want);
      const m = journeyEdges(j);
      const idx = [...m.values()].flat().sort((a, b) => a - b);
      expect(idx).toEqual(steps.map((_, k) => k));
      for (const [eid, ks] of m) for (const k of ks) expect(steps[k].edge).toBe(eid);
    }
  });

  it('stepText never throws, even for edges pointing at missing nodes', () => {
    const s = emptyScene();
    s.edges.e_1 = makeEdge('n_a', 'n_b', { id: 'e_1' });
    expect(stepText(s, { edge: 'e_1' })).toBe('? → ?');
    expect(stepText(s, { edge: 'e_none' })).toBe('?');
  });
});

describe('tokenAt', () => {
  const j3 = journey([{ edge: 'a' }, { edge: 'b' }, { edge: 'c' }]);

  it('k is a valid step index and t in [0, 1) for any non-negative time', () => {
    const r = mulberry32(3);
    for (let i = 0; i < 5000; i++) {
      const now = r() * 1e7;
      for (const step of [-1, 0, 1, 2, 99]) {
        const tk = tokenAt(j3, step, now);
        if (!tk) { expect(step).toBe(-1); continue; }
        expect(Number.isInteger(tk.k)).toBe(true);
        expect(tk.k).toBeGreaterThanOrEqual(0);
        expect(tk.k).toBeLessThan(3);
        expect(tk.t).toBeGreaterThanOrEqual(0);
        expect(tk.t).toBeLessThan(1);
        if (step >= 0) expect(tk.k).toBe(Math.min(step, 2));
      }
    }
  });

  it('whole-journey playback is periodic and pauses only at the end', () => {
    const period = 3 * STEP_MS + 600;
    for (let now = 0; now < period; now += 37) {
      const a = tokenAt(j3, -1, now);
      const b = tokenAt(j3, -1, now + 5 * period);
      expect(b).toEqual(a);
      expect(a === null).toBe(now >= 3 * STEP_MS);
    }
  });

  it('empty journey is null for every mode and time', () => {
    for (const step of [-1, 0, 5]) for (const now of [0, 1, 1e9]) expect(tokenAt(journey([]), step, now)).toBeNull();
  });

  it('k is monotone non-decreasing within one loop', () => {
    let last = -1;
    for (let now = 0; now < 3 * STEP_MS; now += 10) {
      const k = tokenAt(j3, -1, now)!.k;
      expect(k).toBeGreaterThanOrEqual(last);
      last = k;
    }
  });
});
