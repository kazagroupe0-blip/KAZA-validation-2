import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, callFunction } from '../apps/web/src/lib/supabase-api';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../apps/web/src/lib/supabase-client', () => ({
  supabase: {
    auth: {
      getUser: mocks.getUser,
      getSession: mocks.getSession,
    },
  },
}));

vi.mock('../apps/web/src/lib/env', () => ({
  env: {
    supabaseUrl: 'https://supabase.example',
  },
}));

describe('callFunction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'access-token-1' } },
      error: null,
    });
  });

  it('preserves an Edge Function error payload and HTTP status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Montant invalide',
          code: 'PAYMENT_VALIDATION',
          details: 'Le montant doit être positif',
          hint: 'Vérifiez le montant envoyé',
          fields: { amount: ['Doit être supérieur à 0'] },
        }),
        {
          status: 422,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(callFunction('fedapay-init', { amount: 0 })).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      message: 'Montant invalide',
      code: 'PAYMENT_VALIDATION',
      details: 'Le montant doit être positif',
      hint: 'Vérifiez le montant envoyé',
      fields: { amount: ['Doit être supérieur à 0'] },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://supabase.example/functions/v1/fedapay-init',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token-1',
        }),
      }),
    );
  });

  it('keeps plain-text upstream errors instead of replacing them with only HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response('Service Fedapay indisponible', { status: 503 })),
    );

    const promise = callFunction('fedapay-init', { amount: 1000 });
    await expect(promise).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      message: 'Service Fedapay indisponible',
    });
  });

  it('fails explicitly when an authenticated session has no access token', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });

    const promise = callFunction('fedapay-init', { amount: 1000 });
    await expect(promise).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      message: 'Session invalide — reconnectez-vous',
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('keeps an authentication error distinct from a missing user', async () => {
    const authError = new Error('Auth backend unavailable');
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: authError });

    const promise = callFunction('fedapay-init', { amount: 1000 });
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({
      status: 400,
      message: 'Auth backend unavailable',
    });
  });
});
