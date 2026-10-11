import { describe, expect, it } from 'vitest';
import { resolveAdminSecretKey } from '../supabase/functions/_shared/admin-key';

const env = (values: Record<string, string>) => ({ get: (name: string) => values[name] });

describe('resolveAdminSecretKey', () => {
  it('uses the default entry of SUPABASE_SECRET_KEYS', () => {
    const key = resolveAdminSecretKey(
      env({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'dict-key', other: 'x' }) }),
    );
    expect(key).toBe('dict-key');
  });

  it('prefers the dictionary over the legacy variable', () => {
    const key = resolveAdminSecretKey(
      env({
        SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'dict-key' }),
        SUPABASE_SERVICE_ROLE_KEY: 'legacy-key',
      }),
    );
    expect(key).toBe('dict-key');
  });

  it('falls back to SUPABASE_SERVICE_ROLE_KEY when the dictionary is absent or blank', () => {
    expect(resolveAdminSecretKey(env({ SUPABASE_SERVICE_ROLE_KEY: 'legacy-key' }))).toBe('legacy-key');
    expect(
      resolveAdminSecretKey(env({ SUPABASE_SECRET_KEYS: '  ', SUPABASE_SERVICE_ROLE_KEY: 'legacy-key' })),
    ).toBe('legacy-key');
  });

  it('falls back when the dictionary has no usable default entry', () => {
    for (const dict of ['{}', '{"default":""}', '{"default":42}', '[]', 'null']) {
      expect(
        resolveAdminSecretKey(env({ SUPABASE_SECRET_KEYS: dict, SUPABASE_SERVICE_ROLE_KEY: 'legacy-key' })),
      ).toBe('legacy-key');
    }
  });

  it('does not hide a malformed dictionary behind the legacy fallback', () => {
    expect(() =>
      resolveAdminSecretKey(env({ SUPABASE_SECRET_KEYS: '{not json', SUPABASE_SERVICE_ROLE_KEY: 'legacy-key' })),
    ).toThrow('JSON invalide');
  });

  it('throws when nothing usable is configured, without echoing key values', () => {
    expect(() => resolveAdminSecretKey(env({ SUPABASE_SECRET_KEYS: '{"default":"  "}' }))).toThrow(
      /SUPABASE_SECRET_KEYS/,
    );
    expect(() => resolveAdminSecretKey(env({}))).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('does not treat a key prefix as proof of validity', () => {
    expect(resolveAdminSecretKey(env({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_x"}' }))).toBe('sb_secret_x');
    expect(resolveAdminSecretKey(env({ SUPABASE_SECRET_KEYS: '{"default":"legacy-jwt-like"}' }))).toBe(
      'legacy-jwt-like',
    );
  });
});
