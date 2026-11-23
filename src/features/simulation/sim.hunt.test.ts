import { describe, expect, it } from 'vitest';
import { NodeStat, SimResult, Simulation } from './sim';
import { emptyScene, makeEdge, makeNode, NodeKind, Scene, SEdge, SNode } from '../../shared/model/types';

// Adversarial / property tests for the traffic model. Random graphs are seeded so failures reproduce.

const L = 'L';
const vis = new Set([L]);

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let idc = 0;
function scene() {
  const sc: Scene = emptyScene();
  sc.layers = [{ id: L, name: 'Ground', visible: true }];
  const node = (kind: NodeKind, over: Partial<SNode> = {}) => {
    const n = makeNode(kind, 0, 0, L, { id: `n_${idc++}`, ...over });
    sc.nodes[n.id] = n;
    return n;
  };
  const edge = (a: SNode, b: SNode, over: Partial<SEdge> = {}) => {
    const e = makeEdge(a.id, b.id, { id: `e_${idc++}`, ...over });
    sc.edges[e.id] = e;
    return e;
  };
  return { sc, node, edge };
}

const KINDS: NodeKind[] = ['service', 'database', 'queue', 'cache', 'lb', 'client'];

interface GenOpts { n?: number; acyclic?: boolean; extremes?: boolean; noQueues?: boolean }

/** Random sim graph. acyclic: edges only go from lower to higher index (clients first). */
function randomScene(seed: number, o: GenOpts = {}) {
  const r = mulberry32(seed);
  const { sc, node, edge } = scene();
  const n = o.n ?? 2 + Math.floor(r() * 10);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const nodes: SNode[] = [];
  for (let i = 0; i < n; i++) {
    let kind: NodeKind = i === 0 ? 'client' : pick(KINDS);
    if (o.noQueues && kind === 'queue') kind = 'service';
    const capacity = o.extremes ? pick([0, 0, 1, 1e-3, 50, 1e6, 1e9]) : Math.round(r() * 500);
    const latency = o.extremes ? pick([0, 0, 1, 1000]) : Math.round(r() * 50);
    nodes.push(node(kind, { capacity, latency, down: r() < (o.extremes ? 0.3 : 0.1) }));
  }
  const m = Math.floor(r() * n * 2);
  for (let k = 0; k < m; k++) {
    let a = Math.floor(r() * n), b = Math.floor(r() * n);
    if (o.acyclic) {
      if (a === b) continue;
      if (a > b) [a, b] = [b, a];
    }
    const mult = o.extremes ? pick([0, 0.5, 1, 3, 100]) : pick([0, 0.3, 1, 1, 2]);
    edge(nodes[a], nodes[b], { mult, dashed: r() < 0.2 });
  }
  return { sc, nodes };
}

const finiteNonNeg = (v: number) => Number.isFinite(v) && v >= 0;

function checkResult(sc: Scene, r: SimResult, mult: number, label: string) {
  for (const [id, st] of r.nodes) {
    const n = sc.nodes[id];
    for (const k of Object.keys(st) as (keyof NodeStat)[]) {
      expect(finiteNonNeg(st[k]), `${label} node ${id} ${n.kind} ${k}=${st[k]}`).toBe(true);
    }
    expect(st.drop, `${label} drop`).toBeLessThanOrEqual(1 + 1e-9);
    expect(st.err, `${label} err`).toBeLessThanOrEqual(1 + 1e-9);
    if (n.kind !== 'client') expect(st.rps, `${label} handled<=capacity`).toBeLessThanOrEqual(n.capacity + 1e-9);
    else expect(st.inRps).toBeCloseTo(n.capacity * mult);
    if (n.down) expect(st.rps).toBe(0);
    if (n.kind !== 'queue') expect(st.backlog).toBe(0);
  }
  for (const [id, e] of r.edges) {
    expect(finiteNonNeg(e.rps), `${label} edge ${id} rps`).toBe(true);
    expect(finiteNonNeg(e.err) && e.err <= 1 + 1e-9, `${label} edge ${id} err=${e.err}`).toBe(true);
  }
  const clients = Object.values(sc.nodes).filter((n) => n.kind === 'client');
  const cap = clients.reduce((a, n) => a + n.capacity * mult, 0);
  expect(r.total.rps).toBeLessThanOrEqual(cap + 1e-6);
  expect(r.total.clients).toBe(clients.length);
  expect(finiteNonNeg(r.total.err) && r.total.err <= 1 + 1e-9).toBe(true);
  expect(finiteNonNeg(r.total.lat)).toBe(true);
}

describe('Simulation invariants on random graphs', () => {
  it('every field is finite, non-negative and in range (200 random graphs incl. cycles and self-loops)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { sc } = randomScene(seed);
      const sim = new Simulation();
      for (let s = 0; s < 5; s++) checkResult(sc, sim.step(sc, 0.1, vis), 1, `seed ${seed} step ${s}`);
    }
  });

  it('extreme values (capacity 0, latency 0, mult 0/100, many down) stay finite', () => {
    for (let seed = 1000; seed < 1150; seed++) {
      const { sc } = randomScene(seed, { extremes: true });
      for (const mult of [0, 1, 7]) {
        const sim = new Simulation();
        sim.multiplier = mult;
        for (const dt of [0, 0.1, 1e6]) checkResult(sc, sim.step(sc, dt, vis), mult, `seed ${seed} m ${mult} dt ${dt}`);
      }
    }
  });

  it('all nodes down: everything fails, nothing flows', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { sc, nodes } = randomScene(seed);
      for (const n of nodes) n.down = true;
      const r = new Simulation().step(sc, 0.1, vis);
      checkResult(sc, r, 1, `seed ${seed}`);
      for (const e of r.edges.values()) expect(e.rps).toBe(0);
      for (const n of nodes) if (n.kind === 'client') expect(r.nodes.get(n.id)!.err).toBe(1);
    }
  });

  it('results are deterministic for the same input (fresh simulations)', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { sc } = randomScene(seed);
      const a = new Simulation(), b = new Simulation();
      for (let s = 0; s < 3; s++) expect(a.step(sc, 0.1, vis)).toEqual(b.step(sc, 0.1, vis));
    }
  });

  it('does not mutate the scene', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { sc } = randomScene(seed);
      const before = structuredClone(sc);
      new Simulation().step(sc, 1, vis);
      expect(sc).toEqual(before);
    }
  });

  it('multiplier 0 means no traffic anywhere and no errors', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { sc, nodes } = randomScene(seed, { noQueues: true });
      for (const n of nodes) n.down = false;
      const sim = new Simulation();
      sim.multiplier = 0;
      const r = sim.step(sc, 0.1, vis);
      for (const st of r.nodes.values()) { expect(st.inRps).toBe(0); expect(st.rps).toBe(0); expect(st.err).toBe(0); }
      expect(r.total.err).toBe(0);
    }
  });

  it('acyclic graphs: doubling the multiplier never lowers any node error or the total error', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { sc } = randomScene(seed, { acyclic: true });
      let prev: SimResult | null = null;
      for (const m of [0.25, 0.5, 1, 2, 4, 8]) {
        const sim = new Simulation();
        sim.multiplier = m;
        const r = sim.step(sc, 0.1, vis);
        if (prev) {
          expect(r.total.err, `seed ${seed} m ${m}`).toBeGreaterThanOrEqual(prev.total.err - 1e-9);
          for (const [id, st] of r.nodes) expect(st.err, `seed ${seed} m ${m} ${id}`).toBeGreaterThanOrEqual(prev.nodes.get(id)!.err - 1e-9);
        }
        prev = r;
      }
    }
  });

  it('acyclic graphs: node insertion order does not change the result', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const { sc } = randomScene(seed, { acyclic: true });
      const ids = Object.keys(sc.nodes);
      const shuffled: Scene = { ...sc, nodes: {} };
      const r = mulberry32(seed * 7);
      const order = ids.map((id) => [r(), id] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      for (const id of order) shuffled.nodes[id] = sc.nodes[id];
      const a = new Simulation().step(sc, 0.1, vis);
      const b = new Simulation().step(shuffled, 0.1, vis);
      for (const [id, st] of a.nodes) {
        const o = b.nodes.get(id)!;
        for (const k of Object.keys(st) as (keyof NodeStat)[]) expect(o[k], `seed ${seed} ${id} ${k}`).toBeCloseTo(st[k], 6);
      }
    }
  });

  it('acyclic graphs: flow conservation — a node only receives what upstream edges carry', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { sc } = randomScene(seed, { acyclic: true });
      const r = new Simulation().step(sc, 0.1, vis);
      for (const [id, st] of r.nodes) {
        if (sc.nodes[id].kind === 'client') continue;
        let sum = 0;
        for (const e of Object.values(sc.edges)) if (e.to === id) sum += r.edges.get(e.id)?.rps ?? 0;
        expect(st.inRps, `seed ${seed} ${id}`).toBeCloseTo(sum, 6);
      }
      // a non-LB node's outgoing edge carries handled × mult
      for (const e of Object.values(sc.edges)) {
        const from = sc.nodes[e.from];
        if (from.kind === 'lb') continue;
        expect(r.edges.get(e.id)!.rps).toBeCloseTo(r.nodes.get(e.from)!.rps * e.mult, 6);
      }
    }
  });

  it('acyclic graphs: without overload or down nodes nobody drops', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { sc, nodes } = randomScene(seed, { acyclic: true });
      for (const n of nodes) { n.down = false; if (n.kind !== 'client') n.capacity = 1e12; }
      const r = new Simulation().step(sc, 0.1, vis);
      for (const st of r.nodes.values()) { expect(st.drop).toBe(0); expect(st.err).toBe(0); }
    }
  });
});

describe('Simulation edge cases', () => {
  it('empty scene and scene with only hidden layers', () => {
    const sim = new Simulation();
    expect(sim.step(emptyScene(), 0, vis).total).toEqual({ rps: 0, err: 0, lat: 0, clients: 0 });
    const { sc } = randomScene(3);
    const r = sim.step(sc, 1, new Set());
    expect(r.nodes.size).toBe(0);
    expect(r.edges.size).toBe(0);
  });

  it('invisible layers are excluded even when they sit between visible nodes', () => {
    const { sc, node, edge } = scene();
    sc.layers.push({ id: 'H', name: 'Hidden', visible: false });
    const c = node('client', { capacity: 100 });
    const h = node('service', { capacity: 10, layer: 'H' });
    const s = node('service', { capacity: 1000 });
    edge(c, h);
    edge(h, s);
    const r = new Simulation().step(sc, 1, vis);
    expect(r.nodes.has(h.id)).toBe(false);
    expect(r.nodes.get(s.id)!.inRps).toBe(0);
    expect(r.nodes.get(c.id)!.err).toBe(0);
  });

  it('self-loop with mult 1 converges: inflow = external + handled', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 100 });
    const s = node('service', { capacity: 150, latency: 1 });
    edge(c, s);
    edge(s, s);
    const r = new Simulation().step(sc, 1, vis);
    const st = r.nodes.get(s.id)!;
    expect(st.rps).toBe(150);
    expect(st.inRps).toBe(250);
    expect(Number.isFinite(st.lat)).toBe(true);
  });

  it('LB with every target down: traffic still split, callers see 100% errors', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 90 });
    const lb = node('lb', { capacity: 1000, latency: 0 });
    const t = [0, 1, 2].map(() => node('service', { down: true }));
    edge(c, lb);
    const es = t.map((x) => edge(lb, x));
    const r = new Simulation().step(sc, 1, vis);
    for (const e of es) expect(r.edges.get(e.id)!.rps).toBeCloseTo(30);
    expect(r.nodes.get(lb.id)!.err).toBe(1);
    expect(r.nodes.get(lb.id)!.lat).toBe(1000);
    expect(r.total.err).toBe(1);
  });

  it('LB with no outgoing edges just handles', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 10 });
    const lb = node('lb', { capacity: 5 });
    edge(c, lb);
    const r = new Simulation().step(sc, 1, vis);
    expect(r.nodes.get(lb.id)!.drop).toBeCloseTo(0.5);
  });

  it('LB applies edge mult per target and ignores the down share', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 100 });
    const lb = node('lb', { capacity: 1000 });
    const a = node('service', { capacity: 1000 });
    const b = node('service', { capacity: 1000, down: true });
    edge(c, lb);
    const ea = edge(lb, a, { mult: 2 });
    const eb = edge(lb, b);
    const r = new Simulation().step(sc, 1, vis);
    expect(r.edges.get(ea.id)!.rps).toBe(200);
    expect(r.edges.get(eb.id)!.rps).toBe(0);
    expect(r.nodes.get(c.id)!.err).toBe(0);
  });

  it('queue backlog never negative and bounded by 60 s of capacity, over a random load schedule', () => {
    const r = mulberry32(42);
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 100 });
    const q = node('queue', { capacity: 80 });
    const w = node('service', { capacity: 30 });
    edge(c, q);
    edge(q, w);
    const sim = new Simulation();
    for (let i = 0; i < 2000; i++) {
      sim.multiplier = r() * 3;
      q.down = r() < 0.05;
      const dt = [0, 0.016, 0.1, 1, 30][Math.floor(r() * 5)];
      const st = sim.step(sc, dt, vis).nodes.get(q.id)!;
      expect(st.backlog).toBeGreaterThanOrEqual(0);
      expect(st.backlog).toBeLessThanOrEqual(80 * 60);
      expect(st.drop).toBeGreaterThanOrEqual(0);
      expect(st.drop).toBeLessThanOrEqual(1);
    }
  });

  it('queue: dt 0 never changes the backlog', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 200 });
    const q = node('queue', { capacity: 100 });
    edge(c, q);
    const sim = new Simulation();
    const b1 = sim.step(sc, 1, vis).nodes.get(q.id)!.backlog;
    expect(b1).toBe(100);
    for (let i = 0; i < 5; i++) expect(sim.step(sc, 0, vis).nodes.get(q.id)!.backlog).toBe(b1);
  });

  it('queue: producer error/latency are isolated from a failing consumer', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 10, latency: 0 });
    const q = node('queue', { capacity: 100, latency: 2 });
    const w = node('service', { down: true });
    edge(c, q);
    edge(q, w);
    const r = new Simulation().step(sc, 1, vis);
    expect(r.nodes.get(c.id)!.err).toBe(0);
    expect(r.nodes.get(c.id)!.lat).toBeLessThan(1000);
  });

  it('reset() clears queue backlog', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 200 });
    const q = node('queue', { capacity: 100 });
    edge(c, q);
    const sim = new Simulation();
    sim.step(sc, 10, vis);
    sim.reset();
    sim.multiplier = 0;
    expect(sim.step(sc, 1, vis).nodes.get(q.id)!.rps).toBe(0);
  });

  it('queue: messages out never exceed messages in (conservation across steps)', () => {
    // Step 1: 150 msg/s for 1 s into a queue that drains 100 msg/s → 50 messages backlog.
    // Step 2: producers stop. At most the 50 queued messages can leave.
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 150 });
    const q = node('queue', { capacity: 100 });
    const w = node('service', { capacity: 1000 });
    edge(c, q);
    const out = edge(q, w);
    const sim = new Simulation();
    const r1 = sim.step(sc, 1, vis);
    expect(r1.nodes.get(q.id)!.backlog).toBe(50);
    sim.multiplier = 0;
    const r2 = sim.step(sc, 1, vis);
    const sentIn = 150 * 1;
    const sentOut = r1.edges.get(out.id)!.rps * 1 + r2.edges.get(out.id)!.rps * 1;
    // BUG: sim.ts:69 — a queue with backlog > 0.5 drains at full `capacity` for the whole step even when the
    // backlog (plus this step's inflow) is smaller than capacity × dt. Here it emits 100 msg/s for 1 s from a
    // 50-message backlog: 200 messages leave for 150 that arrived. Expected sentOut ≤ 150, actual 200.
    // Negligible at dt = 0.1 with large backlogs, but visible on the last drain step and with long steps.
    expect(sentOut).toBeLessThanOrEqual(sentIn + 1e-9);
  });

  it('long acyclic chains (> 64 hops) still deliver traffic to the end without phantom drops', () => {
    const { sc, node, edge } = scene();
    let prev = node('client', { capacity: 10 });
    const chain: SNode[] = [];
    for (let i = 0; i < 70; i++) {
      const s = node('service', { capacity: 1000, latency: 0 });
      edge(prev, s);
      chain.push(s);
      prev = s;
    }
    const r = new Simulation().step(sc, 0.1, vis);
    // BUG: sim.ts:62 — passes = min(64, nodes + 1) caps the Jacobi iterations at 64, but a DAG needs
    // depth + 1 passes. Node #64 of the chain ends with inRps 10 (inflow is one pass ahead) but rps 0
    // (handled from the previous pass), i.e. a phantom 100% drop on a 1000-capacity node; nodes further down
    // get no traffic at all. Expected every node: inRps 10, drop 0. Fix: cap by depth (topological order) or
    // raise the cap / recompute `handled` from the final inflow after the loop.
    for (const s of chain) {
      const st = r.nodes.get(s.id)!;
      expect(st.drop).toBe(0);
      expect(st.inRps).toBe(10);
    }
  });

  it('huge fan-out multipliers keep results finite (no NaN)', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 100 });
    const s = node('service', { capacity: 1000 });
    edge(c, s, { mult: 1e307 }); // 100 × 1e307 overflows to Infinity
    const r = new Simulation().step(sc, 0.1, vis);
    const st = r.nodes.get(s.id)!;
    // BUG: sim.ts:104 — inc = Infinity makes drop = (Infinity - h) / Infinity = NaN, which propagates to
    // err and total.err (NaN). The agent API accepts any mult ≥ 0, so a huge value poisons the run.
    // Expected: drop ≈ 1 (finite). Fix: clamp inflow (e.g. Math.min(inc, Number.MAX_VALUE)) or guard
    // `drop = inc === Infinity ? 1 : ...`.
    expect(Number.isNaN(st.drop)).toBe(false);
    expect(Number.isNaN(r.total.err)).toBe(false);
  });

  it('a client that receives edges ignores inflow (clients only generate)', () => {
    const { sc, node, edge } = scene();
    const c1 = node('client', { capacity: 10 });
    const c2 = node('client', { capacity: 20 });
    edge(c1, c2);
    const r = new Simulation().step(sc, 1, vis);
    expect(r.nodes.get(c2.id)!.inRps).toBe(20);
    expect(r.total.rps).toBe(30);
  });

  it('edge err for a queue target is the queue own drop, not the consumer failure', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 10 });
    const q = node('queue', { capacity: 100 });
    const w = node('service', { down: true });
    const e1 = edge(c, q);
    edge(q, w);
    const r = new Simulation().step(sc, 1, vis);
    expect(r.edges.get(e1.id)!.err).toBe(0);
  });

  it('mult between 0 and 1 scales the error a dependency contributes', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 100 });
    const s = node('service', { capacity: 1000 });
    const db = node('database', { down: true });
    edge(c, s);
    edge(s, db, { mult: 0.3 });
    const r = new Simulation().step(sc, 1, vis);
    expect(r.nodes.get(s.id)!.err).toBeCloseTo(0.3);
  });
});

describe('Simulation cycles', () => {
  it('in a 2-node cycle, the client sees a down dependency regardless of node creation order', () => {
    // C → A ⇄ B, B → D (down). Every request through A calls B, which calls the dead D.
    const build = (order: 'client-first' | 'b-first') => {
      const { sc, node, edge } = scene();
      const mk: Record<string, () => SNode> = {
        C: () => node('client', { capacity: 10 }),
        A: () => node('service', { capacity: 1e6, latency: 1 }),
        B: () => node('service', { capacity: 1e6, latency: 1 }),
        D: () => node('database', { down: true }),
      };
      const seq = order === 'client-first' ? ['C', 'A', 'B', 'D'] : ['B', 'A', 'C', 'D'];
      const n: Record<string, SNode> = {};
      for (const k of seq) n[k] = mk[k]();
      edge(n.C, n.A);
      edge(n.A, n.B);
      edge(n.B, n.A);
      edge(n.B, n.D);
      return { sc, n };
    };
    const a = build('client-first');
    const b = build('b-first');
    const ra = new Simulation().step(a.sc, 0.1, vis);
    const rb = new Simulation().step(b.sc, 0.1, vis);
    expect(ra.nodes.get(a.n.C.id)!.err).toBeCloseTo(1);
    // BUG: sim.ts:121-160 — the error/latency DFS cuts cycles by returning [0, 0] for a node on the stack,
    // but still memoizes the partial result of every node on the cycle. When B is walked first, A is
    // memoized while B is "visiting", so A's err ignores B (and the dead D) → client C reports err 0.
    // With C created first the same graph reports err 1. Expected: identical results (C err ≈ 1) for both
    // orders. Fix: don't memoize nodes whose result depended on a cut (track a "tainted" flag) or compute
    // SCCs and evaluate them as a unit / start walks from clients.
    expect(rb.nodes.get(b.n.C.id)!.err).toBeCloseTo(ra.nodes.get(a.n.C.id)!.err);
    expect(rb.total.err).toBeCloseTo(ra.total.err);
  });

  it('cyclic random graphs keep every field finite after many steps', () => {
    for (let seed = 5000; seed < 5100; seed++) {
      const { sc } = randomScene(seed, { n: 4 + (seed % 8) });
      const sim = new Simulation();
      sim.multiplier = 3;
      let r!: SimResult;
      for (let s = 0; s < 20; s++) r = sim.step(sc, 0.5, vis);
      checkResult(sc, r, 3, `seed ${seed}`);
    }
  });
});
