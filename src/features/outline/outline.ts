import { KINDS, Scene, SNode } from '../../shared/model/types';
import { stepText } from '../journeys/journeys';
import { pageLayers, pagesOf } from '../../shared/model/pages';

// A text version of the diagram, for anything that can't see the canvas: screen readers and
// AI agents that read the page structure (e.g. Claude in Chrome's page reader).

export interface OutlineLink { id: string; text: string }
export interface OutlineNode { id: string; text: string; links: OutlineLink[] }
export interface OutlineFloor { id: string; text: string; nodes: OutlineNode[] }
export interface OutlineJourney { id: string; text: string; steps: string[] }
export interface Outline { summary: string; floors: OutlineFloor[]; journeys: OutlineJourney[] }

const plural = (n: number, word: string, many = word + 's') => `${n} ${n === 1 ? word : many}`;

function nodeText(n: SNode): string {
  const kind = n.kind === 'text' ? 'note' : KINDS[n.kind].name.toLowerCase();
  return `${n.label || '(unnamed)'}, ${kind}${n.down ? ', down' : ''}`;
}

/** Pages in order, each page's floors top to bottom, boxes in reading order (top-left first), each with its outgoing connections. */
export function sceneOutline(s: Scene): Outline {
  const nodes = Object.values(s.nodes);
  const edges = Object.values(s.edges);
  const label = (id: string) => s.nodes[id]?.label || '(unnamed)';
  const pages = pagesOf(s);
  const floors = pages.flatMap((p) => pageLayers(s, p.id).reverse().map((l) => ({ l, p }))).map(({ l, p }) => ({
    id: l.id,
    text: `${pages.length > 1 ? `${p.name}: floor` : 'Floor'} ${l.name}${l.visible ? '' : ' (hidden)'}`,
    nodes: nodes
      .filter((n) => n.layer === l.id)
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((n) => ({
        id: n.id,
        text: nodeText(n),
        links: edges
          .filter((e) => e.from === n.id)
          .map((e) => ({
            id: e.id,
            text: `→ ${label(e.to)}${e.label ? ` (${e.label})` : ''}${e.dashed ? ', async' : ''}`,
          })),
      })),
  }));
  return {
    summary: `Diagram with ${pages.length > 1 ? `${plural(pages.length, 'page')}, ` : ''}${plural(nodes.length, 'box', 'boxes')}, ${plural(edges.length, 'connection')}, ${plural(s.layers.length, 'floor')} and ${plural(s.journeys.length, 'journey')}.`,
    floors,
    journeys: s.journeys.map((j) => ({
      id: j.id,
      text: `${j.name} (${plural(j.steps.length, 'step')})`,
      steps: j.steps.map((st) => `${stepText(s, st)}${st.back ? ' (response)' : ''}${st.note ? `: ${st.note}` : ''}`),
    })),
  };
}
