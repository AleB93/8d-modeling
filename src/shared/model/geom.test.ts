import { describe, expect, it } from 'vitest';
import { bounds, clipToRect, cxOf, cyOf, distToSeg, edgeEnds } from './geom';
import { makeNode } from './types';

const box = (x: number, y: number, w: number, h: number) => makeNode('service', x, y, 'l', { w, h });

describe('centers', () => {
  it('computes the center of a node', () => {
    const n = box(10, 20, 100, 40);
    expect(cxOf(n)).toBe(60);
    expect(cyOf(n)).toBe(40);
  });
});

describe('clipToRect', () => {
  const n = box(0, 0, 100, 50); // center (50, 25), half sizes 50 x 25

  it('returns the center when the target is the center', () => {
    expect(clipToRect(n, 50, 25)).toEqual([50, 25]);
  });

  it('clips straight horizontal and vertical rays at the sides', () => {
    expect(clipToRect(n, 500, 25)).toEqual([100, 25]);
    expect(clipToRect(n, -500, 25)).toEqual([0, 25]);
    expect(clipToRect(n, 50, 500)).toEqual([50, 50]);
    expect(clipToRect(n, 50, -500)).toEqual([50, 0]);
  });

  it('clips diagonal rays at whichever side they leave first', () => {
    expect(clipToRect(n, 150, 75)).toEqual([100, 50]); // along the diagonal: the corner
    expect(clipToRect(n, 60, 125)).toEqual([52.5, 50]); // steep ray hits the bottom
    expect(clipToRect(n, 250, 35)).toEqual([100, 27.5]); // shallow ray hits the right side
  });
});

describe('edgeEnds', () => {
  it('runs between the facing sides of two boxes', () => {
    const a = box(0, 0, 100, 50), b = box(300, 0, 100, 50);
    expect(edgeEnds(a, b)).toEqual([100, 25, 300, 25]);
  });
});

describe('distToSeg', () => {
  it('measures to the interior and the endpoints', () => {
    expect(distToSeg(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(distToSeg(-3, 4, 0, 0, 10, 0)).toBe(5); // before the start
    expect(distToSeg(13, 4, 0, 0, 10, 0)).toBe(5); // past the end
  });

  it('handles a zero-length segment', () => {
    expect(distToSeg(3, 4, 0, 0, 0, 0)).toBe(5);
  });
});

describe('bounds', () => {
  it('returns null for no nodes', () => {
    expect(bounds([])).toBeNull();
  });

  it('encloses every node', () => {
    expect(bounds([box(0, 0, 10, 10), box(-5, 20, 10, 5)])).toEqual({ x0: -5, y0: 0, x1: 10, y1: 25 });
  });
});
