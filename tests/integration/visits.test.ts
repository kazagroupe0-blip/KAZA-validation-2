import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { supabaseAnon, supabaseAdmin, createTestUser, signInTestUser, deleteTestUser, resetDatabase } from '../helpers/supabase-test-client';
import { createClient } from '@supabase/supabase-js';
import { proposeVisit } from '@/lib/supabase-api';

describe('Visits: table & RLS', () => {
  let landlord: any;
  let tenant: any;

  beforeAll(async () => {
    await resetDatabase();
    landlord = await createTestUser('bailleur');
    tenant = await createTestUser('locataire');

    for (const u of [landlord, tenant]) {
      const signIn = await signInTestUser(u.email, u.password);
      u.token = signIn.session?.access_token ?? '';
      u.session = signIn.session;
    }
  });

  afterAll(async () => {
    await deleteTestUser(landlord.user.id);
    await deleteTestUser(tenant.user.id);
  });

  beforeEach(async () => {
    await resetDatabase();
    for (const u of [landlord, tenant]) {
      const signIn = await signInTestUser(u.email, u.password);
      u.token = signIn.session?.access_token ?? '';
      u.session = signIn.session;
    }
  });

  function getClient(user: any) {
    return createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${user.token}` } } }
    );
  }

  async function setupConversation() {
    const residenceId = await createPublishedVerifiedResidence(landlord.user.id);

    const { data: canonicalResidence, error: residenceError } = await supabaseAdmin
      .from('residences')
      .select('status, is_published, is_verified, moderation_status')
      .eq('id', residenceId)
      .single();
    if (residenceError) throw residenceError;
    expect(canonicalResidence).toMatchObject({
      status: 'libre',
      is_published: true,
      is_verified: true,
      moderation_status: 'approved',
    });

    const clientTenant = getClient(tenant);
    const { data: convId, error } = await clientTenant.rpc('open_conversation', {
      p_residence_id: residenceId,
    });
    if (error) throw error;
    return convId;
  }

  async function createPublishedVerifiedResidence(ownerId: string): Promise<string> {
    const { data, error } = await supabaseAdmin.from('residences').insert({
      owner_id: ownerId,
      title: `Test Residence ${Date.now()}`,
      description: 'Test',
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
    }).select('id').single();
    if (error) throw error;
    return data.id;
  }

  describe('INSERT policies', () => {
    it('tenant CAN insert visit (proposed status)', async () => {
      const clientTenant = getClient(tenant);
      const conversationId = await setupConversation();

      const slotStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
      slotStart.setMinutes(0, 0, 0);
      const slotEnd = new Date(slotStart.getTime() + 2 * 60 * 60 * 1000);

      const { data, error } = await clientTenant
        .from('visits')
        .insert({
          conversation_id: conversationId,
          proposed_by: tenant.user.id,
          slot_start: slotStart.toISOString(),
          slot_end: slotEnd.toISOString(),
          status: 'proposed',
        })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data).toBeDefined();
      expect(data?.conversation_id).toBe(conversationId);
      expect(data?.proposed_by).toBe(tenant.user.id);
      expect(data?.status).toBe('proposed');
    });
  });

  describe('RPC: confirm_visit', () => {
    it('landlord confirms slot', async () => {
      const clientLandlord = getClient(landlord);
      const conversationId = await setupConversation();

      // Create a proposed visit directly
      const slotStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
      slotStart.setMinutes(0, 0, 0);
      const slotEnd = new Date(slotStart.getTime() + 2 * 60 * 60 * 1000);

      const { data: visit, error: visitError } = await supabaseAdmin
        .from('visits')
        .insert({
          conversation_id: conversationId,
          proposed_by: tenant.user.id,
          slot_start: slotStart.toISOString(),
          slot_end: slotEnd.toISOString(),
          status: 'proposed',
        })
        .select()
        .single();

      expect(visitError).toBeNull();
      expect(visit).toBeDefined();

      // Landlord confirms the visit
      const { error: confirmError } = await clientLandlord.rpc('confirm_visit', {
        p_visit_id: visit.id,
        p_slot_index: 0,
      });

      expect(confirmError).toBeNull();

      // Verify visit is confirmed
      const { data: confirmedVisit, error: selectError } = await supabaseAdmin
        .from('visits')
        .select('status, confirmed_by')
        .eq('id', visit.id)
        .single();

      expect(selectError).toBeNull();
      expect(confirmedVisit?.status).toBe('confirmed');
      expect(confirmedVisit?.confirmed_by).toBe(landlord.user.id);
    });
  });

  describe('API: proposeVisit', () => {
    it('proposeVisit API', async () => {
      const conversationId = await setupConversation();

      // Client Node authentifié avec la vraie session du locataire :
      // aucun singleton navigateur, aucun mock et aucun bypass.
      const tenantClient = getClient(tenant);
      const slotStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
      slotStart.setMinutes(0, 0, 0);
      const slotEnd = new Date(slotStart.getTime() + 2 * 60 * 60 * 1000);

      const { data: stateBeforeProposal, error: stateError } = await supabaseAdmin
        .from('residences')
        .select('status, is_published, is_verified, moderation_status')
        .eq(
          'id',
          (await supabaseAdmin
            .from('conversations')
            .select('residence_id')
            .eq('id', conversationId)
            .single()).data?.residence_id,
        )
        .single();
      expect(stateError).toBeNull();
      expect(stateBeforeProposal).toMatchObject({
        status: 'libre',
        is_published: true,
        is_verified: true,
        moderation_status: 'approved',
      });

      const visitId = await proposeVisit(
        conversationId,
        [{ start: slotStart.toISOString(), end: slotEnd.toISOString() }],
        tenantClient,
      );
      expect(visitId).toBeDefined();

      const { data: visit, error: visitError } = await supabaseAdmin
        .from('visits')
        .select('conversation_id, proposed_by, status, slot_start, slot_end')
        .eq('id', visitId)
        .single();
      expect(visitError).toBeNull();
      expect(visit).toMatchObject({
        conversation_id: conversationId,
        proposed_by: tenant.user.id,
        status: 'proposed',
      });

      const { data: messages, error: messageError } = await supabaseAdmin
        .from('messages')
        .select('kind, body, sender_id')
        .eq('conversation_id', conversationId)
        .eq('kind', 'visit_request')
        .order('created_at', { ascending: false })
        .limit(1);
      expect(messageError).toBeNull();
      expect(messages?.[0]).toMatchObject({
        kind: 'visit_request',
        sender_id: tenant.user.id,
      });

      const { data: notifications, error: notificationError } = await supabaseAdmin
        .from('notifications')
        .select('type, title, data')
        .eq('user_id', landlord.user.id)
        .eq('type', 'visit')
        .contains('data', { conversation_id: conversationId })
        .order('created_at', { ascending: false })
        .limit(1);
      expect(notificationError).toBeNull();
      expect(notifications?.[0]).toMatchObject({
        type: 'visit',
        title: 'Nouvelle demande de visite',
      });
    });
  });
});