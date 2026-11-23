import { KINDS, makeEdge, makeNode, NodeKind, Scene, SEdge, SNode, uid } from './types';

/**
 * Synthetic large system for performance testing: `n` nodes over 4 floors laid out on a grid,
 * each node calling 1–2 nodes in the row below (≈1.5 edges per node), clients on the top floor.
 */
export function stressScene(n = 2000): Scene {
  const floors = 4;
  const layers = Array.from({ length: floors }, (_, i) => ({ id: uid('l'), name: `Floor ${i + 1}`, visible: true }));
  const perFloor = Math.ceil(n / floors);
  const cols = Math.ceil(Math.sqrt(perFloor * 2));
  const kindsByFloor: NodeKind[][] = [['database', 'cache', 'queue'], ['service', 'queue'], ['service', 'cache'], ['client', 'lb']];
  const rows: SNode[][] = [];
  let rnd = 12345;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const nodes: SNode[] = [];
  for (let f = 0; f < floors; f++) {
    const list: SNode[] = [];
    for (let i = 0; i < perFloor && nodes.length < n; i++) {
      const kinds = kindsByFloor[f];
      const kind = kinds[Math.floor(rand() * kinds.length)];
      const d = KINDS[kind];
      const node = makeNode(kind, (i % cols) * 220, Math.floor(i / cols) * 170 + f * 40, layers[f].id, {
        label: `${d.name} ${f}.${i}`, capacity: kind === 'client' ? 20 : d.capacity,
      });
      list.push(node);
      nodes.push(node);
    }
    rows.push(list);
  }
  const edges: SEdge[] = [];
  for (let f = floors - 1; f > 0; f--) {
    const below = rows[f - 1];
    rows[f].forEach((a, i) => {
      const k = 1 + (rand() < 0.5 ? 1 : 0);
      for (let j = 0; j < k; j++) {
        const b = below[Math.min(below.length - 1, Math.floor(i * (below.length / rows[f].length)) + j)];
        edges.push(makeEdge(a.id, b.id, { mult: j ? 0.3 : 1 }));
      }
    });
  }
  return {
    v: 1,
    nodes: Object.fromEntries(nodes.map((x) => [x.id, x])),
    edges: Object.fromEntries(edges.map((e) => [e.id, e])),
    layers,
    stops: [],
    journeys: [],
  };
}
