import { onMount } from 'solid-js';
import { store } from '../../shared/appStore';
import type { DesignCanvas } from './DesignCanvas';

export function LabelEditor(props: { id: string; design: DesignCanvas; done: () => void }) {
  const n = store.scene.nodes[props.id];
  if (!n) { queueMicrotask(props.done); return null; }
  const r = props.design.screenRect(n);
  const isText = n.kind === 'text';
  let el!: HTMLTextAreaElement;
  let closed = false;
  const commit = (cancel = false) => {
    if (closed) return;
    closed = true;
    const v = el.value;
    const cur = store.scene.nodes[props.id];
    if (cur && !cancel) {
      if (isText && !v.trim()) store.update((s) => { delete s.nodes[props.id]; });
      else if (v !== cur.label) {
        store.update((s) => {
          const m = s.nodes[props.id];
          m.label = v;
          if (isText) [m.w, m.h] = props.design.textSize(v);
        });
      }
    } else if (cur && cancel && isText && !cur.label.trim()) store.update((s) => { delete s.nodes[props.id]; }, false);
    props.done();
  };
  onMount(() => { el.focus(); el.select(); });
  const style = isText
    ? { left: `${r.x}px`, top: `${r.y}px`, 'min-width': `${Math.max(120, r.w)}px`, 'font-size': `${20 * r.z}px`, 'text-align': 'left' as const }
    : { left: `${r.x}px`, top: `${r.y + r.h / 2 - 18}px`, width: `${Math.max(120, r.w)}px`, 'font-size': '14px' };
  return (
    <textarea
      ref={el}
      class="labeledit"
      style={style}
      rows={isText ? Math.max(1, n.label.split('\n').length) : 1}
      value={n.label}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') commit(true);
        else if (e.key === 'Enter' && !(isText && e.shiftKey)) { e.preventDefault(); commit(); }
      }}
      onBlur={() => commit()}
    />
  );
}
