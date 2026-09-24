import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({
  from: vi.fn(),
}));

vi.mock('../apps/web/src/lib/supabase-client', () => ({
  supabase: supabaseMock,
}));

import {
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationsCount,
} from '../apps/web/src/lib/api/notifications';

function makeError(message = 'temporary failure') {
  return { code: 'PGRST000', message };
}

describe('notification API error contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not turn unread-count failures into a false zero', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      is: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockResolvedValueOnce({ count: null, error: makeError('count unavailable') }),
    };
    supabaseMock.from.mockReturnValue(chain);

    await expect(unreadNotificationsCount()).rejects.toThrow('count unavailable');
  });

  it('propagates mark-all failures', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      is: vi.fn().mockResolvedValue({ error: makeError('mark all failed') }),
    };
    supabaseMock.from.mockReturnValue(chain);

    await expect(markAllNotificationsRead()).rejects.toThrow('mark all failed');
  });

  it('propagates single-notification failures', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: makeError('mark one failed') }),
    };
    supabaseMock.from.mockReturnValue(chain);

    await expect(markNotificationRead('notification-1')).rejects.toThrow('mark one failed');
  });
});
