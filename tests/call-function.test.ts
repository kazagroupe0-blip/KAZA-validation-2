import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../apps/web/src/lib/supabase-client', () => ({
  supabase: {
    auth: authMock,
  },
}));

vi.mock('../apps/web/src/lib/env', () => ({
  env: {
    supabaseUrl: 'https://example.supabase.co',
  },
}));

import { ApiError, callFunction } from '../apps/web/src/lib/supabase-api';

describe('callFunction', () => {
  beforeEach(() => {
    vi.useRealTimers();
    authMock.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    authMock.getSession.mockResolvedValue({
      data: { session: { access_token: 'access-token' } },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves HTTP status, server message and validation fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Le paiement FedaPay est déjà confirmé.',
          fields: { payment: ['État invalide'] },
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const promise = callFunction('fedapay-init', { paymentId: 'payment-1' });

    await expect(promise).rejects.toMatchObject({
      status: 422,
      message: 'Le paiement FedaPay est déjà confirmé.',
      fields: { payment: ['État invalide'] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the server message after retryable failures are exhausted', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Fournisseur de paiement indisponible.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const promise = callFunction('fedapay-init', { paymentId: 'payment-1' });
    await vi.advanceTimersByTimeAsync(1500);

    await expect(promise).rejects.toMatchObject({
      status: 500,
      message: 'Fournisseur de paiement indisponible.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns the JSON payload on successful responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ payment_url: 'https://example.test/checkout' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(callFunction<{ payment_url: string }>('fedapay-init', { paymentId: 'payment-1' }))
      .resolves.toEqual({ payment_url: 'https://example.test/checkout' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.supabase.co/functions/v1/fedapay-init',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ paymentId: 'payment-1' }),
      }),
    );
  });

  it('fails before calling the function when the session is invalid', async () => {
    authMock.getUser.mockResolvedValue({
      data: { user: null },
      error: new Error('JWT expired'),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(callFunction('fedapay-init', {})).rejects.toMatchObject({
      status: 401,
      message: 'Session invalide — reconnectez-vous',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
