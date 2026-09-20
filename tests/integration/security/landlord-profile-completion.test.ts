import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  supabaseAdmin,
  createTestUser,
  signInTestUser,
  deleteTestUser,
  resetDatabase,
} from '../../helpers/supabase-test-client';

describe('Landlord profile completion', () => {
  let landlord: { user: any; email: string; password: string };
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    await resetDatabase();
    landlord = await createTestUser('bailleur');

    const session = await signInTestUser(landlord.email, landlord.password);
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: { headers: { Authorization: `Bearer ${session.session?.access_token ?? ''}` } },
      },
    );
  });

  beforeEach(async () => {
    await resetDatabase();

    // Re-emit the profile workflow trigger after reset. The account itself
    // remains because resetDatabase intentionally does not delete auth users.
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({
        business_name: null,
        momo_provider: null,
        momo_number: null,
        onboarding_completed: false,
      })
      .eq('id', landlord.user.id);
    if (error) throw error;
  });

  afterAll(async () => {
    await deleteTestUser(landlord.user.id);
  });

  async function getProfile() {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('business_name, momo_provider, momo_number, onboarding_completed')
      .eq('id', landlord.user.id)
      .single();
    expect(error).toBeNull();
    return data!;
  }

  async function getProfileNotifications() {
    const { data, error } = await supabaseAdmin
      .from('notifications')
      .select('id, read_at, resolved_at, data')
      .eq('user_id', landlord.user.id)
      .eq('type', 'system')
      .contains('data', { kind: 'landlord_profile_incomplete' })
      .order('created_at', { ascending: true });
    expect(error).toBeNull();
    return data ?? [];
  }

  it('creates one actionable notification for an incomplete landlord', async () => {
    const profile = await getProfile();
    const notifications = await getProfileNotifications();

    expect(profile.onboarding_completed).toBe(false);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].resolved_at).toBeNull();
    expect((notifications[0].data as Record<string, unknown>).href).toBe('/profile');
  });

  it('resolves the alert when the real required fields are complete', async () => {
    const { error } = await client
      .from('profiles')
      .update({
        business_name: 'KAZA Immo',
        momo_provider: 'mtn',
        momo_number: '+2290100000000',
      })
      .eq('id', landlord.user.id);
    expect(error).toBeNull();

    const profile = await getProfile();
    const notifications = await getProfileNotifications();

    expect(profile.onboarding_completed).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].resolved_at).not.toBeNull();
    expect(notifications[0].read_at).not.toBeNull();

    // Updating an already-complete profile must not create another alert.
    const { error: secondUpdateError } = await client
      .from('profiles')
      .update({ business_name: 'KAZA Immo Bénin' })
      .eq('id', landlord.user.id);
    expect(secondUpdateError).toBeNull();

    const notificationsAfter = await getProfileNotifications();
    expect(notificationsAfter).toHaveLength(1);
  });

  it('rejects direct client tampering with onboarding_completed', async () => {
    const { data, error } = await client
      .from('profiles')
      .update({ onboarding_completed: true })
      .eq('id', landlord.user.id)
      .select('onboarding_completed')
      .maybeSingle();

    expect(error).toBeDefined();
    expect(data).toBeNull();

    const profile = await getProfile();
    expect(profile.onboarding_completed).toBe(false);
  });

  it('does not let the landlord onboarding RPC promote a tenant', async () => {
    const tenant = await createTestUser('locataire');
    try {
      const session = await signInTestUser(tenant.email, tenant.password);
      const tenantClient = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { global: { headers: { Authorization: `Bearer ${session.session?.access_token ?? ''}` } } },
      );

      const { error } = await tenantClient.rpc('complete_landlord_onboarding', {
        p_business_name: 'Intrusion',
        p_tax_id: '',
        p_momo_provider: 'mtn',
        p_momo_number: '+2290100000000',
        p_bank_name: null,
        p_bank_iban: null,
      });
      expect(error).toBeDefined();

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('role, onboarding_completed')
        .eq('id', tenant.user.id)
        .single();
      expect(profile?.role).toBe('locataire');
      expect(profile?.onboarding_completed).toBe(false);
    } finally {
      await deleteTestUser(tenant.user.id);
    }
  });

  it('creates a fresh alert when a completed profile becomes incomplete again', async () => {
    const { error: completeError } = await client
      .from('profiles')
      .update({
        business_name: 'KAZA Immo',
        momo_provider: 'moov',
        momo_number: '+2290100000000',
      })
      .eq('id', landlord.user.id);
    expect(completeError).toBeNull();

    const { error: incompleteError } = await client
      .from('profiles')
      .update({ momo_number: null })
      .eq('id', landlord.user.id);
    expect(incompleteError).toBeNull();

    const active = (await getProfileNotifications()).filter((n) => !n.resolved_at);
    expect(active).toHaveLength(1);

    const profile = await getProfile();
    expect(profile.onboarding_completed).toBe(false);
  });
});
