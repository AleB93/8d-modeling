import { Scene, SEdge, SIM_KINDS, SNode } from '../../shared/model/types';

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
/** Load is clamped here so absurd inputs (mult 1e307, infinite capacity) can't overflow into NaN. */
const MAX_RPS = 1e12;
const clampRps = (x: number) => (x > 0 ? Math.min(x, MAX_RPS) : 0);

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

    // ---- propagate load ----
    // Nodes are visited in topological order (Kahn), nodes on cycles last, and each node reads its
    // callers' current flows (Gauss-Seidel). A DAG is exact after one pass; cycles iterate until stable.
    const ins = new Map<string, SEdge[]>();
    const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
    for (const es of outs.values()) for (const e of es) {
      let l = ins.get(e.to);
      if (!l) ins.set(e.to, (l = []));
      l.push(e);
      if (e.from !== e.to) indeg.set(e.to, indeg.get(e.to)! + 1);
    }
    const order: SNode[] = [];
    const queue = nodes.filter((n) => indeg.get(n.id) === 0);
    while (queue.length) {
      const n = queue.shift()!;
      order.push(n);
      for (const e of outs.get(n.id) ?? []) {
        if (e.from === e.to) continue;
        const d = indeg.get(e.to)! - 1;
        indeg.set(e.to, d);
        if (d === 0) queue.push(byId.get(e.to)!);
      }
    }
    const placed = new Set(order);
    for (const n of nodes) if (!placed.has(n)) order.push(n);

    const inflow = new Map<string, number>();
    const handled = new Map<string, number>();
    const edgeRps = new Map<string, number>();
    const offered = (n: SNode) => {
      if (n.kind === 'client') return clampRps(n.capacity * this.multiplier);
      let s = 0;
      for (const e of ins.get(n.id) ?? []) s += edgeRps.get(e.id) ?? 0;
      return clampRps(s);
    };
    for (let p = 0; p < 64; p++) {
      let changed = false;
      for (const n of order) {
        const inc = offered(n);
        inflow.set(n.id, inc);
        let h: number;
        if (n.down) h = 0;
        else if (n.kind === 'client') h = inc;
        else if (n.kind === 'queue') {
          // a queue with a backlog drains at full speed, but never more than it holds plus what arrives
          const backlog = this.backlog.get(n.id) ?? 0;
          h = backlog > 0.5 ? Math.min(n.capacity, inc + (dt > 0 ? backlog / dt : Infinity)) : Math.min(inc, n.capacity);
        } else h = Math.min(inc, n.capacity);
        h = clampRps(h);
        handled.set(n.id, h);
        const es = outs.get(n.id);
        if (!es) continue;
        const pool = n.kind === 'lb' ? lbPool(es) : es;
        for (const e of es) {
          const f = clampRps(pool.includes(e) ? (h / (n.kind === 'lb' ? pool.length : 1)) * e.mult : 0);
          if (Math.abs((edgeRps.get(e.id) ?? 0) - f) > 1e-6) changed = true;
          edgeRps.set(e.id, f);
        }
      }
      if (!changed) break;
    }
    // `inflow` and `handled` both come from the last pass, so they always agree (no phantom drops when an
    // amplifying cycle hits the pass limit).

    // ---- per-node own drop + queue backlog ----
    const stats = new Map<string, NodeStat>();
    for (const n of nodes) {
      const inc = inflow.get(n.id)!;
      const h = handled.get(n.id)!; // every pass sets handled for every node
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
    // A cycle is cut where the walk re-enters a node still on the stack. A result that depended on such a
    // cut above it (an ancestor) is only valid for the current walk, so it's cached per walk, not globally;
    // otherwise results would depend on the order nodes were created in.
    const memo = new Map<string, [number, number]>();
    let walkMemo = new Map<string, [number, number, number]>();
    const depth = new Map<string, number>();
    const walk = (id: string): [number, number, number] => {
      const m = memo.get(id);
      if (m) return [m[0], m[1], Infinity];
      const w = walkMemo.get(id);
      if (w) return w;
      const onStack = depth.get(id);
      if (onStack != null) return [0, 0, onStack];
      const d = depth.size;
      depth.set(id, d);
      const n = byId.get(id)!;
      const st = stats.get(id)!;
      const rho = Math.min(st.util, 0.95);
      const own = n.down ? TIMEOUT_MS : n.latency / (1 - rho);
      let downErr = 0;
      let downLat = 0;
      let low = Infinity;
      const es = outs.get(id) ?? [];
      if (n.kind !== 'queue' && !n.down && es.length) {
        if (n.kind === 'lb') {
          const pool = lbPool(es);
          for (const e of pool) {
            const [er, la, lo] = walk(e.to);
            low = Math.min(low, lo);
            downErr += er / pool.length;
            downLat += (la * e.mult) / pool.length;
          }
        } else {
          let ok = 1;
          for (const e of es) {
            const [er, la, lo] = walk(e.to);
            low = Math.min(low, lo);
            ok *= 1 - er * Math.min(1, e.mult);
            downLat += la * e.mult;
          }
          downErr = 1 - ok;
        }
      }
      const err = 1 - (1 - st.drop) * (1 - downErr);
      const lat = Math.min(own + downLat, Number.MAX_VALUE);
      depth.delete(id);
      if (low < d) walkMemo.set(id, [err, lat, low]);
      else memo.set(id, [err, lat]);
      return [err, lat, low < d ? low : Infinity];
    };

    const total = { rps: 0, err: 0, lat: 0, clients: 0 };
    for (const n of nodes) {
      walkMemo = new Map();
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
