import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../apps/web/src/lib/supabase-client', () => ({
  supabase: {
    auth: authMocks,
  },
}));

import { ApiError, callFunction } from '../apps/web/src/lib/supabase-api';

describe('callFunction error contract', () => {
  beforeEach(() => {
    authMocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    authMocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'access-token-1' } },
      error: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the Edge Function business message and validation fields on HTTP errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Données de paiement invalides',
          fields: { phone: ['Numéro invalide'] },
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const promise = callFunction('fedapay-init', { lease_id: 'lease-1' });

    await expect(promise).rejects.toMatchObject({
      status: 422,
      message: 'Données de paiement invalides',
      fields: { phone: ['Numéro invalide'] },
    });

    const error = await promise.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/functions/v1/fedapay-init'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer access-token-1' }),
      }),
    );
  });

  it('supports nested error payloads returned by Edge Functions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: 'Reversement refusé', details: 'Compte bénéficiaire invalide' },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(callFunction('landlord-payouts', {})).rejects.toMatchObject({
      status: 409,
      message: 'Reversement refusé',
    });
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Service indisponible', { status: 503 })),
    );

    await expect(callFunction('fedapay-init', {})).rejects.toMatchObject({
      status: 503,
      message: 'Erreur HTTP 503',
    });
  });
});
