import { Icon } from '../../shared/ui/icons';

const REPO_URL = 'https://github.com/AleB93/8d-modeling';
const AUTHOR_URL = 'https://github.com/AleB93';

export function About(props: { close: () => void }) {
  return (
    <div class="overlay" onClick={props.close}>
      <div class="about panel" role="dialog" aria-label="About 8D modeling" onClick={(e) => e.stopPropagation()}>
        <h3><span class="about-title"><Icon name="layers" size={20} /> 8D modeling</span> <button class="icon sm" title="Close" onClick={props.close}><Icon name="close" size={16} /></button></h3>
        <p class="lead">Draw your system architecture in 2D, then press <kbd>Tab</kbd> and watch it rise into 3D, where you can run traffic through it.</p>
        <ul>
          <li><b>Design</b>: a fast 2D editor with layers as floors, snapping and undo.</li>
          <li><b>Play 3D</b>: flows, a traffic simulation with capacity, failover and cascading errors, and guided camera tours.</li>
          <li><b>Journeys</b>: record user paths such as login or checkout and replay them step by step.</li>
          <li><b>Share</b>: the whole diagram fits in a link or a standalone HTML file. No server, no account: everything stays in your browser.</li>
          <li><b>AI agents</b>: tools exposed through WebMCP let an in-browser agent build and analyze diagrams.</li>
        </ul>
        <h4>Contact</h4>
        <p>Made by <b>AleB93</b>. Questions, ideas or bugs? Reach me on GitHub.</p>
        <div class="about-links">
          <a class="btn" href={AUTHOR_URL} target="_blank" rel="noopener noreferrer"><Icon name="github" size={16} /> github.com/AleB93</a>
          <a class="btn" href={`${REPO_URL}/issues`} target="_blank" rel="noopener noreferrer"><Icon name="info" size={16} /> Open an issue</a>
        </div>
        <p class="fine">Open source under the <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">MIT License</a> · © 2026 AleB93</p>
      </div>
    </div>
  );
}
