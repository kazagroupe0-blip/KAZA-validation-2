import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  from: vi.fn(),
}));

vi.mock('../apps/web/src/lib/require-user', () => ({
  requireUser: mocks.requireUser,
}));

vi.mock('../apps/web/src/lib/supabase-client', () => ({
  supabase: {
    from: mocks.from,
  },
}));

import { confirmPayment } from '../apps/web/src/lib/api/payments';

describe('confirmPayment authentication contract', () => {
  beforeEach(() => {
    mocks.requireUser.mockReset();
    mocks.from.mockReset();
  });

  it('propagates authentication failure instead of reporting success', async () => {
    const error = new Error('Session expirée');
    mocks.requireUser.mockRejectedValue(error);

    await expect(confirmPayment('payment-1')).rejects.toBe(error);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
