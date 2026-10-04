import { createHash } from 'node:crypto';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  supabaseAnon,
  supabaseAdmin,
  createTestUser,
  signInTestUser,
  deleteTestUser,
  resetDatabase,
} from '../../helpers/supabase-test-client';
import { createClient } from '@supabase/supabase-js';
import { formatLocalDate } from '../../helpers/local-date';

describe('Security: targeted lease invitations', () => {
  let landlordA: any;
  let landlordB: any;
  let tenantA: any;
  let tenantB: any;

  beforeAll(async () => {
    await resetDatabase();
    landlordA = await createTestUser('bailleur');
    landlordB = await createTestUser('bailleur');
    tenantA = await createTestUser('locataire');
    tenantB = await createTestUser('locataire');

    for (const u of [landlordA, landlordB, tenantA, tenantB]) {
      const signIn = await signInTestUser(u.email, u.password);
      u.token = signIn.session?.access_token ?? '';
    }
  });

  afterAll(async () => {
    await deleteTestUser(landlordA.user.id);
    await deleteTestUser(landlordB.user.id);
    await deleteTestUser(tenantA.user.id);
    await deleteTestUser(tenantB.user.id);
  });

  beforeEach(async () => {
    await resetDatabase();
    for (const u of [landlordA, landlordB, tenantA, tenantB]) {
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
        { global: { headers: { Authorization: `Bearer ${user.token}` } } },
      );
    }
    return clients[user.token];
  }

  async function createResidence(ownerId: string): Promise<string> {
    const { data, error } = await supabaseAdmin
      .from('residences')
      .insert({
        owner_id: ownerId,
        title: `Invitation test ${Date.now()}`,
        type: 'appartement',
        price_monthly: 100000,
        deposit: 200000,
        bedrooms: 2,
        bathrooms: 1,
        city: 'Cotonou',
        zone: 'Haie Vive',
        is_published: true,
        is_verified: true,
        moderation_status: 'approved',
        status: 'libre',
      })
      .select('id')
      .single();

    if (error) throw error;
    return data.id;
  }

  async function createInvitation(landlord: any, residenceId: string) {
    const { data, error } = await getClient(landlord).rpc('create_lease_invitation', {
      p_residence_id: residenceId,
    });

    if (error) throw error;
    if (!data?.token || data.token.length !== 64) {
      throw new Error('Invalid invitation token');
    }

    return data as {
      invitation_id: string;
      token: string;
      expires_at: string;
    };
  }

  it('stores only a SHA-256 token hash and denies raw table access', async () => {
    const residenceId = await createResidence(landlordA.user.id);
    const invitation = await createInvitation(landlordA, residenceId);

    expect(invitation.token).toMatch(/^[0-9a-f]{64}$/i);
    expect(new Date(invitation.expires_at).getTime()).toBeGreaterThan(Date.now());

    const { data: stored, error: storedError } = await supabaseAdmin
      .from('lease_invitations')
      .select('token_hash,status')
      .eq('id', invitation.invitation_id)
      .single();

    expect(storedError).toBeNull();
    expect(stored?.status).toBe('pending');
    expect(stored?.token_hash).toBe(createHash('sha256').update(invitation.token).digest('hex'));
    expect(stored?.token_hash).not.toBe(invitation.token);

    const { data: rawTenant, error: rawTenantError } = await getClient(tenantA)
      .from('lease_invitations')
      .select('*')
      .limit(1);
    expect(rawTenantError).toBeDefined();
    expect(rawTenant).toBeNull();

    const { data: rawLandlord, error: rawLandlordError } = await getClient(landlordA)
      .from('lease_invitations')
      .select('*')
      .limit(1);
    expect(rawLandlordError).toBeDefined();
    expect(rawLandlord).toBeNull();

    const { data: rawAnon, error: rawAnonError } = await supabaseAnon
      .from('lease_invitations')
      .select('*')
      .limit(1);
    expect(rawAnonError).toBeDefined();
    expect(rawAnon).toBeNull();
  });

  it('allows only the owner landlord to generate and keeps one pending link', async () => {
    const residenceId = await createResidence(landlordA.user.id);

    const { error: crossOwnerError } = await getClient(landlordB).rpc('create_lease_invitation', {
      p_residence_id: residenceId,
    });
    expect(crossOwnerError).toBeDefined();

    const first = await createInvitation(landlordA, residenceId);
    const second = await createInvitation(landlordA, residenceId);
    expect(second.invitation_id).not.toBe(first.invitation_id);

    const { data: states, error } = await supabaseAdmin
      .from('lease_invitations')
      .select('id,status')
      .eq('residence_id', residenceId)
      .order('created_at', { ascending: true });

    expect(error).toBeNull();
    expect(states?.map((row) => row.status)).toEqual(['revoked', 'pending']);
  });

  it('landlord listing returns metadata only, never the secret token', async () => {
    const residenceId = await createResidence(landlordA.user.id);
    await createInvitation(landlordA, residenceId);

    const { data, error } = await getClient(landlordA).rpc('list_my_lease_invitations', {
      p_residence_id: residenceId,
    });

    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    expect(JSON.stringify(data)).not.toContain('token');
  });

  it('tenant can inspect and accept; the accepted tenant becomes lease-eligible', async () => {
    const residenceId = await createResidence(landlordA.user.id);
    const invitation = await createInvitation(landlordA, residenceId);

    const { data: details, error: detailsError } = await getClient(tenantA).rpc('get_lease_invitation', {
      p_token: invitation.token,
    });
    expect(detailsError).toBeNull();
    expect(details?.residence?.id).toBe(residenceId);
    expect(details?.residence?.price_monthly).toBe(100000);

    const { data: accepted, error: acceptError } = await getClient(tenantA).rpc('accept_lease_invitation', {
      p_token: invitation.token,
    });
    expect(acceptError).toBeNull();
    expect(accepted?.residence_id).toBe(residenceId);

    const { data: tenants, error: tenantsError } = await getClient(landlordA).rpc('list_tenants');
    expect(tenantsError).toBeNull();
    expect(tenants).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: tenantA.user.id })]),
    );

    const { data: notification, error: notificationError } = await getClient(landlordA)
      .from('notifications')
      .select('type,data')
      .eq('user_id', landlordA.user.id)
      .eq('type', 'lease')
      .contains('data', { kind: 'lease_invitation_accepted' })
      .limit(1)
      .maybeSingle();

    expect(notificationError).toBeNull();
    expect(notification?.type).toBe('lease');
    expect(notification?.data).toMatchObject({
      kind: 'lease_invitation_accepted',
      residence_id: residenceId,
    });

    const { error: secondInvitationError } = await getClient(landlordA).rpc('create_lease_invitation', {
      p_residence_id: residenceId,
    });
    expect(secondInvitationError).toBeDefined();

    const { data: acceptedRows, error: acceptedRowsError } = await supabaseAdmin
      .from('lease_invitations')
      .select('status,accepted_by')
      .eq('residence_id', residenceId);

    expect(acceptedRowsError).toBeNull();
    expect(acceptedRows).toEqual([
      expect.objectContaining({
        status: 'accepted',
        accepted_by: tenantA.user.id,
      }),
    ]);

    const { error: secondAcceptError } = await getClient(tenantA).rpc('accept_lease_invitation', {
      p_token: invitation.token,
    });
    expect(secondAcceptError).toBeDefined();
  });

  it('lets the owner cancel an accepted invitation before lease creation', async () => {
    const residenceId = await createResidence(landlordA.user.id);
    const invitation = await createInvitation(landlordA, residenceId);

    const { error: acceptError } = await getClient(tenantA).rpc('accept_lease_invitation', {
      p_token: invitation.token,
    });
    expect(acceptError).toBeNull();

    const { error: revokeError } = await getClient(landlordA).rpc('revoke_lease_invitation', {
      p_invitation_id: invitation.invitation_id,
    });
    expect(revokeError).toBeNull();

    const { data: revokedRow, error: revokedRowError } = await supabaseAdmin
      .from('lease_invitations')
      .select('status,accepted_by,accepted_at,revoked_at')
      .eq('id', invitation.invitation_id)
      .single();

    expect(revokedRowError).toBeNull();
    expect(revokedRow).toMatchObject({
      status: 'revoked',
      accepted_by: null,
      accepted_at: null,
    });
    expect(revokedRow?.revoked_at).toBeTruthy();

    const { error: acceptAgainError } = await getClient(tenantA).rpc('accept_lease_invitation', {
      p_token: invitation.token,
    });
    expect(acceptAgainError).toBeDefined();

    const { data: notification, error: notificationError } = await getClient(tenantA)
      .from('notifications')
      .select('type,data')
      .eq('user_id', tenantA.user.id)
      .eq('type', 'lease')
      .contains('data', { kind: 'lease_invitation_revoked' })
      .limit(1)
      .maybeSingle();

    expect(notificationError).toBeNull();
    expect(notification?.data).toMatchObject({
      kind: 'lease_invitation_revoked',
      invitation_id: invitation.invitation_id,
      residence_id: residenceId,
    });
  });

  it('requires the invitation link before creating a lease when no conversation exists', async () => {
    const residenceId = await createResidence(landlordA.user.id);

    const { data: unrelatedLease, error: unrelatedError } = await getClient(landlordA).rpc('create_lease', {
      p_residence_id: residenceId,
      p_tenant_id: tenantA.user.id,
      p_start_date: formatLocalDate(),
      p_monthly_rent: 100000,
      p_deposit: 200000,
    });
    expect(unrelatedError).toBeDefined();
    expect(unrelatedLease).toBeNull();

    const invitation = await createInvitation(landlordA, residenceId);
    const { error: acceptError } = await getClient(tenantA).rpc('accept_lease_invitation', {
      p_token: invitation.token,
    });
    expect(acceptError).toBeNull();

    const { data: leaseId, error: leaseError } = await getClient(landlordA).rpc('create_lease', {
      p_residence_id: residenceId,
      p_tenant_id: tenantA.user.id,
      p_start_date: formatLocalDate(),
      p_monthly_rent: 100000,
      p_deposit: 200000,
    });
    expect(leaseError).toBeNull();
    expect(leaseId).toBeDefined();

    const { data: consumedRow, error: consumedError } = await supabaseAdmin
      .from('lease_invitations')
      .select('status,accepted_by,accepted_at')
      .eq('id', invitation.invitation_id)
      .single();

    expect(consumedError).toBeNull();
    expect(consumedRow).toMatchObject({
      status: 'consumed',
      accepted_by: tenantA.user.id,
    });
    expect(consumedRow?.accepted_at).toBeTruthy();
  });

  it('revoked and expired invitations cannot be used', async () => {
    const revokedResidence = await createResidence(landlordA.user.id);
    const revoked = await createInvitation(landlordA, revokedResidence);

    const { error: revokeError } = await getClient(landlordA).rpc('revoke_lease_invitation', {
      p_invitation_id: revoked.invitation_id,
    });
    expect(revokeError).toBeNull();

    const { error: revokedAcceptError } = await getClient(tenantA).rpc('accept_lease_invitation', {
      p_token: revoked.token,
    });
    expect(revokedAcceptError).toBeDefined();

    const expiredResidence = await createResidence(landlordA.user.id);
    const expired = await createInvitation(landlordA, expiredResidence);

    const { error: forceExpireError } = await supabaseAdmin
      .from('lease_invitations')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', expired.invitation_id);

    expect(forceExpireError).toBeNull();

    const { error: expiredGetError } = await getClient(tenantA).rpc('get_lease_invitation', {
      p_token: expired.token,
    });
    expect(expiredGetError).toBeDefined();

    const { error: expiredAcceptError } = await getClient(tenantA).rpc('accept_lease_invitation', {
      p_token: expired.token,
    });
    expect(expiredAcceptError).toBeDefined();
  });

  it('blocks tenant listing/revocation and cross-landlord revocation', async () => {
    const residenceId = await createResidence(landlordA.user.id);
    const invitation = await createInvitation(landlordA, residenceId);

    const { error: tenantListError } = await getClient(tenantA).rpc('list_my_lease_invitations', {
      p_residence_id: residenceId,
    });
    expect(tenantListError).toBeDefined();

    const { error: tenantRevokeError } = await getClient(tenantA).rpc('revoke_lease_invitation', {
      p_invitation_id: invitation.invitation_id,
    });
    expect(tenantRevokeError).toBeDefined();

    const { error: otherLandlordRevokeError } = await getClient(landlordB).rpc('revoke_lease_invitation', {
      p_invitation_id: invitation.invitation_id,
    });
    expect(otherLandlordRevokeError).toBeDefined();
  });

  it('does not allow a landlord to accept a tenant invitation', async () => {
    const residenceId = await createResidence(landlordA.user.id);
    const invitation = await createInvitation(landlordA, residenceId);

    const { error } = await getClient(landlordA).rpc('accept_lease_invitation', {
      p_token: invitation.token,
    });
    expect(error).toBeDefined();
  });
});
