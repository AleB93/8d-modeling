import { Scene, SEdge, SIM_KINDS, SNode } from '../model/types';

export interface NodeStat {
  inRps: number; // offered load
  rps: number; // handled
  util: number; // in / capacity
  drop: number; // fraction of offered load this node itself fails
  err: number; // end-to-end failure fraction seen by callers (own drops + sync dependencies)
  lat: number; // end-to-end latency in ms
  backlog: number; // queues only
}

export interface SimResult {
  nodes: Map<string, NodeStat>;
  edges: Map<string, { rps: number; err: number }>;
  total: { rps: number; err: number; lat: number; clients: number };
}

const TIMEOUT_MS = 1000;
const MAX_BACKLOG_S = 60; // queue holds this many seconds of drain capacity

/**
 * Steady-state traffic model.
 * - Clients emit `capacity` rps × multiplier. Each node handles min(load, capacity), the rest is dropped.
 * - Every outgoing edge receives handled × edge.mult (fan-out). Load balancers split across healthy targets.
 * - Queues accept everything, drain at `capacity`, and are an async boundary: consumer failures and
 *   latency do not propagate back to producers.
 * - Latency inflates with utilization (≈ M/M/1: 1/(1-ρ)); calls to a dead node cost a timeout.
 */
export class Simulation {
  multiplier = 1;
  private backlog = new Map<string, number>();

  reset() {
    this.backlog.clear();
  }

  step(sc: Scene, dt: number, visibleLayers: Set<string>): SimResult {
    const nodes: SNode[] = [];
    const byId = new Map<string, SNode>();
    for (const n of Object.values(sc.nodes)) {
      if (SIM_KINDS.has(n.kind) && visibleLayers.has(n.layer)) { nodes.push(n); byId.set(n.id, n); }
    }
    const outs = new Map<string, SEdge[]>();
    for (const e of Object.values(sc.edges)) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      let l = outs.get(e.from);
      if (!l) outs.set(e.from, (l = []));
      l.push(e);
    }

    const lbPool = (es: SEdge[]) => {
      const healthy = es.filter((e) => !byId.get(e.to)!.down);
      return healthy.length ? healthy : es;
    };

    // ---- propagate load (Jacobi iterations; converges in graph depth for DAGs, bounded for cycles) ----
    let inflow = new Map<string, number>();
    const handled = new Map<string, number>();
    const edgeRps = new Map<string, number>();
    const passes = Math.min(64, nodes.length + 1);
    for (let p = 0; p < passes; p++) {
      const next = new Map<string, number>();
      for (const n of nodes) {
        const inc = n.kind === 'client' ? n.capacity * this.multiplier : inflow.get(n.id) ?? 0;
        let h: number;
        if (n.down) h = 0;
        else if (n.kind === 'client') h = inc;
        else if (n.kind === 'queue') h = (this.backlog.get(n.id) ?? 0) > 0.5 ? n.capacity : Math.min(inc, n.capacity);
        else h = Math.min(inc, n.capacity);
        handled.set(n.id, h);
        const es = outs.get(n.id);
        if (!es) continue;
        if (n.kind === 'lb') {
          const pool = lbPool(es);
          for (const e of es) {
            const f = pool.includes(e) ? (h / pool.length) * e.mult : 0;
            edgeRps.set(e.id, f);
            next.set(e.to, (next.get(e.to) ?? 0) + f);
          }
        } else {
          for (const e of es) {
            const f = h * e.mult;
            edgeRps.set(e.id, f);
            next.set(e.to, (next.get(e.to) ?? 0) + f);
          }
        }
      }
      let changed = false;
      for (const [k, v] of next) if (Math.abs((inflow.get(k) ?? 0) - v) > 1e-6) { changed = true; break; }
      if (!changed && next.size === inflow.size && p > 0) { inflow = next; break; }
      inflow = next;
    }

    // ---- per-node own drop + queue backlog ----
    const stats = new Map<string, NodeStat>();
    for (const n of nodes) {
      const inc = n.kind === 'client' ? n.capacity * this.multiplier : inflow.get(n.id) ?? 0;
      const h = handled.get(n.id) ?? 0;
      let drop = 0;
      let backlog = 0;
      if (n.kind === 'queue') {
        const max = n.capacity * MAX_BACKLOG_S;
        backlog = Math.max(0, Math.min(max, (this.backlog.get(n.id) ?? 0) + (inc - n.capacity) * dt));
        if (n.down) backlog = this.backlog.get(n.id) ?? 0;
        this.backlog.set(n.id, backlog);
        if (n.down) drop = inc > 0 ? 1 : 0;
        else if (backlog >= max && inc > n.capacity) drop = (inc - n.capacity) / inc;
      } else if (n.down) drop = 1;
      else if (inc > 0) drop = Math.max(0, (inc - h) / inc);
      stats.set(n.id, {
        inRps: inc, rps: h, util: n.capacity > 0 && n.kind !== 'client' ? inc / n.capacity : 0,
        drop, err: 0, lat: 0, backlog,
      });
    }

    // ---- error + latency propagation (memoized DFS; cycles cut) ----
    const errMemo = new Map<string, number>();
    const latMemo = new Map<string, number>();
    const visiting = new Set<string>();
    const walk = (id: string): [number, number] => {
      if (errMemo.has(id)) return [errMemo.get(id)!, latMemo.get(id)!];
      if (visiting.has(id)) return [0, 0];
      visiting.add(id);
      const n = byId.get(id)!;
      const st = stats.get(id)!;
      const rho = Math.min(st.util, 0.95);
      let own = n.down ? TIMEOUT_MS : n.latency / (1 - rho);
      let downErr = 0;
      let downLat = 0;
      const es = outs.get(id) ?? [];
      if (n.kind !== 'queue' && !n.down && es.length) {
        if (n.kind === 'lb') {
          const pool = lbPool(es);
          for (const e of pool) {
            const [er, la] = walk(e.to);
            downErr += er / pool.length;
            downLat += (la * e.mult) / pool.length;
          }
        } else {
          let ok = 1;
          for (const e of es) {
            const [er, la] = walk(e.to);
            ok *= 1 - er * Math.min(1, e.mult);
            downLat += la * e.mult;
          }
          downErr = 1 - ok;
        }
      }
      if (n.down) own = TIMEOUT_MS;
      const err = 1 - (1 - st.drop) * (1 - downErr);
      const lat = own + downLat;
      visiting.delete(id);
      errMemo.set(id, err);
      latMemo.set(id, lat);
      return [err, lat];
    };

    const total = { rps: 0, err: 0, lat: 0, clients: 0 };
    for (const n of nodes) {
      const [err, lat] = walk(n.id);
      const st = stats.get(n.id)!;
      st.err = err;
      st.lat = lat;
      if (n.kind === 'client') {
        total.rps += st.inRps;
        total.err += st.inRps * err;
        total.lat += st.inRps * lat;
        total.clients++;
      }
    }
    if (total.rps > 0) { total.err /= total.rps; total.lat /= total.rps; }

    const edges = new Map<string, { rps: number; err: number }>();
    for (const [id, rps] of edgeRps) {
      const e = sc.edges[id];
      const t = stats.get(e.to)!;
      edges.set(id, { rps, err: byId.get(e.to)!.kind === 'queue' ? t.drop : t.err });
    }
    return { nodes: stats, edges, total };
  }
}
