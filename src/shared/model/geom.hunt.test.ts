import { describe, expect, it } from 'vitest';
import { bounds, clipToRect, cxOf, cyOf, distToSeg, edgeEnds } from './geom';
import { makeNode } from './types';

const box = (x: number, y: number, w: number, h: number) => makeNode('service', x, y, 'l', { w, h });

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

const EPS = 1e-9;
const onBorder = (n: ReturnType<typeof box>, x: number, y: number) => {
  const inX = x >= n.x - EPS && x <= n.x + n.w + EPS, inY = y >= n.y - EPS && y <= n.y + n.h + EPS;
  const onV = Math.abs(x - n.x) < 1e-6 || Math.abs(x - n.x - n.w) < 1e-6;
  const onH = Math.abs(y - n.y) < 1e-6 || Math.abs(y - n.y - n.h) < 1e-6;
  return inX && inY && (onV || onH);
};

describe('hunt: clipToRect', () => {
  it('random targets: the result lies on the border and on the ray from the center', () => {
    const r = rng(17);
    for (let i = 0; i < 500; i++) {
      const n = box((r() - 0.5) * 1000, (r() - 0.5) * 1000, 1 + r() * 400, 1 + r() * 400);
      const tx = (r() - 0.5) * 3000, ty = (r() - 0.5) * 3000;
      const [x, y] = clipToRect(n, tx, ty);
      expect(onBorder(n, x, y)).toBe(true);
      // collinear and same direction as (tx, ty) from the center
      const ax = x - cxOf(n), ay = y - cyOf(n), bx = tx - cxOf(n), by = ty - cyOf(n);
      expect(Math.abs(ax * by - ay * bx)).toBeLessThan(1e-6 * (1 + Math.hypot(ax, ay) * Math.hypot(bx, by)));
      expect(ax * bx + ay * by).toBeGreaterThanOrEqual(0);
    }
  });

  it('targets inside the rect still project onto the border (beyond the target)', () => {
    const n = box(0, 0, 100, 100);
    expect(clipToRect(n, 60, 50)).toEqual([100, 50]);
    expect(clipToRect(n, 50, 49)).toEqual([50, 0]);
  });

  it('a zero-size node returns its center for any target', () => {
    const n = box(10, 20, 0, 0);
    expect(clipToRect(n, 500, -500)).toEqual([10, 20]);
    expect(clipToRect(n, 10, 500)).toEqual([10, 20]);
  });

  it('never returns NaN for finite inputs', () => {
    const r = rng(5);
    for (let i = 0; i < 200; i++) {
      const n = box(r() * 10, r() * 10, Math.floor(r() * 3), Math.floor(r() * 3));
      const [x, y] = clipToRect(n, Math.floor(r() * 5), Math.floor(r() * 5));
      expect(Number.isNaN(x) || Number.isNaN(y)).toBe(false);
    }
  });

  it('is invariant under translation', () => {
    const a = box(0, 0, 120, 80), b = box(1000, -500, 120, 80);
    const [x1, y1] = clipToRect(a, 300, 170);
    const [x2, y2] = clipToRect(b, 1300, -330);
    expect(x2 - 1000).toBeCloseTo(x1, 9);
    expect(y2 + 500).toBeCloseTo(y1, 9);
  });
});

describe('hunt: edgeEnds', () => {
  it('is symmetric: swapping nodes swaps the ends', () => {
    const r = rng(9);
    for (let i = 0; i < 100; i++) {
      const a = box(r() * 1000, r() * 1000, 10 + r() * 200, 10 + r() * 200);
      const b = box(r() * 1000, r() * 1000, 10 + r() * 200, 10 + r() * 200);
      const [x1, y1, x2, y2] = edgeEnds(a, b);
      expect(edgeEnds(b, a)).toEqual([x2, y2, x1, y1]);
    }
  });

  it('for separated boxes, both ends lie on the centre line, on each box’s border', () => {
    const a = box(0, 0, 100, 100), b = box(400, 300, 50, 50);
    const [x1, y1, x2, y2] = edgeEnds(a, b);
    expect(onBorder(a, x1, y1)).toBe(true);
    expect(onBorder(b, x2, y2)).toBe(true);
    expect(distToSeg(x1, y1, cxOf(a), cyOf(a), cxOf(b), cyOf(b))).toBeLessThan(1e-9);
    expect(distToSeg(x2, y2, cxOf(a), cyOf(a), cxOf(b), cyOf(b))).toBeLessThan(1e-9);
  });

  it('boxes sharing a center give both centers', () => {
    const a = box(0, 0, 100, 100), b = box(25, 25, 50, 50);
    expect(edgeEnds(a, b)).toEqual([50, 50, 50, 50]);
  });
});

describe('hunt: distToSeg', () => {
  it('is symmetric in the segment endpoints and zero on the segment', () => {
    const r = rng(11);
    for (let i = 0; i < 200; i++) {
      const [px, py, x1, y1, x2, y2] = Array.from({ length: 6 }, () => (r() - 0.5) * 100);
      expect(distToSeg(px, py, x1, y1, x2, y2)).toBeCloseTo(distToSeg(px, py, x2, y2, x1, y1), 9);
      const t = r();
      expect(distToSeg(x1 + t * (x2 - x1), y1 + t * (y2 - y1), x1, y1, x2, y2)).toBeLessThan(1e-9);
    }
  });

  it('is never more than the distance to either endpoint and never negative', () => {
    const r = rng(12);
    for (let i = 0; i < 200; i++) {
      const [px, py, x1, y1, x2, y2] = Array.from({ length: 6 }, () => (r() - 0.5) * 100);
      const d = distToSeg(px, py, x1, y1, x2, y2);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(Math.hypot(px - x1, py - y1) + 1e-9);
      expect(d).toBeLessThanOrEqual(Math.hypot(px - x2, py - y2) + 1e-9);
    }
  });

  it('clamps beyond the ends (no infinite-line distance)', () => {
    expect(distToSeg(20, 0, 0, 0, 10, 0)).toBe(10);
    expect(distToSeg(-3, 4, 0, 0, 10, 0)).toBe(5);
  });
});

describe('hunt: bounds', () => {
  it('returns null for an empty iterable, including a generator', () => {
    expect(bounds([])).toBeNull();
    expect(bounds((function* () { /* none */ })())).toBeNull();
  });

  it('contains every node and touches each side with some node', () => {
    const r = rng(21);
    const ns = Array.from({ length: 30 }, () => box((r() - 0.5) * 1000, (r() - 0.5) * 1000, r() * 300, r() * 300));
    const b = bounds(ns)!;
    for (const n of ns) {
      expect(n.x).toBeGreaterThanOrEqual(b.x0);
      expect(n.y).toBeGreaterThanOrEqual(b.y0);
      expect(n.x + n.w).toBeLessThanOrEqual(b.x1);
      expect(n.y + n.h).toBeLessThanOrEqual(b.y1);
    }
    expect(ns.some((n) => n.x === b.x0)).toBe(true);
    expect(ns.some((n) => n.x + n.w === b.x1)).toBe(true);
    expect(ns.some((n) => n.y === b.y0)).toBe(true);
    expect(ns.some((n) => n.y + n.h === b.y1)).toBe(true);
  });

  it('works with a Map values iterator (consumed once)', () => {
    const m = new Map([['a', box(0, 0, 10, 10)], ['b', box(-5, 20, 1, 1)]]);
    expect(bounds(m.values())).toEqual({ x0: -5, y0: 0, x1: 10, y1: 21 });
  });
});
