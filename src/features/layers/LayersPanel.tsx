import { createMemo, createSignal, For, Show } from 'solid-js';
import { store } from '../../shared/appStore';
import { addPage, deletePage, ensurePages, layerPages, pagesOf } from '../../shared/model/pages';
import { Layer, uid } from '../../shared/model/types';
import { Icon } from '../../shared/ui/icons';

// Pages are folders; each holds its own floors (top of the list = top floor in 3D).
// The open page (the active layer's page) is the one the 2D editor shows.

export function LayersPanel(props: { ver: () => number; toast: (m: string) => void; onPage?: (id: string) => void }) {
  const tree = createMemo(() => {
    props.ver();
    const s = store.scene;
    const lp = layerPages(s);
    const counts = new Map<string, number>();
    for (const n of Object.values(s.nodes)) counts.set(n.layer, (counts.get(n.layer) ?? 0) + 1);
    return pagesOf(s).map((p) => {
      const floors = s.layers.map((l, i) => ({ l, i })).filter((r) => lp.get(r.l.id) === p.id).reverse();
      return { p, floors, count: floors.reduce((a, r) => a + (counts.get(r.l.id) ?? 0), 0), counts };
    });
  }, [], { equals: false });
  const multi = createMemo(() => tree().length > 1);
  const page = createMemo(() => (props.ver(), store.activePage));
  const active = createMemo(() => (props.ver(), store.activeLayer));
  const all = createMemo(() => (props.ver(), store.allLayers));
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [closed, setClosed] = createSignal<Set<string>>(new Set());
  const isOpen = (id: string) => id === page() || !closed().has(id);
  const toggle = (id: string) => {
    const c = new Set(closed());
    if (c.has(id)) c.delete(id); else c.add(id);
    setClosed(c);
  };

  const addFloor = (pageId = store.activePage) => {
    const onPage = tree().find((t) => t.p.id === pageId)?.floors.length ?? 0;
    const l: Layer = { id: uid('l'), name: `Floor ${onPage + 1}`, visible: true };
    store.update((s) => { if (s.pages?.length) l.page = pageId; s.layers.push(l); });
    store.setActiveLayer(l.id);
  };
  const newPage = () => {
    let made = '';
    store.update((s) => { made = addPage(s).layer.id; });
    store.focusLayer(made);
  };
  // swap with the next floor of the same page, up (+1) or down (-1)
  const move = (pageId: string, i: number, d: number) => store.update((s) => {
    const lp = layerPages(s);
    let j = i + d;
    while (j >= 0 && j < s.layers.length && lp.get(s.layers[j].id) !== pageId) j += d;
    if (j < 0 || j >= s.layers.length) return;
    [s.layers[i], s.layers[j]] = [s.layers[j], s.layers[i]];
  });
  const removeFloor = (pageId: string, i: number) => {
    const s = store.scene;
    const t = tree().find((x) => x.p.id === pageId)!;
    if (t.floors.length < 2) return props.toast('A page needs at least one floor');
    const id = s.layers[i].id;
    const k = t.floors.findIndex((r) => r.i === i);
    const target = (t.floors[k + 1] ?? t.floors[k - 1]).l; // the floor below, or above for the bottom one
    const n = t.counts.get(id) ?? 0;
    store.update((sc) => {
      for (const node of Object.values(sc.nodes)) if (node.layer === id) node.layer = target.id;
      sc.layers.splice(i, 1);
    });
    if (store.activeLayer === id) store.setActiveLayer(target.id);
    if (n) props.toast(`Moved ${n} box${n > 1 ? 'es' : ''} to “${target.name}”`);
  };
  const removePage = (pageId: string) => {
    if (!multi()) return props.toast('A scene needs at least one page');
    const name = tree().find((t) => t.p.id === pageId)!.p.name;
    const wasOpen = page() === pageId;
    let n = 0;
    store.update((s) => { n = deletePage(s, pageId); });
    if (wasOpen) store.openPage(pagesOf(store.scene)[0].id);
    props.toast(`Deleted page “${name}”${n ? ` and its ${n} box${n > 1 ? 'es' : ''}` : ''}. Ctrl+Z to undo`);
  };
  const rename = (kind: 'page' | 'layer', id: string, v: string) => {
    if (v) store.update((s) => {
      if (kind === 'page') ensurePages(s).find((p) => p.id === id)!.name = v;
      else s.layers.find((l) => l.id === id)!.name = v;
    });
    setRenaming(null);
  };
  const nameInput = (kind: 'page' | 'layer', id: string, value: string) => (
    <input class="name" value={value} ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
      onBlur={(e) => rename(kind, id, e.currentTarget.value.trim())} />
  );

  return (
    <aside class="layers panel">
      <h3>
        <Icon name="layers" size={16} /> Layers
        <button class="icon sm" title="New page: a separate diagram, shown next to the others in 3D" onClick={newPage}><Icon name="folderPlus" size={16} /></button>
        <button class="icon sm" title="Add floor on top of this page" onClick={() => addFloor()}><Icon name="plus" size={16} /></button>
      </h3>
      <div class="layer all" classList={{ on: all() }} onClick={() => store.setAllLayers(true)} title="Show every floor of this page at full brightness">
        <span class="icon-spacer"><Icon name="layers" size={14} /></span>
        <span class="name">All layers</span>
        <span class="count">{tree().find((t) => t.p.id === page())?.count ?? 0}</span>
      </div>
      <For each={tree()}>
        {(t) => (
          <div class="page" classList={{ open: isOpen(t.p.id) }}>
            <div class="layer folder" classList={{ current: page() === t.p.id }}
              title={page() === t.p.id ? 'Show this page' : 'Open this page'} onClick={() => { store.openPage(t.p.id); props.onPage?.(t.p.id); }}>
              <button class="icon sm" title={isOpen(t.p.id) ? 'Collapse' : 'Expand'} disabled={page() === t.p.id}
                onClick={(e) => { e.stopPropagation(); toggle(t.p.id); }}>
                <span class="chev"><Icon name="chevron" size={14} /></span>
              </button>
              <Icon name="folder" size={15} />
              <Show when={renaming() === t.p.id} fallback={<span class="name" onDblClick={() => setRenaming(t.p.id)} title="Double-click to rename">{t.p.name}</span>}>
                {nameInput('page', t.p.id, t.p.name)}
              </Show>
              <span class="count">{t.count}</span>
              <span class="acts">
                <button class="icon sm" title="Add floor to this page" onClick={(e) => { e.stopPropagation(); store.openPage(t.p.id); addFloor(t.p.id); }}><Icon name="plus" size={14} /></button>
                <button class="icon sm" title="Delete page" onClick={(e) => { e.stopPropagation(); removePage(t.p.id); }}><Icon name="trash" size={14} /></button>
              </span>
            </div>
            <Show when={isOpen(t.p.id)}>
              <For each={t.floors}>
                {(row) => (
                  <div class="layer floor" classList={{ on: !all() && active() === row.l.id, target: all() && active() === row.l.id, off: !row.l.visible }}
                    title={all() && active() === row.l.id ? 'New boxes go on this layer' : undefined} onClick={() => store.focusLayer(row.l.id)}>
                    <button class="icon sm" title="Toggle visibility" onClick={(e) => { e.stopPropagation(); store.update((s) => { s.layers[row.i].visible = !s.layers[row.i].visible; }); }}>
                      <Icon name={row.l.visible ? 'eye' : 'eyeOff'} size={16} />
                    </button>
                    <Show when={renaming() === row.l.id} fallback={<span class="name" onDblClick={() => setRenaming(row.l.id)} title="Double-click to rename">{row.l.name}</span>}>
                      {nameInput('layer', row.l.id, row.l.name)}
                    </Show>
                    <span class="count">{t.counts.get(row.l.id) ?? 0}</span>
                    <span class="acts">
                      <button class="icon sm" title="Move up" onClick={(e) => { e.stopPropagation(); move(t.p.id, row.i, 1); }}><Icon name="up" size={14} /></button>
                      <button class="icon sm" title="Move down" onClick={(e) => { e.stopPropagation(); move(t.p.id, row.i, -1); }}><Icon name="down" size={14} /></button>
                      <button class="icon sm" title="Delete floor" onClick={(e) => { e.stopPropagation(); removeFloor(t.p.id, row.i); }}><Icon name="trash" size={14} /></button>
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        )}
      </For>
      <p class="muted small">Each page is its own diagram; 3D shows them side by side. Top of a page = top floor.</p>
    </aside>
  );
}
