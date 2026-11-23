import type { SimResult } from './sim';
import { fmt } from '../../shared/ui/format';

export function SimPanel(props: { stats: () => SimResult | null; mult: () => number; setMult: (v: number) => void }) {
  const t = () => props.stats()?.total;
  const errCls = () => ((t()?.err ?? 0) > 0.05 ? 'bad' : (t()?.err ?? 0) > 0.005 ? 'warn' : 'ok');
  return (
    <div class="simpanel panel">
      <div class="stats">
        <div><b>{fmt(t()?.rps ?? 0)}</b><span>req/s</span></div>
        <div class={errCls()}><b>{((t()?.err ?? 0) * 100).toFixed(1)}%</b><span>errors</span></div>
        <div><b>{Math.round(t()?.lat ?? 0)}ms</b><span>avg latency</span></div>
      </div>
      <label>Traffic ×{props.mult().toFixed(1)}
        <input type="range" min="-2.3" max="2.3" step="0.01" value={Math.log(props.mult())}
          onInput={(e) => props.setMult(Math.round(Math.exp(+e.currentTarget.value) * 10) / 10)} />
      </label>
      <p class="muted small">Select a node and press <b>X</b> to kill it; watch failures propagate. Queues absorb bursts.</p>
    </div>
  );
}
