import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({
  auth: {
    getUser: vi.fn(),
    getSession: vi.fn(),
  },
}));

vi.mock('../apps/web/src/lib/supabase-client', () => ({
  supabase: supabaseMock,
}));

vi.mock('../apps/web/src/lib/env', () => ({
  env: {
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'anon-key',
  },
}));

import { ApiError, callFunction } from '../apps/web/src/lib/supabase-api';

describe('callFunction error contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    supabaseMock.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    });
    supabaseMock.auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'access-token' } },
    });
  });

  it('preserves HTTP status and server error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Numéro Mobile Money invalide' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(callFunction('fedapay-init', {})).rejects.toMatchObject({
      status: 422,
      message: 'Numéro Mobile Money invalide',
    });
  });

  it('preserves field-level validation errors from the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            message: 'Validation impossible',
            fields: {
              phone: ['Format béninois requis'],
              months: ['Valeur maximale dépassée'],
            },
          }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );

    try {
      await callFunction('fedapay-init', {});
      throw new Error('Expected callFunction to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status: 400,
        message: 'Validation impossible',
      });
      expect((error as ApiError).fields).toEqual({
        phone: ['Format béninois requis'],
        months: ['Valeur maximale dépassée'],
      });
    }
  });

  it('falls back to the HTTP status when the response body has no useful message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: null }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(callFunction('account-purge', {})).rejects.toMatchObject({
      status: 400,
      message: 'Erreur HTTP 400',
    });
  });
});
