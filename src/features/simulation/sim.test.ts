import { describe, expect, it } from 'vitest';
import { Simulation } from './sim';
import { emptyScene, makeEdge, makeNode, NodeKind, Scene, SEdge, SNode } from '../../shared/model/types';

const L = 'L';

function scene() {
  const sc: Scene = emptyScene();
  sc.layers = [{ id: L, name: 'Ground', visible: true }];
  const node = (kind: NodeKind, over: Partial<SNode> = {}) => {
    const n = makeNode(kind, 0, 0, L, over);
    sc.nodes[n.id] = n;
    return n;
  };
  const edge = (a: SNode, b: SNode, over: Partial<SEdge> = {}) => {
    const e = makeEdge(a.id, b.id, over);
    sc.edges[e.id] = e;
    return e;
  };
  return { sc, node, edge };
}

const vis = new Set([L]);

describe('Simulation', () => {
  it('returns empty totals for an empty scene', () => {
    const r = new Simulation().step(emptyScene(), 1, vis);
    expect(r.nodes.size).toBe(0);
    expect(r.edges.size).toBe(0);
    expect(r.total).toEqual({ rps: 0, err: 0, lat: 0, clients: 0 });
  });

  it('client → service under capacity: no drops, latency inflated by utilization', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 100, latency: 0 });
    const s = node('service', { capacity: 200, latency: 10 });
    const e = edge(c, s);
    const r = new Simulation().step(sc, 1, vis);
    const ss = r.nodes.get(s.id)!;
    expect(ss.inRps).toBe(100);
    expect(ss.rps).toBe(100);
    expect(ss.util).toBe(0.5);
    expect(ss.drop).toBe(0);
    expect(ss.err).toBe(0);
    expect(ss.lat).toBeCloseTo(20); // 10 / (1 - 0.5)
    const cs = r.nodes.get(c.id)!;
    expect(cs.util).toBe(0); // clients have no utilization
    expect(cs.lat).toBeCloseTo(20);
    expect(r.edges.get(e.id)).toEqual({ rps: 100, err: 0 });
    expect(r.total).toEqual({ rps: 100, err: 0, lat: cs.lat, clients: 1 });
  });

  it('multiplier scales client load; overload drops the excess and caps rho at 0.95', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 100 });
    const s = node('service', { capacity: 100, latency: 10 });
    edge(c, s);
    const sim = new Simulation();
    sim.multiplier = 4;
    const r = sim.step(sc, 1, vis);
    const ss = r.nodes.get(s.id)!;
    expect(ss.inRps).toBe(400);
    expect(ss.rps).toBe(100);
    expect(ss.drop).toBeCloseTo(0.75);
    expect(ss.err).toBeCloseTo(0.75);
    expect(ss.lat).toBeCloseTo(200); // 10 / 0.05
    expect(r.total.err).toBeCloseTo(0.75);
    expect(r.total.rps).toBe(400);
  });

  it('edge mult fans out and errors compound across sync dependencies', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 100 });
    const s = node('service', { capacity: 1000, latency: 0 });
    const db = node('database', { capacity: 100, latency: 5 });
    const e = edge(s, db, { mult: 2 });
    edge(c, s);
    const r = new Simulation().step(sc, 1, vis);
    expect(r.edges.get(e.id)!.rps).toBe(200);
    const d = r.nodes.get(db.id)!;
    expect(d.drop).toBeCloseTo(0.5);
    // service error: 1 - (1 - 0.5 * min(1, 2))
    expect(r.nodes.get(s.id)!.err).toBeCloseTo(0.5);
    expect(r.edges.get(e.id)!.err).toBeCloseTo(0.5);
    // latency: 0/(1-0.1) + db lat × mult
    expect(r.nodes.get(s.id)!.lat).toBeCloseTo(d.lat * 2);
    expect(d.lat).toBeCloseTo(5 / 0.05);
  });

  it('a down node drops everything and costs a timeout', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 50 });
    const s = node('service', { capacity: 1000, latency: 3, down: true });
    const db = node('database');
    edge(c, s);
    const e2 = edge(s, db);
    const r = new Simulation().step(sc, 1, vis);
    const ss = r.nodes.get(s.id)!;
    expect(ss.rps).toBe(0);
    expect(ss.drop).toBe(1);
    expect(ss.err).toBe(1);
    expect(ss.lat).toBe(1000); // timeout, dependencies not walked
    expect(r.edges.get(e2.id)!.rps).toBe(0);
    expect(r.nodes.get(db.id)!.inRps).toBe(0);
    expect(r.nodes.get(db.id)!.drop).toBe(0);
    expect(r.total.err).toBe(1);
  });

  it('a down client emits nothing', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 50, down: true });
    const s = node('service');
    edge(c, s);
    const r = new Simulation().step(sc, 1, vis);
    expect(r.nodes.get(s.id)!.inRps).toBe(0);
    expect(r.nodes.get(c.id)!.drop).toBe(1);
  });

  it('load balancer splits evenly across healthy targets only', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 300 });
    const lb = node('lb', { latency: 1 });
    const a = node('service', { capacity: 1000, latency: 10 });
    const b = node('service', { capacity: 1000, latency: 10 });
    const dead = node('service', { down: true });
    edge(c, lb);
    const ea = edge(lb, a);
    const eb = edge(lb, b, { mult: 2 });
    const ed = edge(lb, dead);
    const r = new Simulation().step(sc, 1, vis);
    expect(r.edges.get(ea.id)!.rps).toBe(150);
    expect(r.edges.get(eb.id)!.rps).toBe(300);
    expect(r.edges.get(ed.id)!.rps).toBe(0);
    expect(r.nodes.get(lb.id)!.err).toBe(0);
    const la = r.nodes.get(a.id)!.lat;
    const lbb = r.nodes.get(b.id)!.lat;
    expect(r.nodes.get(lb.id)!.lat).toBeCloseTo(1 / (1 - 0.03) + (la + lbb * 2) / 2);
  });

  it('load balancer with every target down spreads over all of them', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 100 });
    const lb = node('lb');
    const a = node('service', { down: true });
    const b = node('service', { down: true });
    edge(c, lb);
    const ea = edge(lb, a);
    const eb = edge(lb, b);
    const r = new Simulation().step(sc, 1, vis);
    expect(r.edges.get(ea.id)!.rps).toBe(50);
    expect(r.edges.get(eb.id)!.rps).toBe(50);
    expect(r.nodes.get(lb.id)!.err).toBe(1);
    expect(r.nodes.get(c.id)!.err).toBe(1);
  });

  it('queues buffer overload, isolate producers, drain backlog later and drop when full', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 100 });
    const q = node('queue', { capacity: 10, latency: 2 });
    const w = node('service', { capacity: 5, latency: 10, down: false });
    const eq = edge(c, q);
    const ew = edge(q, w);
    const sim = new Simulation();

    let r = sim.step(sc, 1, vis);
    let qs = r.nodes.get(q.id)!;
    expect(qs.rps).toBe(10);
    expect(qs.backlog).toBe(90);
    expect(qs.drop).toBe(0);
    // consumer drops half, but the queue is an async boundary
    expect(r.nodes.get(w.id)!.drop).toBeCloseTo(0.5);
    expect(qs.err).toBe(0);
    expect(r.nodes.get(c.id)!.err).toBe(0);
    expect(r.edges.get(eq.id)!.err).toBe(0); // edge into a queue reports the queue's own drop
    expect(r.edges.get(ew.id)!.err).toBeCloseTo(0.5);

    // fill to max: capacity × 60s = 600
    r = sim.step(sc, 10, vis);
    qs = r.nodes.get(q.id)!;
    expect(qs.backlog).toBe(600);
    expect(qs.drop).toBeCloseTo(0.9);
    expect(r.edges.get(eq.id)!.err).toBeCloseTo(0.9);

    // load stops: queue keeps draining at capacity from its backlog
    sim.multiplier = 0;
    r = sim.step(sc, 1, vis);
    qs = r.nodes.get(q.id)!;
    expect(qs.inRps).toBe(0);
    expect(qs.rps).toBe(10);
    expect(qs.backlog).toBe(590);
    expect(qs.drop).toBe(0);

    sim.reset();
    r = sim.step(sc, 1, vis);
    expect(r.nodes.get(q.id)!.rps).toBe(0);
    expect(r.nodes.get(q.id)!.backlog).toBe(0);
  });

  it('a down queue freezes its backlog and fails incoming messages', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 100 });
    const q = node('queue', { capacity: 10 });
    edge(c, q);
    const sim = new Simulation();
    sim.step(sc, 1, vis);
    q.down = true;
    let r = sim.step(sc, 5, vis);
    expect(r.nodes.get(q.id)!.backlog).toBe(90);
    expect(r.nodes.get(q.id)!.drop).toBe(1);
    expect(r.nodes.get(q.id)!.lat).toBe(1000);
    sim.multiplier = 0;
    r = sim.step(sc, 5, vis);
    expect(r.nodes.get(q.id)!.drop).toBe(0); // nothing offered, nothing failed
    expect(r.total.rps).toBe(0);
  });

  it('a queue that is down from the start has an empty backlog; an unconnected service is idle', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 100 });
    const q = node('queue', { capacity: 10, down: true });
    const lone = node('service', { latency: 3 });
    edge(c, q);
    const r = new Simulation().step(sc, 1, vis);
    expect(r.nodes.get(q.id)!.backlog).toBe(0);
    expect(r.nodes.get(q.id)!.drop).toBe(1);
    expect(r.nodes.get(lone.id)).toEqual({ inRps: 0, rps: 0, util: 0, drop: 0, err: 0, lat: 3, backlog: 0 });
  });

  it('ignores non-sim kinds, hidden layers and edges to them', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 100 });
    const zone = node('zone');
    const hidden = makeNode('service', 0, 0, 'hiddenLayer');
    sc.nodes[hidden.id] = hidden;
    const s = node('service');
    edge(c, zone);
    const eh = makeEdge(c.id, hidden.id);
    sc.edges[eh.id] = eh;
    edge(c, s);
    const r = new Simulation().step(sc, 1, vis);
    expect(r.nodes.has(zone.id)).toBe(false);
    expect(r.nodes.has(hidden.id)).toBe(false);
    expect(r.edges.has(eh.id)).toBe(false);
    expect(r.edges.size).toBe(1);
    expect(r.nodes.get(s.id)!.inRps).toBe(100);
  });

  it('zero-capacity nodes report zero utilization; idle nodes have no drop', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 0 });
    const s = node('service', { capacity: 0, latency: 4 });
    edge(c, s);
    const r = new Simulation().step(sc, 1, vis);
    const ss = r.nodes.get(s.id)!;
    expect(ss.util).toBe(0);
    expect(ss.drop).toBe(0);
    expect(ss.lat).toBe(4);
    expect(r.total).toEqual({ rps: 0, err: 0, lat: 0, clients: 1 });
  });

  it('cycles are bounded: load iteration stops after the pass limit and the error walk cuts the loop', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 100 });
    const a = node('service', { capacity: 1e12, latency: 1 });
    const b = node('service', { capacity: 1e12, latency: 1 });
    edge(c, a);
    edge(a, b);
    edge(b, a);
    const r = new Simulation().step(sc, 1, vis);
    // an amplifying loop (mult 1 both ways) grows by C's 100 rps each pass until the 64-pass limit
    expect(r.nodes.get(a.id)!.inRps).toBe(6400);
    expect(r.nodes.get(b.id)!.inRps).toBe(6400);
    expect(Number.isFinite(r.nodes.get(c.id)!.lat)).toBe(true);
    // inflow and handled come from the same pass: no phantom drops on the loop
    expect(r.nodes.get(b.id)!.rps).toBe(6400);
    expect(r.nodes.get(b.id)!.drop).toBe(0);
    // the error walk cuts the cycle (B → A returns [0, 0]) instead of recursing forever
    expect(r.nodes.get(a.id)!.err).toBe(0);
    expect(r.nodes.get(c.id)!.err).toBe(0);
  });

  it('shared downstream nodes are walked once (memoized)', () => {
    const { sc, node, edge } = scene();
    const c = node('client', { capacity: 10 });
    const a = node('service', { capacity: 1000, latency: 0 });
    const b = node('service', { capacity: 1000, latency: 0 });
    const db = node('database', { capacity: 1000, latency: 7 });
    edge(c, a);
    edge(c, b);
    edge(a, db);
    edge(b, db);
    const r = new Simulation().step(sc, 1, vis);
    expect(r.nodes.get(db.id)!.inRps).toBe(20);
    expect(r.nodes.get(a.id)!.lat).toBeCloseTo(r.nodes.get(db.id)!.lat);
    expect(r.nodes.get(c.id)!.lat).toBeCloseTo(2 * r.nodes.get(db.id)!.lat);
  });
});
