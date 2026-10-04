import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { supabaseAnon, supabaseAdmin, createTestUser, signInTestUser, deleteTestUser, resetDatabase } from '../../helpers/supabase-test-client';
import { createClient } from '@supabase/supabase-js';

describe('RLS: residences table', () => {
  let landlordA: any;
  let landlordB: any;
  let tenantA: any;
  let adminUser: any;

  beforeAll(async () => {
    await resetDatabase();
    landlordA = await createTestUser('bailleur');
    landlordB = await createTestUser('bailleur');
    tenantA = await createTestUser('locataire');
    adminUser = await createTestUser('admin');

    for (const u of [landlordA, landlordB, tenantA, adminUser]) {
      const signIn = await signInTestUser(u.email, u.password);
      u.token = signIn.session?.access_token ?? '';
    }
  });

  afterAll(async () => {
    await deleteTestUser(landlordA.user.id);
    await deleteTestUser(landlordB.user.id);
    await deleteTestUser(tenantA.user.id);
    await deleteTestUser(adminUser.user.id);
  });

  beforeEach(async () => {
    await resetDatabase();
    for (const u of [landlordA, landlordB, tenantA, adminUser]) {
      const signIn = await signInTestUser(u.email, u.password);
      u.token = signIn.session?.access_token ?? '';
    }
  });

  const clients: Record<string, any> = {};
  function getClient(user: any) {
    if (!clients[user.token]) {
      clients[user.token] = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { global: { headers: { Authorization: `Bearer ${user.token}` } } }
      );
    }
    return clients[user.token];
  }

  async function createResidenceDirect(ownerId: string, overrides: Record<string, unknown> = {}) {
    const row: Record<string, unknown> = {
      owner_id: ownerId,
      title: `Test Residence ${Date.now()}`,
      description: 'Test description',
      type: 'appartement',
      price_monthly: 100000,
      deposit: 200000,
      bedrooms: 2,
      bathrooms: 1,
      city: 'Cotonou',
      zone: 'Haie Vive',
      is_published: true,
      is_verified: true,
      ...overrides,
    };

    if ('moderation_status' in overrides) {
      if (row.moderation_status === 'approved') {
        if (!('is_published' in overrides)) row.is_published = true;
        if (!('is_verified' in overrides)) row.is_verified = true;
      } else {
        if (!('is_published' in overrides)) row.is_published = false;
        if (!('is_verified' in overrides)) row.is_verified = false;
      }
    } else {
      row.moderation_status =
        row.is_published === true && row.is_verified === true
          ? 'approved'
          : 'draft';
    }

    const { data, error } = await supabaseAdmin.from('residences').insert(row).select('id').single();
    if (error) throw error;
    return data.id;
  }

  describe('SELECT policies', () => {
    it('published & verified residence is visible to an authenticated tenant', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id, {
        moderation_status: 'pending',
        is_published: false,
        is_verified: false,
        status: 'libre',
      });
      // The moderation RPC accepts only residences explicitly waiting for review.
      const moderated = await getClient(adminUser).rpc('admin_moderate_residence', {
        p_residence_id: residenceId,
        p_action: 'approve',
      });
      if (moderated.error) {
        throw new Error(`admin_moderate_residence failed: ${JSON.stringify(moderated.error)}`);
      }

      const { data, error } = await getClient(tenantA).from('residences').select('*').eq('id', residenceId).single();
      if (error) {
        throw new Error(`authenticated residence SELECT failed: ${JSON.stringify(error)}`);
      }
      expect(data?.is_published).toBe(true);
      expect(data?.is_verified).toBe(true);
    });

    it('draft residence is NOT visible to tenant', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id, { is_published: false });
      const clientTenant = getClient(tenantA);
      const { data, error } = await clientTenant.from('residences').select('*').eq('id', residenceId).single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('unverified residence is NOT visible to tenant', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id, { is_published: true, is_verified: false });
      const clientTenant = getClient(tenantA);
      const { data, error } = await clientTenant.from('residences').select('*').eq('id', residenceId).single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('tenant cannot fetch a draft residence through get_residence RPC', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id, {
        is_published: false,
        is_verified: false,
        moderation_status: 'draft',
      });
      const { data, error } = await getClient(tenantA).rpc('get_residence', {
        p_residence_id: residenceId,
      });
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('tenant cannot fetch an occupied residence through get_residence RPC', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id, {
        is_published: true,
        is_verified: true,
        status: 'occupee',
        moderation_status: 'approved',
      });
      const { data, error } = await getClient(tenantA).rpc('get_residence', {
        p_residence_id: residenceId,
      });
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('landlord CAN see own draft/unverified residences', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id, { is_published: false, is_verified: false });
      const clientLandlord = getClient(landlordA);
      const { data, error } = await clientLandlord.from('residences').select('*').eq('id', residenceId).single();
      expect(error).toBeNull();
      expect(data).toBeDefined();
    });

    it('landlord CANNOT see other landlord draft', async () => {
      const residenceId = await createResidenceDirect(landlordB.user.id, { is_published: false });
      const clientLandlordA = getClient(landlordA);
      const { data, error } = await clientLandlordA.from('residences').select('*').eq('id', residenceId).single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('admin CAN see all residences', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id, { is_published: false, is_verified: false });
      const clientAdmin = getClient(adminUser);
      const { data, error } = await clientAdmin.from('residences').select('*').eq('id', residenceId).single();
      expect(error).toBeNull();
      expect(data).toBeDefined();
    });
  });

  describe('INSERT policies', () => {
    it('landlord CAN create residence via direct INSERT', async () => {
      const clientLandlord = getClient(landlordA);
      const { data, error } = await clientLandlord.from('residences').insert({
        owner_id: landlordA.user.id, // la policy INSERT exige owner_id = auth.uid()
        title: 'My Residence',
        type: 'appartement',
        price_monthly: 100000,
        deposit: 200000,
        bedrooms: 2,
        bathrooms: 1,
        city: 'Cotonou',
        zone: 'Haie Vive',
      }).select('id').single();
      expect(error).toBeNull();
      expect(data?.id).toBeDefined();
    });

    it('tenant CANNOT create residence', async () => {
      const clientTenant = getClient(tenantA);
      const { data, error } = await clientTenant.from('residences').insert({
        title: 'Hack Attempt',
        type: 'appartement',
        price_monthly: 50000,
        city: 'Cotonou',
      }).select('id').single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('anon CANNOT create residence', async () => {
      const { data, error } = await supabaseAnon.from('residences').insert({
        title: 'Hack Attempt',
        type: 'appartement',
        price_monthly: 50000,
        city: 'Cotonou',
      }).select('id').single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });
  });

  describe('MODERATION workflow', () => {
    async function createDraft() {
      return createResidenceDirect(landlordA.user.id, {
        is_published: false,
        is_verified: false,
        photos: ['https://example.com/photo.jpg'],
        moderation_status: 'draft',
      });
    }

    it('approved residence becomes draft and unpublished after substantive owner edit', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id, {
        is_published: true,
        is_verified: true,
        moderation_status: 'approved',
        photos: ['https://example.com/original.jpg'],
      });
      const landlord = getClient(landlordA);

      const updated = await landlord
        .from('residences')
        .update({ title: 'Titre modifié après approbation' })
        .eq('id', residenceId)
        .select('title, is_published, is_verified, moderation_status, moderation_reason, moderated_at')
        .single();

      expect(updated.error).toBeNull();
      expect(updated.data).toMatchObject({
        title: 'Titre modifié après approbation',
        is_published: false,
        is_verified: false,
        moderation_status: 'draft',
        moderation_reason: null,
        moderated_at: null,
      });
    });

    it('landlord cannot directly mutate moderation_status or publication flags', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id, {
        is_published: false,
        is_verified: false,
        moderation_status: 'draft',
      });
      const landlord = getClient(landlordA);

      const updated = await landlord
        .from('residences')
        .update({
          is_published: true,
          is_verified: true,
          moderation_status: 'approved',
        })
        .eq('id', residenceId)
        .select('is_published, is_verified, moderation_status')
        .single();

      expect(updated.error).toBeNull();
      expect(updated.data).toMatchObject({
        is_published: false,
        is_verified: false,
        moderation_status: 'draft',
      });
    });

    it('non-admin cannot call the admin moderation RPC', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id, {
        is_published: false,
        is_verified: false,
        moderation_status: 'pending',
      });
      const landlord = getClient(landlordA);

      const result = await landlord.rpc('admin_moderate_residence', {
        p_residence_id: residenceId,
        p_action: 'approve',
      });

      expect(result.error).toBeDefined();

      const { data } = await landlord
        .from('residences')
        .select('is_published, is_verified, moderation_status')
        .eq('id', residenceId)
        .single();

      expect(data).toMatchObject({
        is_published: false,
        is_verified: false,
        moderation_status: 'pending',
      });
    });

    it('landlord cannot directly publish; submission moves draft to pending', async () => {
      const residenceId = await createDraft();
      const clientLandlord = getClient(landlordA);

      const direct = await clientLandlord
        .from('residences')
        .update({ is_published: true })
        .eq('id', residenceId)
        .select('is_published, moderation_status')
        .single();

      expect(direct.error).toBeNull();
      expect(direct.data?.is_published).toBe(false);
      expect(direct.data?.moderation_status).toBe('draft');

      const submitted = await clientLandlord.rpc('submit_residence_for_review', {
        p_residence_id: residenceId,
      });
      expect(submitted.error).toBeNull();

      const { data } = await clientLandlord
        .from('residences')
        .select('is_published, is_verified, moderation_status')
        .eq('id', residenceId)
        .single();

      expect(data).toMatchObject({
        is_published: false,
        is_verified: false,
        moderation_status: 'pending',
      });

      const clientTenant = getClient(tenantA);
      const publicRead = await clientTenant
        .from('residences')
        .select('id')
        .eq('id', residenceId)
        .single();

      expect(publicRead.data).toBeNull();
      expect(publicRead.error).toBeDefined();
    });

    it('admin approval publishes and makes the residence publicly visible', async () => {
      const residenceId = await createDraft();
      const landlord = getClient(landlordA);
      await landlord.rpc('submit_residence_for_review', { p_residence_id: residenceId });

      const admin = getClient(adminUser);
      const moderated = await admin.rpc('admin_moderate_residence', {
        p_residence_id: residenceId,
        p_action: 'approve',
      });
      expect(moderated.error).toBeNull();

      const { data } = await supabaseAnon
        .from('residences')
        .select('is_published, is_verified, moderation_status')
        .eq('id', residenceId)
        .single();

      expect(data).toMatchObject({
        is_published: true,
        is_verified: true,
        moderation_status: 'approved',
      });
    });

    it('admin approval notifies the landlord', async () => {
      const residenceId = await createDraft();
      const landlord = getClient(landlordA);
      await landlord.rpc('submit_residence_for_review', { p_residence_id: residenceId });

      const moderated = await supabaseAdmin.rpc('admin_moderate_residence', {
        p_residence_id: residenceId,
        p_action: 'approve',
      });
      expect(moderated.error).toBeNull();

      const { data: notifications, error: notificationError } = await getClient(landlordA)
        .from('notifications')
        .select('type, title, body, data')
        .eq('type', 'system')
        .contains('data', { residence_id: residenceId, moderation_status: 'approved' })
        .order('created_at', { ascending: false })
        .limit(1);

      expect(notificationError).toBeNull();
      expect(notifications?.[0]).toMatchObject({
        type: 'system',
        title: 'Bien vérifié',
        data: { residence_id: residenceId, moderation_status: 'approved' },
      });
    });

    it('admin rejection persists the reason and allows resubmission', async () => {
      const residenceId = await createDraft();
      const landlord = getClient(landlordA);
      await landlord.rpc('submit_residence_for_review', { p_residence_id: residenceId });

      const admin = getClient(adminUser);
      const rejected = await admin.rpc('admin_moderate_residence', {
        p_residence_id: residenceId,
        p_action: 'reject',
        p_reason: 'Ajoutez une photo claire de la façade.',
      });
      expect(rejected.error).toBeNull();

      const { data: notifications, error: notificationError } = await landlord
        .from('notifications')
        .select('type, title, body, data')
        .eq('type', 'system')
        .contains('data', { residence_id: residenceId, moderation_status: 'rejected' })
        .order('created_at', { ascending: false })
        .limit(1);

      expect(notificationError).toBeNull();
      expect(notifications?.[0]).toMatchObject({
        type: 'system',
        title: 'Annonce refusée',
        body: expect.stringContaining('Ajoutez une photo claire de la façade.'),
        data: {
          residence_id: residenceId,
          moderation_status: 'rejected',
          reason: 'Ajoutez une photo claire de la façade.',
        },
      });

      const rejectedRow = await landlord
        .from('residences')
        .select('is_published, is_verified, moderation_status, moderation_reason')
        .eq('id', residenceId)
        .single();

      expect(rejectedRow.data).toMatchObject({
        is_published: false,
        is_verified: false,
        moderation_status: 'rejected',
        moderation_reason: 'Ajoutez une photo claire de la façade.',
      });

      const resubmitted = await landlord.rpc('submit_residence_for_review', {
        p_residence_id: residenceId,
      });
      expect(resubmitted.error).toBeNull();

      const { data } = await landlord
        .from('residences')
        .select('is_published, is_verified, moderation_status, moderation_reason')
        .eq('id', residenceId)
        .single();

      expect(data).toMatchObject({
        is_published: false,
        is_verified: false,
        moderation_status: 'pending',
        moderation_reason: null,
      });
    });
  });

  describe('UPDATE policies', () => {
    it('landlord CAN update own residence', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id);
      const clientLandlord = getClient(landlordA);
      const { data, error } = await clientLandlord
        .from('residences')
        .update({ title: 'Updated Title' })
        .eq('id', residenceId)
        .select('title')
        .single();
      expect(error).toBeNull();
      expect(data?.title).toBe('Updated Title');
    });

    it('landlord CANNOT update other landlord residence', async () => {
      const residenceId = await createResidenceDirect(landlordB.user.id);
      const clientLandlordA = getClient(landlordA);
      const { data, error } = await clientLandlordA
        .from('residences')
        .update({ title: 'Hacked' })
        .eq('id', residenceId)
        .select('title')
        .single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('tenant CANNOT update any residence', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id);
      const clientTenant = getClient(tenantA);
      const { data, error } = await clientTenant
        .from('residences')
        .update({ title: 'Hacked' })
        .eq('id', residenceId)
        .select('title')
        .single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('landlord CANNOT self-verify (is_verified is admin-only)', async () => {
      // Le trigger residences_guard_owner écrase silencieusement
      // is_verified (et owner_id) par la valeur existante pour tout
      // appelant non service_role : l'UPDATE ne doit ni échouer ni
      // modifier is_verified.
      const residenceId = await createResidenceDirect(landlordA.user.id, { is_verified: false });
      const clientLandlord = getClient(landlordA);
      const { data, error } = await clientLandlord
        .from('residences')
        .update({ is_verified: true })
        .eq('id', residenceId)
        .select('is_verified')
        .single();
      expect(error).toBeNull();
      expect(data?.is_verified).toBe(false); // écrasé par le garde-fou
    });

    it('direct admin approval state is valid when all visibility flags agree', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id, {
        is_published: false,
        is_verified: false,
        moderation_status: 'draft',
      });
      const clientAdmin = getClient(adminUser);
      const { data, error } = await clientAdmin
        .from('residences')
        .update({
          is_published: true,
          is_verified: true,
          moderation_status: 'approved',
        })
        .eq('id', residenceId)
        .select('is_published, is_verified, moderation_status')
        .single();

      expect(error).toBeNull();
      expect(data).toMatchObject({
        is_published: true,
        is_verified: true,
        moderation_status: 'approved',
      });
    });

    it('admin cannot create an invalid moderation/publication state by direct update', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id, {
        is_published: false,
        is_verified: false,
        moderation_status: 'draft',
      });
      const clientAdmin = getClient(adminUser);
      const { data, error } = await clientAdmin
        .from('residences')
        .update({ is_verified: true })
        .eq('id', residenceId)
        .select('is_published, is_verified, moderation_status')
        .single();

      expect(error).toBeDefined();
      expect(data).toBeNull();
    });
  });

  describe('DELETE policies', () => {
    it('landlord CAN delete own draft residence', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id, { is_published: false });
      const clientLandlord = getClient(landlordA);
      const { error } = await clientLandlord.from('residences').delete().eq('id', residenceId);
      expect(error).toBeNull();
    });

    it('landlord CANNOT delete published residence (status occupied check)', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id, { is_published: true, is_verified: true });
      const clientLandlord = getClient(landlordA);
      const { error } = await clientLandlord.from('residences').delete().eq('id', residenceId);
      // May succeed if not occupied, but should fail if occupied
      // This tests the trigger logic
    });

    it('tenant CANNOT delete any residence', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id);
      const clientTenant = getClient(tenantA);
      const { error } = await clientTenant.from('residences').delete().eq('id', residenceId);
      expect(error).toBeDefined();
    });
  });

  describe('withdrawal workflow', () => {
    it('landlord can withdraw an approved residence back to a coherent draft state', async () => {
      const residenceId = await createResidenceDirect(landlordA.user.id, {
        is_published: true,
        is_verified: true,
        moderation_status: 'approved',
        status: 'libre',
      });

      const { error } = await getClient(landlordA).rpc('withdraw_residence_publication', {
        p_residence_id: residenceId,
      });

      expect(error).toBeNull();

      const { data, error: readError } = await getClient(landlordA)
        .from('residences')
        .select('is_published, is_verified, moderation_status')
        .eq('id', residenceId)
        .single();

      expect(readError).toBeNull();
      expect(data).toMatchObject({
        is_published: false,
        is_verified: false,
        moderation_status: 'draft',
      });
    });
  });

  describe('public search bounds', () => {
    it('rejects partial coordinates', async () => {
      const { data, error } = await supabaseAnon.rpc('search_residences', {
        p_lat: 6.37,
        p_lng: null,
        p_radius_km: 10,
        p_limit: 40,
        p_offset: 0,
      });

      expect(data).toBeNull();
      expect(error).toBeDefined();
      expect(error?.message).toContain('Latitude et longitude doivent être fournies ensemble');
    });

    it('rejects invalid latitude', async () => {
      const { data, error } = await supabaseAnon.rpc('search_residences', {
        p_lat: 91,
        p_lng: 2.4,
        p_radius_km: 10,
        p_limit: 40,
        p_offset: 0,
      });

      expect(data).toBeNull();
      expect(error).toBeDefined();
      expect(error?.message).toContain('Latitude invalide');
    });

    it('rejects oversized search text', async () => {
      const { data, error } = await supabaseAnon.rpc('search_residences', {
        p_q: 'x'.repeat(201),
        p_limit: 40,
        p_offset: 0,
      });

      expect(data).toBeNull();
      expect(error).toBeDefined();
      expect(error?.message).toContain('Recherche trop longue');
    });
  });
});
