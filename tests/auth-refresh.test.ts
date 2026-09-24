import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getMyProfile: vi.fn(),
}));

vi.mock('../apps/web/src/lib/supabase-client', () => ({
  supabase: {
    auth: {
      getUser: mocks.getUser,
    },
  },
}));

vi.mock('../apps/web/src/lib/api/auth', () => ({
  getMyProfile: mocks.getMyProfile,
}));

import { resolveAuthProfile } from '../apps/web/src/lib/auth-refresh';

describe('resolveAuthProfile', () => {
  beforeEach(() => {
    mocks.getUser.mockReset();
    mocks.getMyProfile.mockReset();
  });

  it('clears the profile when auth reports no user', async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: null,
    });

    await expect(resolveAuthProfile()).resolves.toEqual({ kind: 'signed-out' });
    expect(mocks.getMyProfile).not.toHaveBeenCalled();
  });

  it('does not sign the user out on an auth transport error', async () => {
    const error = new Error('network unavailable');
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error,
    });

    await expect(resolveAuthProfile()).resolves.toEqual({
      kind: 'unavailable',
      error,
    });
    expect(mocks.getMyProfile).not.toHaveBeenCalled();
  });

  it('loads the profile for an authenticated user', async () => {
    const profile = { id: 'user-1', role: 'locataire' };
    mocks.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    });
    mocks.getMyProfile.mockResolvedValue(profile);

    await expect(resolveAuthProfile()).resolves.toEqual({
      kind: 'authenticated',
      profile,
    });
  });

  it('preserves the session when the profile read is unavailable', async () => {
    const error = new Error('profile backend unavailable');
    mocks.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    });
    mocks.getMyProfile.mockRejectedValue(error);

    await expect(resolveAuthProfile()).resolves.toEqual({
      kind: 'profile-unavailable',
      error,
    });
  });
});
