import { createMemo, createSignal, For, Show } from 'solid-js';
import { store } from '../../shared/appStore';
import { uid } from '../../shared/model/types';
import { Icon } from '../../shared/ui/icons';

export function LayersPanel(props: { ver: () => number; toast: (m: string) => void }) {
  const layers = createMemo(() => (props.ver(), store.scene.layers.map((l, i) => ({ l, i })).reverse()), [], { equals: false });
  const counts = createMemo(() => {
    props.ver();
    const c = new Map<string, number>();
    for (const n of Object.values(store.scene.nodes)) c.set(n.layer, (c.get(n.layer) ?? 0) + 1);
    return c;
  });
  const active = createMemo(() => (props.ver(), store.activeLayer));
  const all = createMemo(() => (props.ver(), store.allLayers));
  const [renaming, setRenaming] = createSignal<string | null>(null);

  const add = () => {
    const l = { id: uid('l'), name: `Floor ${store.scene.layers.length + 1}`, visible: true };
    store.update((s) => { s.layers.push(l); });
    store.setActiveLayer(l.id);
  };
  const move = (i: number, d: number) => store.update((s) => {
    const j = i + d;
    if (j < 0 || j >= s.layers.length) return;
    [s.layers[i], s.layers[j]] = [s.layers[j], s.layers[i]];
  });
  const remove = (i: number) => {
    const s = store.scene;
    if (s.layers.length < 2) return props.toast('A scene needs at least one layer');
    const id = s.layers[i].id;
    const target = s.layers[i === 0 ? 1 : i - 1];
    const n = counts().get(id) ?? 0;
    store.update((sc) => {
      for (const node of Object.values(sc.nodes)) if (node.layer === id) node.layer = target.id;
      sc.layers.splice(i, 1);
    });
    if (store.activeLayer === id) store.setActiveLayer(target.id);
    if (n) props.toast(`Moved ${n} node${n > 1 ? 's' : ''} to “${target.name}”`);
  };

  return (
    <aside class="layers panel">
      <h3><Icon name="layers" size={16} /> Layers <button class="icon sm" title="Add layer on top" onClick={add}><Icon name="plus" size={16} /></button></h3>
      <div class="layer all" classList={{ on: all() }} onClick={() => store.setAllLayers(true)} title="Show every layer at full brightness">
        <span class="icon-spacer"><Icon name="layers" size={14} /></span>
        <span class="name">All layers</span>
        <span class="count">{[...counts().values()].reduce((a, b) => a + b, 0)}</span>
      </div>
      <For each={layers()}>
        {(row) => (
          <div class="layer" classList={{ on: !all() && active() === row.l.id, target: all() && active() === row.l.id, off: !row.l.visible }}
            title={all() && active() === row.l.id ? 'New boxes go on this layer' : undefined} onClick={() => store.focusLayer(row.l.id)}>
            <button class="icon sm" title="Toggle visibility" onClick={(e) => { e.stopPropagation(); store.update((s) => { s.layers[row.i].visible = !s.layers[row.i].visible; }); }}>
              <Icon name={row.l.visible ? 'eye' : 'eyeOff'} size={16} />
            </button>
            <Show when={renaming() === row.l.id} fallback={<span class="name" onDblClick={() => setRenaming(row.l.id)} title="Double-click to rename">{row.l.name}</span>}>
              <input class="name" value={row.l.name} ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
                onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v) store.update((s) => { s.layers[row.i].name = v; }); setRenaming(null); }} />
            </Show>
            <span class="count">{counts().get(row.l.id) ?? 0}</span>
            <span class="acts">
              <button class="icon sm" title="Move up" onClick={(e) => { e.stopPropagation(); move(row.i, 1); }}><Icon name="up" size={14} /></button>
              <button class="icon sm" title="Move down" onClick={(e) => { e.stopPropagation(); move(row.i, -1); }}><Icon name="down" size={14} /></button>
              <button class="icon sm" title="Delete layer" onClick={(e) => { e.stopPropagation(); remove(row.i); }}><Icon name="trash" size={14} /></button>
            </span>
          </div>
        )}
      </For>
      <p class="muted small">Top of the list = top floor in 3D.</p>
    </aside>
  );
}
