import type { Scene } from './types';
import { pageLayers, pagesOf } from './pages';

/**
 * Layered layout: rank nodes by longest path from sources (clients/entry points first), then place each
 * floor as a block of rows, top floor first, so 2D reads top-down and 3D stacks cleanly.
 */
export function autoLayout(s: Scene, onlyLayers?: Set<string>) {
  const nodes = Object.values(s.nodes).filter((n) => n.kind !== 'zone' && n.kind !== 'text');
  const ids = new Set(nodes.map((n) => n.id));
  const outs = new Map<string, string[]>();
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of Object.values(s.edges)) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    (outs.get(e.from) ?? outs.set(e.from, []).get(e.from)!).push(e.to);
    indeg.set(e.to, indeg.get(e.to)! + 1);
  }
  const rank = new Map<string, number>();
  const q = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  for (const id of q) rank.set(id, 0);
  const deg = new Map(indeg);
  while (q.length) {
    const id = q.shift()!;
    for (const t of outs.get(id) ?? []) {
      rank.set(t, Math.max(rank.get(t) ?? 0, rank.get(id)! + 1));
      deg.set(t, deg.get(t)! - 1);
      if (deg.get(t) === 0) q.push(t);
    }
  }
  const maxRank = Math.max(0, ...rank.values());
  for (const n of nodes) if (!rank.has(n.id)) rank.set(n.id, maxRank + 1); // nodes caught in cycles

  const GX = 230, GY = 170, FLOOR_GAP = 120;
  const ins = new Map<string, string[]>();
  for (const [from, tos] of outs) for (const to of tos) (ins.get(to) ?? ins.set(to, []).get(to)!).push(from);
  const placed = new Set<string>();
  for (const page of pagesOf(s)) {
  const layers = pageLayers(s, page.id);
  let y = 0;
  for (let li = layers.length - 1; li >= 0; li--) {
    const layer = layers[li];
    const ln = nodes.filter((n) => n.layer === layer.id);
    if (!ln.length) continue;
    const rows = [...new Set(ln.map((n) => rank.get(n.id)!))].sort((a, b) => a - b);
    if (!onlyLayers || onlyLayers.has(layer.id)) {
      rows.forEach((r, ri) => {
        // order a row under its callers (mean x of already-placed callers), so arrows cross less;
        // boxes nobody calls keep their current left-to-right order
        const key = (n: (typeof nodes)[number]) => {
          const xs = (ins.get(n.id) ?? []).filter((c) => placed.has(c)).map((c) => s.nodes[c].x + s.nodes[c].w / 2);
          return xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : n.x + n.w / 2;
        };
        const row = ln.filter((n) => rank.get(n.id) === r)
          .map((n) => ({ n, k: key(n) }))
          .sort((a, b) => a.k - b.k || a.n.label.localeCompare(b.n.label))
          .map((x) => x.n);
        row.forEach((n, i) => {
          n.x = Math.round((i - (row.length - 1) / 2) * GX - n.w / 2);
          n.y = Math.round(y + ri * GY + (GY - 40 - n.h) / 2);
          placed.add(n.id);
        });
      });
    }
    y += rows.length * GY + FLOOR_GAP;
  }
  }
}

