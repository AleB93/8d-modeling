import { createMemo, createSignal, For, Show } from 'solid-js';
import { store } from '../../shared/appStore';
import type { Stop } from '../../shared/model/types';
import { Icon } from '../../shared/ui/icons';

export function TourPanel(props: { ver: () => number; go: (i: number) => void; present: () => void; capture: (name: string) => Stop }) {
  const stops = createMemo(() => (props.ver(), store.scene.stops.slice()), [], { equals: false });
  const [renaming, setRenaming] = createSignal<string | null>(null);
  return (
    <aside class="tour panel">
      <h3><Icon name="camera" size={16} /> Tour
        <button class="icon sm" title="Save current view as a stop" onClick={() => {
          const s = props.capture(`View ${store.scene.stops.length + 1}`);
          store.update((sc) => { sc.stops.push(s); });
        }}><Icon name="plus" size={16} /></button>
      </h3>
      <For each={stops()} fallback={<p class="muted small">Orbit to a nice angle, then press + to save it.</p>}>
        {(s, i) => (
          <div class="layer" onClick={() => props.go(i())}>
            <span class="num">{i() + 1}</span>
            <Show when={store.journeyById(s.journey)}>{(j) => <span class="jdot sm" style={{ background: j().color }} title={`Shows journey “${j().name}”`} />}</Show>
            <Show when={renaming() === s.id} fallback={<span class="name" onDblClick={(e) => { e.stopPropagation(); setRenaming(s.id); }}>{s.name}</span>}>
              <input class="name" value={s.name} ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
                onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v) store.update((sc) => { const x = sc.stops.find((y) => y.id === s.id); if (x) x.name = v; }); setRenaming(null); }} />
            </Show>
            <span class="acts">
              <button class="icon sm" title="Update with current view" onClick={(e) => {
                e.stopPropagation();
                const c = props.capture(s.name);
                store.update((sc) => { const x = sc.stops.find((y) => y.id === s.id); if (x) { x.pos = c.pos; x.target = c.target; x.journey = c.journey; } });
              }}><Icon name="camera" size={14} /></button>
              <button class="icon sm" title="Delete stop" onClick={(e) => { e.stopPropagation(); store.update((sc) => { sc.stops = sc.stops.filter((y) => y.id !== s.id); }); }}><Icon name="trash" size={14} /></button>
            </span>
          </div>
        )}
      </For>
      <button class="btn primary" onClick={props.present} disabled={!stops().length}><Icon name="play" size={16} /> Present</button>
    </aside>
  );
}
