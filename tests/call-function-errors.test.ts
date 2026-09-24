import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { ApiError, callFunction } from '../apps/web/src/lib/supabase-api';

describe('callFunction error contract', () => {
  beforeEach(() => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    });
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'test-access-token' } },
    });
    vi.restoreAllMocks();
  });

  it('preserves HTTP status and server error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        error: 'Paiement déjà traité',
        code: 'PAYMENT_ALREADY_CONFIRMED',
      }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    await expect(callFunction('confirm-payment', { paymentId: 'p1' }))
      .rejects.toEqual(expect.objectContaining({
        status: 409,
        message: 'Paiement déjà traité',
      }));
  });

  it('falls back to a useful HTTP error when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('upstream failure', {
        status: 502,
      }),
    ));

    await expect(callFunction('payment-webhook', {}))
      .rejects.toEqual(expect.objectContaining({
        status: 502,
        message: 'La fonction payment-webhook a échoué (HTTP 502)',
      }));
  });

  it('does not retry a non-retryable business error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Accès refusé' }), { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(callFunction('admin-action', {})).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
