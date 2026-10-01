import { describe, it, expect } from 'vitest';
import { resolveAuthIdentifier } from '../apps/web/src/lib/auth-identifier';

describe('resolveAuthIdentifier', () => {
  it('normalizes a local Benin phone number', () => {
    expect(resolveAuthIdentifier('01 00 00 00 00')).toEqual({
      type: 'phone',
      value: '+2290100000000',
    });
  });

  it('normalizes a canonical Benin phone number with spaces', () => {
    expect(resolveAuthIdentifier('+229 01 00 00 00 00')).toEqual({
      type: 'phone',
      value: '+2290100000000',
    });
  });

  it('canonicalizes email identifiers', () => {
    expect(resolveAuthIdentifier(' User@Example.COM ')).toEqual({
      type: 'email',
      value: 'user@example.com',
    });
  });

  it('rejects malformed identifiers', () => {
    expect(resolveAuthIdentifier('010000000')).toBeNull();
    expect(resolveAuthIdentifier('+225 01 00 00 00 00')).toBeNull();
    expect(resolveAuthIdentifier('not-an-email')).toBeNull();
    expect(resolveAuthIdentifier('')).toBeNull();
  });
});
