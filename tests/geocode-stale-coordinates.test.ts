import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
}));

vi.mock('../apps/web/src/lib/supabase-client', () => ({
  supabase: { from: mocks.from },
}));

vi.mock('../apps/web/src/lib/require-user', () => ({
  requireUser: vi.fn(),
}));

import { updateResidence } from '../apps/web/src/lib/api/residences';

function makeResidencesChain() {
  const update = vi.fn(() => ({
    eq: vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(() =>
          Promise.resolve({
            data: {
              id: 'res-1',
              title: 'Bien',
              photos: [],
              is_published: false,
              is_verified: false,
              moderation_status: 'pending',
              moderation_reason: null,
              moderated_at: null,
            },
            error: null,
          }),
        ),
      })),
    })),
  }));

  const select = vi.fn(() => ({
    eq: vi.fn(() => ({
      single: vi.fn(() =>
        Promise.resolve({
          data: {
            city: 'Cotonou',
            zone: 'Haie Vive',
            lat: 6.36,
            lng: 2.43,
            geom: 'SRID=4326;POINT(2.43 6.36)',
          },
          error: null,
        }),
      ),
    })),
  }));

  return { select, update };
}

describe('updateResidence geocoding contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.from.mockReset();
  });

  it('never preserves old coordinates when the location changed and geocoding fails', async () => {
    const chain = makeResidencesChain();
    mocks.from.mockReturnValue(chain);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('geocoder unavailable')));

    await updateResidence('res-1', { city: 'Porto-Novo', zone: 'Tokpota' });

    const updatePayload = chain.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updatePayload.lat).toBeNull();
    expect(updatePayload.lng).toBeNull();
    expect(updatePayload.geom).toBeNull();
  });
});
