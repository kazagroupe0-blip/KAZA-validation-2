import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock('../apps/web/src/lib/supabase-client', () => ({
  supabase: {
    from: mocks.from,
  },
}));

vi.mock('../apps/web/src/lib/require-user', () => ({
  requireUser: mocks.requireUser,
}));

import { markAllNotificationsRead, markNotificationRead } from '../apps/web/src/lib/api/notifications';
import { markConversationRead } from '../apps/web/src/lib/api/chat';

function makeNotificationsMutation(error: unknown) {
  return {
    update: vi.fn(() => ({
      is: vi.fn(() => Promise.resolve({ error })),
      eq: vi.fn(() => Promise.resolve({ error })),
    })),
  };
}

describe('API error surface', () => {
  beforeEach(() => {
    mocks.from.mockReset();
    mocks.requireUser.mockResolvedValue({ id: 'user-1' });
  });

  it('surfaces mark-all notification failures', async () => {
    const error = { code: '42501', message: 'permission denied' };
    mocks.from.mockReturnValue(makeNotificationsMutation(error));

    await expect(markAllNotificationsRead()).rejects.toMatchObject({
      status: 403,
      message: 'permission denied',
    });
  });

  it('surfaces single notification failures', async () => {
    const error = { code: '42501', message: 'permission denied' };
    mocks.from.mockReturnValue(makeNotificationsMutation(error));

    await expect(markNotificationRead('notification-1')).rejects.toMatchObject({
      status: 403,
      message: 'permission denied',
    });
  });

  it('surfaces conversation read-state failures', async () => {
    const error = { code: '42501', message: 'permission denied' };
    mocks.from.mockReturnValue({
      update: vi.fn(() => ({
        eq: vi.fn(() => ({
          neq: vi.fn(() => ({
            is: vi.fn(() => Promise.resolve({ error })),
          })),
        })),
      })),
    });

    await expect(markConversationRead('conversation-1')).rejects.toMatchObject({
      status: 403,
      message: 'permission denied',
    });
  });
});
