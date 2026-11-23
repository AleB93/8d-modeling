// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SHARE_DICT } from './shareDict';

describe('SHARE_DICT', () => {
  // #z= links depend on these exact bytes: any change breaks every link already shared.
  it('is frozen', async () => {
    expect(SHARE_DICT).toBeInstanceOf(Uint8Array);
    expect(SHARE_DICT.length).toBe(FROZEN_LENGTH);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', SHARE_DICT));
    expect(Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')).toBe(FROZEN_SHA256);
  });
});

const FROZEN_LENGTH = 634;
const FROZEN_SHA256 = '6c0b9a06a46233a8427d5753161b861e1adceabca95263d93c068099009c656a';
