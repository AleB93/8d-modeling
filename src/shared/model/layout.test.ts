import { describe, expect, it } from 'vitest';
import { autoLayout } from './layout';
import { emptyScene, makeEdge, makeNode } from './types';

describe('autoLayout', () => {
  it('places each box under its callers, so arrows do not cross', () => {
    const s = emptyScene();
    const L = s.layers[0].id;
    const left = makeNode('client', -500, 0, L, { label: 'B left' });
    const right = makeNode('client', 500, 0, L, { label: 'A right' });
    const zUnderLeft = makeNode('service', 0, 0, L, { label: 'Z' });
    const aUnderRight = makeNode('service', 0, 0, L, { label: 'A' });
    for (const n of [left, right, zUnderLeft, aUnderRight]) s.nodes[n.id] = n;
    for (const e of [makeEdge(left.id, zUnderLeft.id), makeEdge(right.id, aUnderRight.id)]) s.edges[e.id] = e;
    autoLayout(s);
    expect(left.x).toBeLessThan(right.x); // sources keep their order
    expect(zUnderLeft.x).toBeLessThan(aUnderRight.x); // not alphabetical: under their callers
    expect(zUnderLeft.y).toBeGreaterThan(left.y);
  });
});
