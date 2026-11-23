import { Show } from 'solid-js';
import { store } from '../../shared/appStore';
import type { SimResult } from '../simulation/sim';
import { KINDS } from '../../shared/model/types';
import { fmt } from '../../shared/ui/format';

export function Tooltip(props: { h: { id: string; x: number; y: number }; stats: () => SimResult | null; simOn: () => boolean }) {
  const n = () => store.scene.nodes[props.h.id];
  const st = () => (props.simOn() ? props.stats()?.nodes.get(props.h.id) : undefined);
  return (
    <Show when={n()}>
      <div class="tooltip" style={{ left: `${props.h.x + 14}px`, top: `${props.h.y + 14}px` }}>
        <b>{n()!.label}</b> <span class="muted">{KINDS[n()!.kind].name}{n()!.down ? ' · DOWN' : ''}</span>
        <Show when={st()}>
          {(s) => (
            <div class="small">
              {fmt(s().inRps)} rps in · {fmt(s().rps)} handled
              <Show when={n()!.kind !== 'client'}> · {Math.round(s().util * 100)}% util</Show>
              <br />{Math.round(s().lat)}ms · {(s().err * 100).toFixed(1)}% errors
              <Show when={s().backlog > 1}> · {fmt(s().backlog)} queued</Show>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}
