import { expect, it } from 'vitest';
import guide from '../../../public/llms.txt?raw';
import { createTools, type AgentUI } from './tools';
import { Store } from '../../shared/model/store';

// public/llms.txt is the guide agents read; keep it in sync with the real tool list.
it('llms.txt documents every agent tool', () => {
  const tools = createTools(new Store(), {} as AgentUI);
  for (const t of tools) expect(guide, `missing ${t.name}`).toContain('`' + t.name.replace('modeling8d_', '') + '`');
  expect(guide).toContain('window.modeling8d');
});
