import { describe, expect, it } from 'vitest';
import { findPath, journeyEdges, journeyEnd, journeyNodes, pruneJourneys, STEP_MS, stepEnds, stepsToEdge, stepText, tokenAt } from './journeys';
import { emptyScene, Journey, JStep, makeEdge, makeNode } from '../../shared/model/types';

/** Scene with nodes named by label; `edges` are [from, to] label pairs. Returns ids by label. */
function build(labels: string[], edges: [string, string][]) {
  const s = emptyScene();
  const id: Record<string, string> = {};
  for (const l of labels) {
    const n = makeNode('service', 0, 0, s.layers[0].id, { label: l });
    s.nodes[n.id] = n;
    id[l] = n.id;
  }
  const eid: Record<string, string> = {};
  for (const [a, b] of edges) {
    const e = makeEdge(id[a], id[b]);
    s.edges[e.id] = e;
    eid[a + b] = e.id;
  }
  return { s, id, eid };
}

const journey = (steps: JStep[]): Journey => ({ id: 'j', name: 'J', color: '#fff', steps });

describe('stepEnds', () => {
  const { s, id, eid } = build(['A', 'B'], [['A', 'B']]);

  it('follows the arrow, or runs against it for back steps', () => {
    expect(stepEnds(s, { edge: eid.AB })).toEqual({ from: id.A, to: id.B });
    expect(stepEnds(s, { edge: eid.AB, back: true })).toEqual({ from: id.B, to: id.A });
  });

  it('is null for a missing edge', () => {
    expect(stepEnds(s, { edge: 'e_gone' })).toBeNull();
  });
});

describe('journeyNodes / journeyEnd', () => {
  const { s, id, eid } = build(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]);

  it('collects every touched node, skipping dangling steps', () => {
    const j = journey([{ edge: eid.AB }, { edge: 'e_gone' }, { edge: eid.BC }]);
    expect(journeyNodes(s, j)).toEqual(new Set([id.A, id.B, id.C]));
  });

  it('ends at the last resolvable step', () => {
    expect(journeyEnd(s, journey([{ edge: eid.AB }, { edge: eid.BC, back: true }, { edge: 'e_gone' }]))).toBe(id.B);
    expect(journeyEnd(s, journey([{ edge: 'e_gone' }]))).toBeNull();
    expect(journeyEnd(s, journey([]))).toBeNull();
  });
});

describe('findPath', () => {
  it('returns [] for the same node and null when unconnected', () => {
    const { s, id } = build(['A', 'B'], []);
    expect(findPath(s, id.A, id.A)).toEqual([]);
    expect(findPath(s, id.A, id.B)).toBeNull();
  });

  it('walks arrows backwards when needed', () => {
    const { s, id, eid } = build(['A', 'B', 'C'], [['A', 'B'], ['C', 'B']]);
    expect(findPath(s, id.A, id.C)).toEqual([{ edge: eid.AB }, { edge: eid.CB, back: true }]);
  });

  it('prefers an all-forward route over an equally short one with a reversed hop', () => {
    // A→B→D (forward, forward) vs A→C, D→C (forward, back)
    const { s, id, eid } = build(['A', 'B', 'C', 'D'], [['A', 'C'], ['D', 'C'], ['A', 'B'], ['B', 'D']]);
    expect(findPath(s, id.A, id.D)).toEqual([{ edge: eid.AB }, { edge: eid.BD }]);
  });

  it('takes a short reversed hop over a much longer forward detour', () => {
    // B→A directly (one back hop, cost 6) vs A→C→D→B (three forward hops, cost 12)
    const { s, id, eid } = build(['A', 'B', 'C', 'D'], [['B', 'A'], ['A', 'C'], ['C', 'D'], ['D', 'B']]);
    expect(findPath(s, id.A, id.B)).toEqual([{ edge: eid.BA, back: true }]);
  });

  it('prefers connections the journey already uses', () => {
    // two parallel A→B connections: the preferred one wins whichever comes first
    const { s, id } = build(['A', 'B'], []);
    const e1 = makeEdge(id.A, id.B), e2 = makeEdge(id.A, id.B);
    s.edges[e1.id] = e1;
    s.edges[e2.id] = e2;
    expect(findPath(s, id.A, id.B)).toEqual([{ edge: e1.id }]);
    expect(findPath(s, id.A, id.B, new Set([e2.id]))).toEqual([{ edge: e2.id }]);
    // a response returns the way the request came
    expect(findPath(s, id.B, id.A, new Set([e2.id]))).toEqual([{ edge: e2.id, back: true }]);
  });

  it('skips stale queue entries after a node is reached more cheaply', () => {
    // A→D preferred (3), then D–C backwards reaches C at 9; A→B (4), B→C (4) improves C to 8.
    // The target is unreachable, so the stale C entry at 9 is visited and skipped.
    const { s, id, eid } = build(['A', 'B', 'C', 'D', 'Z'], [['A', 'D'], ['C', 'D'], ['A', 'B'], ['B', 'C']]);
    expect(findPath(s, id.A, id.Z, new Set([eid.AD]))).toBeNull();
    expect(findPath(s, id.A, id.C, new Set([eid.AD]))).toEqual([{ edge: eid.AB }, { edge: eid.BC }]);
  });

  it('returns copies of the steps', () => {
    const { s, id } = build(['A', 'B'], [['A', 'B']]);
    const p1 = findPath(s, id.A, id.B)!;
    p1[0].note = 'x';
    expect(findPath(s, id.A, id.B)![0].note).toBeUndefined();
  });
});

describe('stepsToEdge', () => {
  const { s, id, eid } = build(['A', 'B', 'C', 'D'], [['A', 'B'], ['B', 'C']]);

  it('is null for a missing edge', () => {
    expect(stepsToEdge(s, id.A, 'e_gone')).toBeNull();
  });

  it('starts a fresh journey along the edge', () => {
    expect(stepsToEdge(s, null, eid.BC)).toEqual([{ edge: eid.BC }]);
    expect(stepsToEdge(s, id.B, eid.BC)).toEqual([{ edge: eid.BC }]);
  });

  it('walks the edge backwards when standing at its head', () => {
    expect(stepsToEdge(s, id.C, eid.BC)).toEqual([{ edge: eid.BC, back: true }]);
  });

  it('leads up to the edge first', () => {
    expect(stepsToEdge(s, id.A, eid.BC)).toEqual([{ edge: eid.AB }, { edge: eid.BC }]);
  });

  it('is null when the edge cannot be reached', () => {
    expect(stepsToEdge(s, id.D, eid.BC)).toBeNull();
  });
});

describe('pruneJourneys', () => {
  it('drops steps whose edge was deleted and reports changes', () => {
    const { s, eid } = build(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]);
    s.journeys = [journey([{ edge: eid.AB }, { edge: eid.BC }]), { ...journey([{ edge: eid.AB }]), id: 'j2' }];
    expect(pruneJourneys(s)).toBe(false);
    delete s.edges[eid.BC];
    expect(pruneJourneys(s)).toBe(true);
    expect(s.journeys[0].steps).toEqual([{ edge: eid.AB }]);
    expect(s.journeys[1].steps).toEqual([{ edge: eid.AB }]);
    expect(pruneJourneys(s)).toBe(false);
  });
});

describe('stepText', () => {
  it('names both ends, with ? for unknowns', () => {
    const { s, id, eid } = build(['Web', 'API'], [['Web', 'API']]);
    expect(stepText(s, { edge: eid.WebAPI })).toBe('Web → API');
    expect(stepText(s, { edge: eid.WebAPI, back: true })).toBe('API → Web');
    expect(stepText(s, { edge: 'e_gone' })).toBe('?');
    delete s.nodes[id.API];
    expect(stepText(s, { edge: eid.WebAPI })).toBe('Web → ?');
    delete s.nodes[id.Web];
    expect(stepText(s, { edge: eid.WebAPI })).toBe('? → ?');
  });
});

describe('journeyEdges', () => {
  it('maps each edge to the step indexes that use it', () => {
    const j = journey([{ edge: 'a' }, { edge: 'b' }, { edge: 'a', back: true }]);
    expect(journeyEdges(j)).toEqual(new Map([['a', [0, 2]], ['b', [1]]]));
  });
});

describe('tokenAt', () => {
  const j = journey([{ edge: 'a' }, { edge: 'b' }, { edge: 'c' }]);

  it('is null for an empty journey', () => {
    expect(tokenAt(journey([]), -1, 0)).toBeNull();
    expect(tokenAt(journey([]), 0, 0)).toBeNull();
  });

  it('loops a single step, clamped to the last one', () => {
    expect(tokenAt(j, 1, STEP_MS / 4)).toEqual({ k: 1, t: 0.25 });
    expect(tokenAt(j, 1, STEP_MS * 5 + STEP_MS / 2)).toEqual({ k: 1, t: 0.5 });
    expect(tokenAt(j, 9, 0)).toEqual({ k: 2, t: 0 });
  });

  it('walks the whole journey in order, pauses, then loops', () => {
    expect(tokenAt(j, -1, 0)).toEqual({ k: 0, t: 0 });
    expect(tokenAt(j, -1, STEP_MS * 1.5)).toEqual({ k: 1, t: 0.5 });
    expect(tokenAt(j, -1, STEP_MS * 2.75)).toEqual({ k: 2, t: 0.75 });
    expect(tokenAt(j, -1, STEP_MS * 3 + 100)).toBeNull(); // pause
    const total = STEP_MS * 3 + 600;
    expect(tokenAt(j, -1, total + STEP_MS * 1.5)).toEqual({ k: 1, t: 0.5 });
  });
});
