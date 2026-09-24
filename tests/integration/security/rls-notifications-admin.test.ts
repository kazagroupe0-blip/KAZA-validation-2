import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { supabaseAnon, supabaseAdmin, createTestUser, signInTestUser, deleteTestUser, resetDatabase } from '../../helpers/supabase-test-client';
import { createClient } from '@supabase/supabase-js';

describe('RLS: notifications & admin tables', () => {
  let landlordA: any;
  let tenantA: any;
  let adminUser: any;

  beforeAll(async () => {
    await resetDatabase();
    landlordA = await createTestUser('bailleur');
    tenantA = await createTestUser('locataire');
    adminUser = await createTestUser('admin');

    for (const u of [landlordA, tenantA, adminUser]) {
      const signIn = await signInTestUser(u.email, u.password);
      u.token = signIn.session?.access_token ?? '';
    }
  });

  afterAll(async () => {
    await deleteTestUser(landlordA.user.id);
    await deleteTestUser(tenantA.user.id);
    await deleteTestUser(adminUser.user.id);
  });

  beforeEach(async () => {
    await resetDatabase();
    for (const u of [landlordA, tenantA, adminUser]) {
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

  async function createPublishedVerifiedResidence(ownerId: string): Promise<string> {
    const { data, error } = await supabaseAdmin.from('residences').insert({
      owner_id: ownerId,
      title: `Test ${Date.now()}`,
      type: 'appartement',
      price_monthly: 100000,
      city: 'Cotonou',
      zone: 'Haie Vive',
      is_published: true,
      is_verified: true,
    }).select('id').single();
    if (error) throw error;
    return data.id;
  }

  async function createLease(landlord: any, tenant: any) {
    const residenceId = await createPublishedVerifiedResidence(landlord.user.id);
    await supabaseAdmin.rpc('admin_moderate_residence', { p_residence_id: residenceId, p_action: 'approve' });
    const { data, error } = await getClient(landlord).rpc('create_lease', {
      p_residence_id: residenceId,
      p_tenant_id: tenant.user.id,
      p_start_date: new Date().toISOString().split('T')[0],
      p_monthly_rent: 100000,
      p_deposit: 200000,
    });
    if (error) throw error;
    return { leaseId: data, residenceId };
  }

  describe('notifications SELECT', () => {
    it('user CAN see own notifications', async () => {
      // create_lease insère une notification déterministe pour le locataire
      // (type 'lease', data.lease_id = bail créé).
      const { leaseId } = await createLease(landlordA, tenantA);
      // Prérequis, vérifié côté admin : la notification existe bel et bien. Sans elle,
      // le test échoue ici au lieu de passer à vide (ancien `length >= 0`).
      const { data: seeded } = await supabaseAdmin
        .from('notifications')
        .select('id')
        .eq('user_id', tenantA.user.id)
        .eq('type', 'lease')
        .contains('data', { lease_id: leaseId });
      expect(seeded).toHaveLength(1);
      // Propriété testée, avec le client réel du locataire : il lit SA notification.
      const { data, error } = await getClient(tenantA)
        .from('notifications')
        .select('id, user_id')
        .eq('id', seeded![0].id);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data![0].user_id).toBe(tenantA.user.id);
    });

    it('user CANNOT see other user notifications', async () => {
      await createLease(landlordA, tenantA);
      // Contrat PostgREST sous RLS : SELECT collection filtre silencieusement
      // (tableau vide, pas d'erreur) — pas data=null.
      const { data, error } = await getClient(landlordA).from('notifications').select('*').eq('user_id', tenantA.user.id);
      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);
      expect(data!.length).toBe(0);
    });

    it('anon CANNOT see any notifications', async () => {
      await createLease(landlordA, tenantA);
      // Contrat PostgREST sous RLS : SELECT collection filtre silencieusement
      // (tableau vide, pas d'erreur) — pas data=null.
      const { data, error } = await supabaseAnon.from('notifications').select('*').limit(1);
      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);
      expect(data!.length).toBe(0);
    });
  });

  describe('notifications UPDATE (mark read)', () => {
    it('user CAN mark own notification as read', async () => {
      // Seed déterministe côté admin : une notification non lue appartenant à tenantA.
      const { data: seeded, error: seedError } = await supabaseAdmin.from('notifications').insert({
        user_id: tenantA.user.id, type: 'system', title: 'seed', body: 'seed',
      }).select('id, read_at');
      expect(seedError).toBeNull();
      expect(seeded).toHaveLength(1);
      expect(seeded![0].read_at).toBeNull();
      // Action testée, avec le client réel du propriétaire de la notification.
      const { error } = await getClient(tenantA)
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', seeded![0].id);
      expect(error).toBeNull();
      // Un UPDATE filtré par RLS renverrait 0 ligne SANS erreur : seul l'état relu
      // côté admin prouve que read_at a réellement été renseigné.
      const { data: after } = await supabaseAdmin.from('notifications').select('read_at').eq('id', seeded![0].id).single();
      expect(after?.read_at).not.toBeNull();
    });

    it('user CANNOT mark other user notification as read', async () => {
      // Seed déterministe : une notification appartenant à tenantA.
      const { data: seeded } = await supabaseAdmin.from('notifications').insert({
        user_id: tenantA.user.id, type: 'system', title: 'seed', body: 'seed',
      }).select('id').single();
      // landlordA n'est pas couvert par notifications_update (USING user_id = auth.uid()) :
      // l'UPDATE ne matche aucune ligne et NE renvoie PAS d'erreur. Invariant : read_at reste null.
      await getClient(landlordA)
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', seeded!.id);
      const { data: after } = await supabaseAdmin.from('notifications').select('read_at').eq('id', seeded!.id).single();
      expect(after?.read_at).toBeNull();
    });
  });

  describe('notifications INSERT/DELETE', () => {
    it('user CANNOT insert a notification for another user', async () => {
      // NOTE : notifications_insert autorise WITH CHECK (user_id = auth.uid()), donc un
      // self-insert réussit actuellement (écart à traiter hors phase 1a). Le vrai invariant
      // testable ici est qu'on ne peut pas fabriquer une notification POUR AUTRUI.
      const { error } = await getClient(tenantA).from('notifications').insert({
        user_id: landlordA.user.id,
        type: 'system',
        title: 'Fake',
        body: 'Hack',
      });
      expect(error).not.toBeNull();
    });

    it('user CANNOT delete notifications', async () => {
      const { data: seeded } = await supabaseAdmin.from('notifications').insert({
        user_id: tenantA.user.id, type: 'system', title: 'seed', body: 'seed',
      }).select('id').single();
      // Aucune policy DELETE sur notifications : 0 ligne, sans erreur. Invariant : la ligne persiste.
      await getClient(tenantA).from('notifications').delete().eq('id', seeded!.id);
      const { data: still } = await supabaseAdmin.from('notifications').select('id').eq('id', seeded!.id).maybeSingle();
      expect(still?.id).toBe(seeded!.id);
    });
  });

  describe('Admin functions', () => {
    it('admin CAN call admin_stats', async () => {
      const { data, error } = await getClient(adminUser).rpc('admin_stats');
      expect(error).toBeNull();
      // `toBeDefined` était toujours vrai (null est défini). Les 3 profils de test existent.
      expect(typeof data?.users?.total).toBe('number');
      expect(data.users.total).toBeGreaterThanOrEqual(3);
    });

    it('tenant CANNOT call admin_stats', async () => {
      const { error } = await getClient(tenantA).rpc('admin_stats');
      expect(error).not.toBeNull();
    });

    it('landlord CANNOT call admin_stats', async () => {
      const { error } = await getClient(landlordA).rpc('admin_stats');
      expect(error).not.toBeNull();
    });

    it('admin_list_residences RPC removed (migration 999999)', async () => {
      const { data, error } = await getClient(adminUser).rpc('admin_list_residences', { limit: 10 });
      expect(error).not.toBeNull();
      expect(data).toBeNull();
    });

    it('tenant cannot call removed admin_list_residences', async () => {
      const { error } = await getClient(tenantA).rpc('admin_list_residences');
      expect(error).not.toBeNull();
    });

    it('admin_list_users RPC removed (migration 999999)', async () => {
      const { data, error } = await getClient(adminUser).rpc('admin_list_users', { limit: 10 });
      expect(error).not.toBeNull();
      expect(data).toBeNull();
    });

    it('tenant cannot call removed admin_list_users', async () => {
      const { error } = await getClient(tenantA).rpc('admin_list_users');
      expect(error).not.toBeNull();
    });

    it('admin CAN verify residence via RPC', async () => {
      const residenceId = await createPublishedVerifiedResidence(landlordA.user.id);
      const { error } = await getClient(adminUser).rpc('admin_verify_residence', { p_residence_id: residenceId });
      expect(error).toBeNull();
    });

    it('tenant CANNOT verify residence', async () => {
      const residenceId = await createPublishedVerifiedResidence(landlordA.user.id);
      const { error } = await getClient(tenantA).rpc('admin_verify_residence', { p_residence_id: residenceId });
      expect(error).not.toBeNull();
    });

    it('admin CAN unpublish residence via RPC', async () => {
      const residenceId = await createPublishedVerifiedResidence(landlordA.user.id);
      await supabaseAdmin.rpc('admin_moderate_residence', { p_residence_id: residenceId, p_action: 'approve' });
      const { error } = await getClient(adminUser).rpc('admin_unpublish_residence', { p_residence_id: residenceId });
      expect(error).toBeNull();
    });

    it('admin CAN set premium via RPC', async () => {
      const { error } = await getClient(adminUser).rpc('admin_set_premium', { p_user_id: tenantA.user.id, p_is_premium: true });
      expect(error).toBeNull();
    });

    it('tenant CANNOT set premium', async () => {
      const { error } = await getClient(tenantA).rpc('admin_set_premium', { p_user_id: tenantA.user.id, p_is_premium: true });
      expect(error).not.toBeNull();
    });

    it('admin CAN toggle role via RPC', async () => {
      const { error } = await getClient(adminUser).rpc('admin_toggle_role', { p_user_id: tenantA.user.id, p_role: 'bailleur' });
      expect(error).toBeNull();
    });

    it('tenant CANNOT toggle role', async () => {
      const { error } = await getClient(tenantA).rpc('admin_toggle_role', { p_user_id: tenantA.user.id, p_role: 'bailleur' });
      expect(error).not.toBeNull();
    });

    it('admin CANNOT demote another admin through the generic role toggle', async () => {
      const { error: promoteError } = await supabaseAdmin
        .from('profiles')
        .update({ role: 'admin' })
        .eq('id', landlordA.user.id);
      expect(promoteError).toBeNull();

      const { error } = await getClient(adminUser).rpc('admin_toggle_role', {
        p_user_id: landlordA.user.id,
        p_role: 'bailleur',
      });
      expect(error).not.toBeNull();

      const { data: target } = await supabaseAdmin
        .from('profiles')
        .select('role')
        .eq('id', landlordA.user.id)
        .single();
      expect(target?.role).toBe('admin');
    });

    it('admin CANNOT toggle role to admin', async () => {
      const { error } = await getClient(adminUser).rpc('admin_toggle_role', { p_user_id: tenantA.user.id, p_role: 'admin' });
      // Should be blocked - admin role cannot be assigned via this RPC
      expect(error).not.toBeNull();
    });
  });
});