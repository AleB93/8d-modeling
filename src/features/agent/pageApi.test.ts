import { describe, expect, it, vi } from 'vitest';
import { API_VERSION, createPageApi, installPageApi } from './pageApi';
import type { ToolDef } from './tools';

const tool = (name: string, execute: ToolDef['execute'], readOnly?: boolean): ToolDef => ({
  name, title: name.toUpperCase(), description: `does ${name}`, inputSchema: { type: 'object' },
  ...(readOnly === undefined ? {} : { annotations: { readOnlyHint: readOnly } }), execute,
});

function setup() {
  const echo = vi.fn(async (input: unknown) => JSON.stringify({ got: input }));
  const tools = [
    tool('modeling8d_echo', echo, true),
    tool('modeling8d_fail', async () => { throw new Error('No layer "x"'); }, false),
    tool('modeling8d_weird', async () => { throw 'plain string'; }),
  ];
  const load = vi.fn(async () => tools);
  return { api: createPageApi(load, 'https://example.test/llms.txt'), load, echo };
}

describe('createPageApi', () => {
  it('exposes version and docs without loading the tools', () => {
    const { api, load } = setup();
    expect(api.version).toBe(API_VERSION);
    expect(api.docs).toBe('https://example.test/llms.txt');
    expect(load).not.toHaveBeenCalled();
  });

  it('calls tools by full or short name and parses the JSON result', async () => {
    const { api, echo } = setup();
    expect(await api.call('modeling8d_echo', { a: 1 })).toEqual({ got: { a: 1 } });
    expect(await api.call('echo')).toEqual({ got: {} }); // input defaults to {}
    expect(echo).toHaveBeenCalledTimes(2);
  });

  it('loads the tools once, lazily', async () => {
    const { api, load } = setup();
    await api.call('echo');
    await api.list();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('returns { error } instead of throwing', async () => {
    const { api } = setup();
    expect(await api.call('fail')).toEqual({ error: 'No layer "x"' });
    expect(await api.call('weird')).toEqual({ error: 'plain string' });
    expect(await api.call('nope')).toEqual({ error: expect.stringMatching(/^Unknown tool "nope". Available: modeling8d_echo, /) });
  });

  it('batch() forwards the calls to the batch tool', async () => {
    const batch = vi.fn(async (input: unknown) => JSON.stringify({ got: input }));
    const api = createPageApi(async () => [tool('modeling8d_batch', batch)], 'docs');
    expect(await api.batch([{ tool: 'get_scene' }])).toEqual({ got: { calls: [{ tool: 'get_scene' }] } });
  });

  it('offers tools.<name>() for any name', async () => {
    const { api } = setup();
    expect(await api.tools.modeling8d_echo({ b: 2 })).toEqual({ got: { b: 2 } });
    expect(await api.tools.echo()).toEqual({ got: {} });
    expect((api.tools as any)[Symbol.iterator]).toBeUndefined();
  });

  it('lists tools with their schema and read-only flag', async () => {
    const { api } = setup();
    expect(await api.list()).toEqual([
      { name: 'modeling8d_echo', title: 'MODELING8D_ECHO', description: 'does modeling8d_echo', readOnly: true, inputSchema: { type: 'object' } },
      expect.objectContaining({ name: 'modeling8d_fail', readOnly: false }),
      expect.objectContaining({ name: 'modeling8d_weird', readOnly: false }),
    ]);
  });

  it('help() explains usage and includes every tool', async () => {
    const h = await setup().api.help();
    expect(h.docs).toBe('https://example.test/llms.txt');
    expect(h.usage.join(' ')).toContain('get_scene');
    expect(h.tools.map((t) => t.name)).toHaveLength(3);
  });
});

describe('installPageApi', () => {
  it('puts the API on the target as a non-enumerable property', async () => {
    const target = {} as { modeling8d?: unknown };
    const api = installPageApi(async () => [tool('modeling8d_echo', async () => '1')], 'docs', target);
    expect(target.modeling8d).toBe(api);
    expect(Object.keys(target)).toEqual([]);
    expect(await api.call('echo')).toBe(1);
  });

  it('defaults to window', () => {
    vi.stubGlobal('window', {});
    const api = installPageApi(async () => [], 'docs');
    expect((window as any).modeling8d).toBe(api);
    vi.unstubAllGlobals();
  });
});
