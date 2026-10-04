import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  supabaseAnon,
  supabaseAdmin,
  createTestUser,
  deleteTestUser,
  resetDatabase,
} from '../../helpers/supabase-test-client';

describe('Security: list_reviews visibility', () => {
  let landlord: any;
  let tenant: any;

  beforeAll(async () => {
    await resetDatabase();
    landlord = await createTestUser('bailleur');
    tenant = await createTestUser('locataire');
  });

  afterAll(async () => {
    await resetDatabase();
    await deleteTestUser(landlord.user.id);
    await deleteTestUser(tenant.user.id);
  });

  async function createResidence(values: Record<string, unknown>) {
    const { data, error } = await supabaseAdmin
      .from('residences')
      .insert({
        owner_id: landlord.user.id,
        title: `Review visibility ${Date.now()}`,
        type: 'appartement',
        price_monthly: 100000,
        city: 'Cotonou',
        zone: 'Test',
        is_published: false,
        is_verified: false,
        moderation_status: 'draft',
        status: 'libre',
        ...values,
      })
      .select('id')
      .single();

    if (error) throw error;
    return data.id as string;
  }

  it('returns an empty result for non-public residences', async () => {
    const residenceId = await createResidence({});

    const { data, error } = await supabaseAnon.rpc('list_reviews', {
      p_residence_id: residenceId,
    });

    expect(error).toBeNull();
    expect(data).toEqual({
      average: 0,
      count: 0,
      reviews: [],
    });
  });

  it('returns public reviews without exposing tenant identity', async () => {
    const residenceId = await createResidence({
      is_published: true,
      is_verified: true,
      moderation_status: 'approved',
    });

    const { error: reviewError } = await supabaseAdmin.from('reviews').insert({
      residence_id: residenceId,
      tenant_id: tenant.user.id,
      rating: 5,
      comment: 'Très bon logement.',
    });
    expect(reviewError).toBeNull();

    const { data, error } = await supabaseAnon.rpc('list_reviews', {
      p_residence_id: residenceId,
    });

    expect(error).toBeNull();
    expect(data?.average).toBe(5);
    expect(data?.count).toBe(1);
    expect(data?.reviews).toHaveLength(1);
    expect(data?.reviews?.[0]).toMatchObject({
      residence_id: residenceId,
      rating: 5,
      comment: 'Très bon logement.',
    });
    expect(data?.reviews?.[0]).not.toHaveProperty('tenant_id');
    expect(data?.reviews?.[0]).not.toHaveProperty('tenant_name');
  });
});
