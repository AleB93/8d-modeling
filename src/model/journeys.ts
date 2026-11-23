import type { Journey, JStep, Scene } from './types';

// User journeys: ordered paths through existing connections. Steps reference edges, so a journey
// follows the diagram when boxes move, and steps whose connection is deleted are pruned.

/** Source and target node of a step, in walking order (a `back` step runs against the arrow). */
export function stepEnds(s: Scene, st: JStep): { from: string; to: string } | null {
  const e = s.edges[st.edge];
  if (!e) return null;
  return st.back ? { from: e.to, to: e.from } : { from: e.from, to: e.to };
}

/** Every node the journey touches. */
export function journeyNodes(s: Scene, j: Journey): Set<string> {
  const out = new Set<string>();
  for (const st of j.steps) {
    const ends = stepEnds(s, st);
    if (ends) { out.add(ends.from); out.add(ends.to); }
  }
  return out;
}

/** Node the journey currently ends at (where the next recorded hop starts). */
export function journeyEnd(s: Scene, j: Journey): string | null {
  for (let k = j.steps.length - 1; k >= 0; k--) {
    const ends = stepEnds(s, j.steps[k]);
    if (ends) return ends.to;
  }
  return null;
}

/**
 * Cheapest path between two nodes over existing connections. Walking an arrow backwards (a response)
 * costs 1.5× a forward hop, so an all-forward route wins over an equally short one with a reversed hop.
 * Connections in `prefer` (those the journey already uses) are slightly cheaper, so a response
 * returns the way the request came. Returns [] when from === to and null when not connected.
 */
export function findPath(s: Scene, from: string, to: string, prefer?: Set<string>): JStep[] | null {
  if (from === to) return [];
  const FWD = 4, BACK = 6; // integer costs → bucket queue (Dijkstra without a heap)
  const adj = new Map<string, { to: string; step: JStep; cost: number }[]>();
  const add = (a: string, b: string, step: JStep, cost: number) => {
    let l = adj.get(a);
    if (!l) adj.set(a, (l = []));
    l.push({ to: b, step, cost });
  };
  for (const e of Object.values(s.edges)) {
    const d = prefer?.has(e.id) ? 1 : 0;
    add(e.from, e.to, { edge: e.id }, FWD - d);
    add(e.to, e.from, { edge: e.id, back: true }, BACK - d);
  }
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { node: string; step: JStep }>();
  const buckets: string[][] = [[from]];
  for (let c = 0; c < buckets.length; c++) {
    for (const n of buckets[c] ?? []) {
      if (dist.get(n) !== c) continue; // stale entry
      if (n === to) return walkBack(prev, from, to);
      for (const h of adj.get(n) ?? []) {
        const d = c + h.cost;
        if (d >= (dist.get(h.to) ?? Infinity)) continue;
        dist.set(h.to, d);
        prev.set(h.to, { node: n, step: h.step });
        (buckets[d] ??= []).push(h.to);
      }
    }
  }
  return null;
}

function walkBack(prev: Map<string, { node: string; step: JStep }>, from: string, to: string): JStep[] {
  const path: JStep[] = [];
  for (let n = to; n !== from; ) {
    const p = prev.get(n)!;
    path.push({ ...p.step });
    n = p.node;
  }
  return path.reverse();
}

/** Steps from the journey's end (or `start`) to `edgeId`, then along it. Null if unreachable. */
export function stepsToEdge(s: Scene, start: string | null, edgeId: string, prefer?: Set<string>): JStep[] | null {
  const e = s.edges[edgeId];
  if (!e) return null;
  if (!start || start === e.from) return [{ edge: e.id }];
  if (start === e.to) return [{ edge: e.id, back: true }];
  const lead = findPath(s, start, e.from, prefer);
  return lead ? [...lead, { edge: e.id }] : null;
}

/** Drop steps whose connection no longer exists. Returns true if anything changed. */
export function pruneJourneys(s: Scene): boolean {
  let changed = false;
  for (const j of s.journeys) {
    const kept = j.steps.filter((st) => s.edges[st.edge]);
    if (kept.length !== j.steps.length) { j.steps = kept; changed = true; }
  }
  return changed;
}

/** "Web app → API gateway" for a step. */
export function stepText(s: Scene, st: JStep): string {
  const ends = stepEnds(s, st);
  if (!ends) return '?';
  return `${s.nodes[ends.from]?.label ?? '?'} → ${s.nodes[ends.to]?.label ?? '?'}`;
}

/** Steps per edge (an edge can appear in several steps, e.g. a request and its response). */
export function journeyEdges(j: Journey): Map<string, number[]> {
  const m = new Map<string, number[]>();
  j.steps.forEach((st, k) => {
    const l = m.get(st.edge);
    l ? l.push(k) : m.set(st.edge, [k]);
  });
  return m;
}

/** Journey playback timing shared by the 2D and 3D views: one hop every STEP_MS. */
export const STEP_MS = 1100;

/**
 * Where the journey token is at time `now`: the step index and progress 0..1 along it.
 * step < 0 (whole journey) walks every step in order and loops; otherwise loops the given step.
 */
export function tokenAt(j: Journey, step: number, now: number): { k: number; t: number } | null {
  if (!j.steps.length) return null;
  if (step >= 0) return { k: Math.min(step, j.steps.length - 1), t: (now % STEP_MS) / STEP_MS };
  const total = j.steps.length * STEP_MS + 600; // short pause before looping
  const ph = now % total;
  const k = Math.floor(ph / STEP_MS);
  if (k >= j.steps.length) return null;
  return { k, t: (ph - k * STEP_MS) / STEP_MS };
}
