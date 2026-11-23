import { For } from 'solid-js';
import { Icon } from '../../shared/ui/icons';

export function Help(props: { close: () => void }) {
  const rows: [string, string][] = [
    ['Tab', 'Switch Design ↔ Play 3D'],
    ['V H A', 'Select · pan · connect'],
    ['S D Q K L C Z T', 'Service · database · queue · cache · LB · client · zone · text'],
    ['Drag / click', 'Draw a shape / drop default size'],
    ['Double-click', 'Edit label (empty canvas: new text)'],
    ['Mouse wheel · pinch', 'Zoom at cursor (trackpad two-finger scroll or Space + drag: pan)'],
    ['Shift+1', 'Fit to content'],
    ['O', 'Diagram list: the whole diagram as a clickable list'],
    ['Alt while dragging', 'Disable snapping'],
    ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
    ['Ctrl+C / V / D', 'Copy · paste · duplicate'],
    ['Arrows (+Shift)', 'Nudge 1px (10px)'],
    ['— Play 3D —', ''],
    ['F · M', 'Toggle flows · simulation'],
    ['X', 'Kill / revive selected node'],
    ['Alt + drag node', 'Change its height'],
    ['1–9 · P', 'Jump to stop · present tour (←/→, Esc)'],
    ['Shift+1', 'Overview: reset camera to show everything'],
    ['— Journeys —', ''],
    ['Journeys panel ▸ +', 'New journey: click boxes in order to record it'],
    ['[ · ]', 'Previous / next step of the shown journey'],
    ['Esc', 'Finish recording · hide the journey'],
  ];
  return (
    <div class="overlay" onClick={props.close}>
      <div class="help panel" onClick={(e) => e.stopPropagation()}>
        <h3>Keyboard shortcuts <button class="icon sm" onClick={props.close}><Icon name="close" size={16} /></button></h3>
        <table>
          <For each={rows}>{([k, v]) => <tr><td><kbd>{k}</kbd></td><td>{v}</td></tr>}</For>
        </table>
      </div>
    </div>
  );
}
