import type { SNode } from './types';

export const cxOf = (n: SNode) => n.x + n.w / 2;
export const cyOf = (n: SNode) => n.y + n.h / 2;

/** Point where the ray from n's center toward (tx, ty) leaves n's rect. */
export function clipToRect(n: SNode, tx: number, ty: number): [number, number] {
  const cx = cxOf(n), cy = cyOf(n);
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const sx = dx === 0 ? Infinity : n.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : n.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}

export function edgeEnds(a: SNode, b: SNode): [number, number, number, number] {
  const [x1, y1] = clipToRect(a, cxOf(b), cyOf(b));
  const [x2, y2] = clipToRect(b, cxOf(a), cyOf(a));
  return [x1, y1, x2, y2];
}

export function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function bounds(nodes: Iterable<SNode>) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h);
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}
