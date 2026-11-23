// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { installBrowserFakes } from '../test/browserFakes';
import { store } from '../shared/appStore';

// Smoke test: mount the real app (2D editor + every panel) and drive the main UI paths.
// Rendering itself (canvas pixels, WebGL) is out of scope; logic modules have their own unit tests.

let dispose: () => void;
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const byText = (sel: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(sel)].find((el) => el.textContent?.trim().includes(text));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => unknown, ms = 2000) => {
  for (const end = Date.now() + ms; !cond(); ) { if (Date.now() > end) throw new Error('timed out'); await tick(10); }
};

beforeAll(async () => {
  installBrowserFakes();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const root = document.createElement('div');
  document.body.append(root);
  const { default: App } = await import('./App');
  dispose = render(() => <App />, root);
  await until(() => Object.keys(store.scene.nodes).length > 0); // demo scene loaded (empty IndexedDB)
});
afterAll(() => dispose?.());

describe('App shell', () => {
  it('shows the brand, toolbar and feature panels', () => {
    expect($('.brand')?.textContent).toContain('8D modeling');
    expect(document.querySelectorAll('button[title*="(V)"], button[title*="(S)"]').length).toBe(2);
    expect(byText('.panel', 'Layers')).toBeTruthy();
    expect(byText('.panel', 'Journeys')).toBeTruthy();
  });

  it('opens and closes About from the logo, with GitHub-only contact', async () => {
    $('.brand')!.click();
    await tick();
    const about = $('.about[aria-label="About 8D modeling"]')!;
    expect(about.textContent).toContain('AleB93');
    expect(about.querySelector('a[href="https://github.com/AleB93"]')).toBeTruthy();
    expect(about.textContent).not.toMatch(/@/);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect($('.about[aria-label="About 8D modeling"]')).toBeNull();
  });

  it('toggles the shortcuts dialog with ?', async () => {
    const press = (key: string) => {
      const e = new KeyboardEvent('keydown', { key, bubbles: true });
      document.body.dispatchEvent(e);
    };
    press('?');
    await tick();
    expect(byText('h3', 'Keyboard shortcuts')).toBeTruthy();
    press('?');
    await tick();
    expect(byText('h3', 'Keyboard shortcuts')).toBeFalsy();
  });

  it('shows the WebMCP pill as off in a browser without WebMCP', () => {
    expect($('.agentpill')?.getAttribute('data-webmcp')).toBe('off');
  });

  it('shows the one-time WebMCP popup, and dismissing it is remembered', async () => {
    await until(() => $('.webmcp-hint'), 3000);
    byText('.webmcp-hint button', 'Got it')!.click();
    await tick();
    expect($('.webmcp-hint')).toBeNull();
    expect(localStorage.getItem('8dm.webmcpHintSeen')).toBe('1');
  });

  it('lists the demo journeys and plays one, showing the caption bar', async () => {
    const row = byText('.panel *', 'Place order')!;
    expect(row).toBeTruthy();
    row.click();
    await tick();
    expect(store.activeJourney?.name).toBe('Place order');
    expect($('.journeybar')?.textContent).toContain('Place order');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true }));
    await tick();
    expect(store.journey?.step).toBe(0); // the whole path was shown (-1); ] goes to the first step
    expect($('.journeybar')?.textContent).toMatch(/\d+\s*\/\s*9/);
  });

  it('switches layers to "All layers"', async () => {
    byText('.panel *', 'All layers')!.click();
    await tick();
    expect(store.allLayers).toBe(true);
  });

  it('shows the inspector for a selected node', async () => {
    const id = Object.values(store.scene.nodes).find((n) => n.kind === 'service')!.id;
    store.select([id]);
    await tick();
    expect($('.inspector')).toBeTruthy();
  });

  it('exposes the agent tools on window.modeling8d', async () => {
    const api = (window as any).modeling8d;
    expect(api.docs).toMatch(/llms\.txt$/);
    const scene = await api.call('get_scene');
    expect(scene.nodes.length).toBe(Object.keys(store.scene.nodes).length);
    expect(await api.call('nope')).toEqual({ error: expect.stringContaining('Unknown tool') });
  });

  it('mirrors the diagram in an accessible outline whose buttons select boxes', async () => {
    const nav = $('nav[aria-label="Diagram outline"]')!;
    expect(nav.textContent).toMatch(/Diagram with \d+ boxes/);
    const api = byText('nav[aria-label="Diagram outline"] button', 'API #1')!;
    api.click();
    await tick();
    expect(store.selectedNodes.map((n) => n.label)).toEqual(['API #1']);
    byText('nav[aria-label="Diagram outline"] button', 'Show journey Browse')!.click();
    await tick();
    expect(store.activeJourney?.name).toBe('Browse (mobile)');
  });

  it('shows the outline as a Diagram list panel with O, and hides it with Esc', async () => {
    const nav = $('nav[aria-label="Diagram outline"]')!;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true }));
    await tick();
    expect(nav.classList.contains('open')).toBe(true);
    nav.querySelector<HTMLButtonElement>('button[title="Close (Esc)"]')!.click();
    await tick();
    expect(nav.classList.contains('open')).toBe(false);
  });

  it('opens the menu and loads a new empty scene', async () => {
    $('button[title="Menu"]')!.click();
    await tick();
    byText('.menu button', 'New empty scene')!.click();
    await tick();
    expect(Object.keys(store.scene.nodes)).toHaveLength(0);
  });
});
