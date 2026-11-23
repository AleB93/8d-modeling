import { expect, it } from 'vitest';
import { store } from './appStore';
import { Store } from './model/store';

it('exports one shared Store instance', async () => {
  expect(store).toBeInstanceOf(Store);
  expect((await import('./appStore')).store).toBe(store);
});
