import { createMemo, For, Show } from 'solid-js';
import { Icon } from '../../shared/ui/icons';
import { store } from '../../shared/appStore';
import { sceneOutline } from './outline';

/**
 * The diagram as a structured list, visually hidden but present in the accessibility tree, so screen
 * readers and page-reading agents (e.g. Claude in Chrome) can see what the canvas shows. Buttons select
 * a box or show a journey. It is shown as a panel when `open` (Menu → Diagram list, or O), so agents that
 * click by screen position can use it, and while it has keyboard focus.
 */
export function SceneOutline(props: {
  ver: () => number;
  open: boolean;
  close: () => void;
  focus: (nodeId: string) => void;
  showJourney: (id: string) => void;
}) {
  const o = createMemo(() => (props.ver(), sceneOutline(store.scene)));
  return (
    <nav class="sr-outline" classList={{ open: props.open }} aria-label="Diagram outline">
      <h2>
        Diagram outline
        <Show when={props.open}>
          <button type="button" class="icon sm" title="Close (Esc)" onClick={props.close}><Icon name="close" size={16} /></button>
        </Show>
      </h2>
      <p>
        {o().summary} Press O (or Menu → Diagram list) to show this list on screen and click its buttons.
        Agents can also edit the diagram with JavaScript through window.modeling8d (see llms.txt).
      </p>
      <For each={o().floors}>
        {(f) => (
          <section aria-label={f.text}>
            <h3>{f.text}</h3>
            <ul>
              <For each={f.nodes}>
                {(n) => (
                  <li>
                    <button type="button" onClick={() => props.focus(n.id)}>{n.text}</button>
                    <Show when={n.links.length}>
                      <ul aria-label={`Connections from ${n.text}`}>
                        <For each={n.links}>{(l) => <li>{l.text}</li>}</For>
                      </ul>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </section>
        )}
      </For>
      <Show when={o().journeys.length}>
        <section aria-label="Journeys">
          <h3>Journeys</h3>
          <ul>
            <For each={o().journeys}>
              {(j) => (
                <li>
                  <button type="button" onClick={() => props.showJourney(j.id)}>Show journey {j.text}</button>
                  <ol>
                    <For each={j.steps}>{(st) => <li>{st}</li>}</For>
                  </ol>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
    </nav>
  );
}
