import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireUserMock = vi.hoisted(() => vi.fn());

vi.mock('../apps/web/src/lib/require-user', () => ({
  requireUser: requireUserMock,
}));

vi.mock('../apps/web/src/lib/supabase-client', () => ({
  supabase: {},
}));

import { confirmPayment } from '../apps/web/src/lib/api/payments';

describe('confirmPayment authentication contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('propagates authentication failure instead of silently succeeding', async () => {
    const error = new Error('Connectez-vous pour effectuer cette action');
    requireUserMock.mockRejectedValueOnce(error);

    await expect(confirmPayment('payment-1')).rejects.toThrow(
      'Connectez-vous pour effectuer cette action',
    );
  });
});
