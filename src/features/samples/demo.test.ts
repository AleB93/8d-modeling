import { describe, expect, it } from 'vitest';
import { demoScene } from './demo';
import { journeyEnd, stepEnds, stepText } from '../journeys/journeys';
import { validateScene } from '../persistence/persist';

describe('demoScene', () => {
  const s = demoScene();
  const byLabel = (l: string) => Object.values(s.nodes).find((n) => n.label === l)!;

  it('is a valid scene with three floors bottom-up', () => {
    expect(() => validateScene(structuredClone(s))).not.toThrow();
    expect(s.layers.map((l) => l.name)).toEqual(['Data', 'Services', 'Edge']);
    expect(Object.keys(s.nodes)).toHaveLength(10);
    expect(Object.keys(s.edges)).toHaveLength(12);
    expect(s.stops.map((st) => st.name)).toEqual(['Overview', 'Data tier', 'Entry point']);
  });

  it('places clients on the edge floor and data stores on the data floor', () => {
    const [data, , edge] = s.layers;
    expect(byLabel('Web app')).toMatchObject({ kind: 'client', layer: edge.id, capacity: 300 });
    expect(byLabel('Postgres')).toMatchObject({ kind: 'database', layer: data.id });
  });

  it('every edge connects existing nodes', () => {
    for (const e of Object.values(s.edges)) {
      expect(s.nodes[e.from]).toBeDefined();
      expect(s.nodes[e.to]).toBeDefined();
    }
  });

  it('has journeys over existing connections, with responses walked backwards', () => {
    expect(s.journeys.map((j) => j.name)).toEqual(['Place order', 'Browse (mobile)']);
    const browse = s.journeys[1];
    for (const st of s.journeys.flatMap((j) => j.steps)) expect(stepEnds(s, st)).not.toBeNull();
    expect(stepEnds(s, browse.steps[1])!.from).toBe(stepEnds(s, browse.steps[0])!.to);
    expect(browse.steps.filter((st) => st.back).map((st) => st.note)).toEqual(['200 OK', 'render list']);
    expect(stepText(s, browse.steps[0])).toBe('Mobile app → Load balancer');
    expect(journeyEnd(s, browse)).toBe(byLabel('Mobile app').id);
    expect(journeyEnd(s, s.journeys[0])).toBe(byLabel('Postgres').id);
  });

  it('creates fresh ids on every call', () => {
    expect(Object.keys(demoScene().nodes)).not.toEqual(Object.keys(s.nodes));
  });
});
