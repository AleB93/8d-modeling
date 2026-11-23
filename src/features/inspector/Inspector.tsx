import { createMemo, For, Show } from 'solid-js';
import { store } from '../../shared/appStore';
import type { SimResult } from '../simulation/sim';
import { KINDS, PALETTE, SIM_KINDS } from '../../shared/model/types';
import type { NodeKind, SEdge, SNode } from '../../shared/model/types';
import { Icon } from '../../shared/ui/icons';
import { fmt } from '../../shared/ui/format';
import { pageLayers, pageOfLayer } from '../../shared/model/pages';

function Swatches(props: { value?: string; set: (c: string) => void }) {
  return (
    <div class="swatches">
      <For each={PALETTE}>
        {(c) => <button class="sw" classList={{ on: props.value === c }} style={{ background: c }} onClick={() => props.set(c)} title={c} />}
      </For>
      <label class="sw custom" title="Custom color">
        <input type="color" value={props.value ?? '#ffffff'} onInput={(e) => props.set(e.currentTarget.value)} />
      </label>
    </div>
  );
}

export function Inspector(props: { ver: () => number; simOn: () => boolean; stats: () => SimResult | null; toggleDown: () => void }) {
  const sel = createMemo(() => (props.ver(), [...store.selection]), [], { equals: false });
  const nodes = createMemo(() => sel().map((id) => store.scene.nodes[id]).filter(Boolean) as SNode[], [], { equals: false });
  const edges = createMemo(() => sel().map((id) => store.scene.edges[id]).filter(Boolean) as SEdge[], [], { equals: false });
  const single = createMemo(() => (nodes().length === 1 ? nodes()[0] : null), null, { equals: false });
  const edge = createMemo(() => (edges().length === 1 && !nodes().length ? edges()[0] : null), null, { equals: false });
  // floors of the selection's page (boxes can't move to another page: pages are independent)
  const layers = createMemo(() => {
    props.ver();
    const first = nodes()[0];
    return pageLayers(store.scene, first ? pageOfLayer(store.scene, first.layer) : store.activePage).reverse();
  }, [], { equals: false });

  const setN = <K extends keyof SNode>(field: K, value: SNode[K], coalesce = true) =>
    store.update((s) => {
      for (const n of nodes()) if (s.nodes[n.id]) s.nodes[n.id][field] = value;
    }, coalesce ? `n:${String(field)}:${sel().join()}` : true);
  const setE = <K extends keyof SEdge>(field: K, value: SEdge[K]) =>
    store.update((s) => { const e = edge(); if (e && s.edges[e.id]) s.edges[e.id][field] = value; }, `e:${String(field)}:${edge()?.id}`);
  const num = (v: string, min = 0) => Math.max(min, Number(v) || 0);

  return (
    <Show when={nodes().length || edges().length}>
      <aside class="inspector panel">
        <Show when={single()}>
          {(_) => { const n = () => single()!; return (
            <>
              <h3><span class="dot" style={{ background: n().color }} />{KINDS[n().kind].name}</h3>
              <label>Label<input value={n().label} onInput={(e) => setN('label', e.currentTarget.value)} /></label>
              <Show when={n().kind !== 'text' && n().kind !== 'zone'}>
                <label>Type
                  <select value={n().kind} onChange={(e) => {
                    const k = e.currentTarget.value as NodeKind;
                    const old = KINDS[n().kind], d = KINDS[k];
                    store.update((s) => {
                      const m = s.nodes[n().id];
                      m.kind = k;
                      if (m.color === old.color) m.color = d.color;
                      if (m.capacity === old.capacity) m.capacity = d.capacity;
                      if (m.latency === old.latency) m.latency = d.latency;
                    });
                  }}>
                    <For each={(['service', 'database', 'queue', 'cache', 'lb', 'client'] as NodeKind[])}>{(k) => <option value={k}>{KINDS[k].name}</option>}</For>
                  </select>
                </label>
              </Show>
              <label>Layer
                <select value={n().layer} onChange={(e) => { setN('layer', e.currentTarget.value, false); store.setActiveLayer(e.currentTarget.value); }}>
                  <For each={layers()}>{(l) => <option value={l.id}>{l.name}</option>}</For>
                </select>
              </label>
              <div class="field">Color<Swatches value={n().color} set={(c) => setN('color', c)} /></div>
              <Show when={n().kind !== 'text'}>
                <div class="row2">
                  <label>Width<input type="number" value={Math.round(n().w)} onInput={(e) => setN('w', num(e.currentTarget.value, 20))} /></label>
                  <label>Depth<input type="number" value={Math.round(n().h)} onInput={(e) => setN('h', num(e.currentTarget.value, 20))} /></label>
                </div>
              </Show>
              <Show when={n().kind !== 'text' && n().kind !== 'zone'}>
                <label>Height (3D) <span class="val">{n().height}</span>
                  <input type="range" min="2" max="400" value={n().height} onInput={(e) => setN('height', +e.currentTarget.value)} />
                </label>
              </Show>
              <Show when={SIM_KINDS.has(n().kind)}>
                <h4>Simulation</h4>
                <div class="row2">
                  <label>{n().kind === 'client' ? 'Traffic rps' : n().kind === 'queue' ? 'Drain rps' : 'Capacity rps'}
                    <input type="number" value={n().capacity} onInput={(e) => setN('capacity', num(e.currentTarget.value))} />
                  </label>
                  <label>Latency ms<input type="number" value={n().latency} onInput={(e) => setN('latency', num(e.currentTarget.value))} /></label>
                </div>
                <button class="btn" classList={{ danger: !n().down }} onClick={props.toggleDown}>
                  <Icon name="skull" size={16} /> {n().down ? 'Revive node' : 'Kill node'}
                </button>
                <Show when={props.simOn() && props.stats()?.nodes.get(n().id)}>
                  {(st) => (
                    <div class="stats">
                      <div><b>{fmt(st().inRps)}</b><span>rps in</span></div>
                      <Show when={n().kind !== 'client'}><div><b>{Math.round(st().util * 100)}%</b><span>util</span></div></Show>
                      <div><b>{Math.round(st().lat)}ms</b><span>latency</span></div>
                      <div><b>{(st().err * 100).toFixed(1)}%</b><span>errors</span></div>
                    </div>
                  )}
                </Show>
              </Show>
            </>
          ); }}
        </Show>

        <Show when={nodes().length > 1}>
          <h3>{nodes().length} nodes</h3>
          <div class="field">Color<Swatches set={(c) => setN('color', c)} /></div>
          <label>Move to layer
            <select value="" onChange={(e) => { setN('layer', e.currentTarget.value, false); store.setActiveLayer(e.currentTarget.value); }}>
              <option value="" disabled>Choose…</option>
              <For each={layers()}>{(l) => <option value={l.id}>{l.name}</option>}</For>
            </select>
          </label>
          <label>Height (3D)
            <input type="range" min="2" max="400" value={nodes()[0].height} onInput={(e) => setN('height', +e.currentTarget.value)} />
          </label>
        </Show>

        <Show when={edge()}>
          {(_) => { const e = () => edge()!; return (
            <>
              <h3>Connection</h3>
              <p class="muted">{store.scene.nodes[e().from]?.label} → {store.scene.nodes[e().to]?.label}</p>
              <label>Label<input value={e().label} onInput={(ev) => setE('label', ev.currentTarget.value)} /></label>
              <label>Calls per request<input type="number" step="0.1" min="0" value={e().mult} onInput={(ev) => setE('mult', num(ev.currentTarget.value))} /></label>
              <label class="check"><input type="checkbox" checked={e().dashed} onChange={(ev) => setE('dashed', ev.currentTarget.checked)} /> Dashed (async)</label>
              <label class="check"><input type="checkbox" checked={e().flow} onChange={(ev) => setE('flow', ev.currentTarget.checked)} /> Animate flow</label>
              <button class="btn" onClick={() => store.update((s) => { const x = s.edges[e().id]; [x.from, x.to] = [x.to, x.from]; })}>Reverse direction</button>
            </>
          ); }}
        </Show>
        <button class="btn danger" onClick={() => store.deleteSelection()}><Icon name="trash" size={16} /> Delete</button>
      </aside>
    </Show>
  );
}
