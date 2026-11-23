// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolDef } from './tools';
import { registerWebMCP, selfTestWebMCP } from './webmcp';

const tool = (name: string, extra: Partial<ToolDef> = {}): ToolDef => ({
  name,
  title: name.toUpperCase(),
  description: `does ${name}`,
  inputSchema: { type: 'object', properties: {} },
  execute: vi.fn(async (input: unknown) => JSON.stringify({ name, input })),
  ...extra,
});

const TOOLS = [tool('modeling8d_get_scene', { annotations: { readOnlyHint: true } }), tool('modeling8d_connect')];
const loadTools = () => vi.fn(async () => TOOLS);

function install(where: 'document' | 'navigator', mc: unknown) {
  Object.defineProperty(where === 'document' ? document : navigator, 'modelContext', { value: mc, configurable: true, writable: true });
}

afterEach(() => {
  delete (document as any).modelContext;
  delete (navigator as any).modelContext;
  document.head.querySelectorAll('meta[http-equiv="origin-trial"]').forEach((m) => m.remove());
  vi.unstubAllEnvs();
});

describe('registerWebMCP', () => {
  it('is a no-op without a model context and never loads the tools', async () => {
    const load = loadTools();
    const { status, unregister } = await registerWebMCP(load);
    expect(status).toEqual({ supported: false, via: null, method: null, registered: 0 });
    expect(load).not.toHaveBeenCalled();
    expect(() => unregister()).not.toThrow();
  });

  it('injects the origin-trial token once, before feature detection', async () => {
    vi.stubEnv('VITE_WEBMCP_OT_TOKEN', 'tok123');
    await registerWebMCP(loadTools());
    await registerWebMCP(loadTools());
    const metas = document.head.querySelectorAll('meta[http-equiv="origin-trial"]');
    expect(metas).toHaveLength(1);
    expect((metas[0] as HTMLMetaElement).content).toBe('tok123');
  });

  it('injects nothing without a token', async () => {
    vi.stubEnv('VITE_WEBMCP_OT_TOKEN', '');
    await registerWebMCP(loadTools());
    expect(document.head.querySelectorAll('meta[http-equiv="origin-trial"]')).toHaveLength(0);
  });

  it('registers via document.modelContext.registerTool(tool, { signal }) and unregisters by aborting', async () => {
    const registered: { tool: any; signal: AbortSignal }[] = [];
    const mc = { registerTool: vi.fn(async (t: any, opts: { signal: AbortSignal }) => { registered.push({ tool: t, signal: opts.signal }); }) };
    install('document', mc);
    install('navigator', { registerTool: vi.fn() }); // document wins
    const { status, unregister } = await registerWebMCP(loadTools());
    expect(status).toEqual({ supported: true, via: 'document.modelContext', method: 'registerTool', registered: 2 });
    expect(registered.map((r) => r.tool.name)).toEqual(['modeling8d_get_scene', 'modeling8d_connect']);

    const [first, second] = registered.map((r) => r.tool);
    expect(first).toMatchObject({ title: 'MODELING8D_GET_SCENE', description: 'does modeling8d_get_scene', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } });
    expect(second).not.toHaveProperty('annotations');
    // the browser passes (input, client); only input reaches our tool
    expect(JSON.parse(await second.execute({ a: 1 }, { signal: 'x' }))).toEqual({ name: 'modeling8d_connect', input: { a: 1 } });
    expect(TOOLS[1].execute).toHaveBeenCalledWith({ a: 1 });

    expect(registered[0].signal.aborted).toBe(false);
    unregister();
    expect(registered.every((r) => r.signal.aborted)).toBe(true);
  });

  it('falls back to single-argument registerTool and replaces already registered tools (older drafts)', async () => {
    const calls: unknown[][] = [];
    const mc = {
      registerTool: vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        if (args.length > 1) throw new Error('already registered');
      }),
      unregisterTool: vi.fn((name: string) => { if (name === 'modeling8d_connect') throw new Error('not registered'); }),
    };
    install('navigator', mc);
    const { status, unregister } = await registerWebMCP(loadTools());
    expect(status).toEqual({ supported: true, via: 'navigator.modelContext', method: 'registerTool', registered: 2 });
    expect(calls.map((a) => a.length)).toEqual([2, 1, 2, 1]);
    expect(mc.unregisterTool.mock.calls.map((c) => c[0])).toEqual(['modeling8d_get_scene', 'modeling8d_connect']);

    mc.unregisterTool.mockClear();
    unregister(); // a throwing unregisterTool is swallowed
    expect(mc.unregisterTool.mock.calls.map((c) => c[0])).toEqual(['modeling8d_get_scene', 'modeling8d_connect']);
  });

  it('retries without unregisterTool and reports a failure that persists', async () => {
    const mc = { registerTool: vi.fn(async () => { throw new Error('bad tool'); }) };
    install('document', mc);
    const { status, unregister } = await registerWebMCP(loadTools());
    expect(mc.registerTool).toHaveBeenCalledTimes(2);
    expect(status).toEqual({ supported: true, via: 'document.modelContext', method: 'registerTool', registered: 0, error: 'bad tool' });
    expect(() => unregister()).not.toThrow();
  });

  it('uses provideContext({ tools }) and clears the context on unregister', async () => {
    const mc = { provideContext: vi.fn(async () => {}), clearContext: vi.fn() };
    install('document', mc);
    const { status, unregister } = await registerWebMCP(loadTools());
    expect(status).toEqual({ supported: true, via: 'document.modelContext', method: 'provideContext', registered: 2 });
    const provided = (mc.provideContext.mock.calls[0] as any[])[0].tools;
    expect(provided.map((t: any) => t.name)).toEqual(['modeling8d_get_scene', 'modeling8d_connect']);
    unregister();
    expect(mc.clearContext).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing clearContext and tolerates its absence', async () => {
    const throwing = { provideContext: vi.fn(), clearContext: vi.fn(() => { throw new Error('gone'); }) };
    install('document', throwing);
    const a = await registerWebMCP(loadTools());
    expect(() => a.unregister()).not.toThrow();
    expect(throwing.clearContext).toHaveBeenCalled();

    install('document', { provideContext: vi.fn() });
    const b = await registerWebMCP(loadTools());
    expect(() => b.unregister()).not.toThrow();
  });

  it('reports a non-Error rejection from provideContext', async () => {
    const mc = { provideContext: vi.fn(() => Promise.reject('nope')), clearContext: vi.fn() };
    install('document', mc);
    const { status, unregister } = await registerWebMCP(loadTools());
    expect(status).toMatchObject({ method: 'provideContext', registered: 0, error: 'nope' });
    unregister();
    expect(mc.clearContext).toHaveBeenCalled();
  });

  it('marks an unknown modelContext shape as unsupported', async () => {
    install('document', { somethingElse: true });
    const { status, unregister } = await registerWebMCP(loadTools());
    expect(status).toEqual({
      supported: false, via: 'document.modelContext', method: null, registered: 0,
      error: 'modelContext found but no known registration method',
    });
    expect(() => unregister()).not.toThrow();
  });
});

describe('selfTestWebMCP', () => {
  const probe = { name: 'modeling8d_get_scene' };

  it('reports when WebMCP is unavailable', async () => {
    expect(await selfTestWebMCP()).toEqual({ ok: false, message: 'WebMCP is not available in this browser.' });
  });

  it('passes without testing when getTools or executeTool is missing', async () => {
    const msg = 'Tools registered (this browser version has no getTools/executeTool to test with).';
    install('document', { executeTool: vi.fn() });
    expect(await selfTestWebMCP()).toEqual({ ok: true, message: msg });
    install('document', { getTools: vi.fn() });
    expect(await selfTestWebMCP()).toEqual({ ok: true, message: msg });
  });

  it('fails when none of our tools are listed', async () => {
    install('navigator', { getTools: async () => [{ name: 'other_tool' }], executeTool: vi.fn() });
    expect(await selfTestWebMCP()).toEqual({ ok: false, message: 'The browser lists 1 tools, none from 8D modeling.' });
  });

  it('fails when get_scene is not listed', async () => {
    install('document', { getTools: async () => [{ name: 'modeling8d_connect' }], executeTool: vi.fn() });
    expect(await selfTestWebMCP()).toEqual({ ok: false, message: 'modeling8d_get_scene is not listed by the browser.' });
  });

  it('executes get_scene through the browser and parses a JSON string answer', async () => {
    const executeTool = vi.fn(async () => JSON.stringify({ nodes: [{}, {}, {}] }));
    install('document', { getTools: async () => [probe, { name: 'modeling8d_connect' }, { name: 'x' }], executeTool });
    expect(await selfTestWebMCP()).toEqual({ ok: true, message: 'WebMCP OK: browser lists 2 8D modeling tools; test call read 3 nodes.' });
    expect(executeTool).toHaveBeenCalledWith(probe);
  });

  it('accepts an already parsed answer', async () => {
    install('document', { getTools: async () => [probe], executeTool: async () => ({ nodes: [] }) });
    expect(await selfTestWebMCP()).toEqual({ ok: true, message: 'WebMCP OK: browser lists 1 8D modeling tools; test call read 0 nodes.' });
  });

  it('flags an unexpected answer', async () => {
    const unexpected = { ok: false, message: 'Test call returned an unexpected result.' };
    install('document', { getTools: async () => [probe], executeTool: async () => ({ nodes: 'many' }) });
    expect(await selfTestWebMCP()).toEqual(unexpected);
    install('document', { getTools: async () => [probe], executeTool: async () => null });
    expect(await selfTestWebMCP()).toEqual(unexpected);
  });

  it('reports thrown errors and non-Error rejections', async () => {
    install('document', { getTools: async () => [probe], executeTool: async () => 'not json' });
    expect((await selfTestWebMCP()).message).toMatch(/^WebMCP test failed: .*JSON/);
    install('document', { getTools: () => Promise.reject('denied'), executeTool: vi.fn() });
    expect(await selfTestWebMCP()).toEqual({ ok: false, message: 'WebMCP test failed: denied' });
  });
});
