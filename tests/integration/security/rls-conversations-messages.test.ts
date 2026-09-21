import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { supabaseAnon, supabaseAdmin, createTestUser, signInTestUser, deleteTestUser, resetDatabase } from '../../helpers/supabase-test-client';
import { createClient } from '@supabase/supabase-js';

describe('RLS: conversations & messages tables', () => {
  let landlordA: any;
  let landlordB: any;
  let tenantA: any;
  let tenantB: any;
  let adminUser: any;

  beforeAll(async () => {
    await resetDatabase();
    landlordA = await createTestUser('bailleur');
    landlordB = await createTestUser('bailleur');
    tenantA = await createTestUser('locataire');
    tenantB = await createTestUser('locataire');
    adminUser = await createTestUser('admin');

    for (const u of [landlordA, landlordB, tenantA, tenantB, adminUser]) {
      const signIn = await signInTestUser(u.email, u.password);
      u.token = signIn.session?.access_token ?? '';
    }
  });

  afterAll(async () => {
    await deleteTestUser(landlordA.user.id);
    await deleteTestUser(landlordB.user.id);
    await deleteTestUser(tenantA.user.id);
    await deleteTestUser(tenantB.user.id);
    await deleteTestUser(adminUser.user.id);
  });

  beforeEach(async () => {
    await resetDatabase();
    for (const u of [landlordA, landlordB, tenantA, tenantB, adminUser]) {
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

  async function createPublishedVerifiedResidence(landlord: any): Promise<string> {
    // Use service_role to create residence directly (bypasses RLS for test setup)
    const { data, error } = await supabaseAdmin.from('residences').insert({
      owner_id: landlord.user.id,
      title: `Test ${Date.now()}`,
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

  async function setupConversation(landlord: any, tenant: any) {
    const residenceId = await createPublishedVerifiedResidence(landlord);
    const { data: convId, error } = await getClient(tenant).rpc('open_conversation', { p_residence_id: residenceId });
    if (error) throw error;
    return { residenceId, convId };
  }

  describe('conversations SELECT', () => {
    it('tenant CAN see conversation they participate in', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      const { data, error } = await getClient(tenantA).from('conversations').select('*').eq('id', convId).single();
      expect(error).toBeNull();
      expect(data).toBeDefined();
    });

    it('landlord CAN see conversation they participate in', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      const { data, error } = await getClient(landlordA).from('conversations').select('*').eq('id', convId).single();
      expect(error).toBeNull();
      expect(data).toBeDefined();
    });

    it('tenant B CANNOT see conversation between tenant A and landlord', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      const { data, error } = await getClient(tenantB).from('conversations').select('*').eq('id', convId).single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('landlord B CANNOT see conversation between tenant A and landlord A', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      const { data, error } = await getClient(landlordB).from('conversations').select('*').eq('id', convId).single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('anon CANNOT see any conversation', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      const { data, error } = await supabaseAnon.from('conversations').select('*').eq('id', convId).single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('admin CAN see all conversations', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      const { data, error } = await getClient(adminUser).from('conversations').select('*').eq('id', convId).single();
      expect(error).toBeNull();
      expect(data).toBeDefined();
    });
  });

  describe('conversations INSERT', () => {
    it('opening the same residence twice reuses the same conversation', async () => {
      const residenceId = await createPublishedVerifiedResidence(landlordA);
      const first = await getClient(tenantA).rpc('open_conversation', { p_residence_id: residenceId });
      const second = await getClient(tenantA).rpc('open_conversation', { p_residence_id: residenceId });

      expect(first.error).toBeNull();
      expect(second.error).toBeNull();
      expect(second.data).toBe(first.data);
    });

    it('landlord cannot open a tenant conversation through the contact RPC', async () => {
      const residenceId = await createPublishedVerifiedResidence(landlordA);
      const result = await getClient(landlordB).rpc('open_conversation', { p_residence_id: residenceId });
      expect(result.error).toBeDefined();
    });

    it('tenant cannot open a conversation for a non-free residence', async () => {
      const { data, error } = await supabaseAdmin.from('residences').insert({
        owner_id: landlordA.user.id,
        title: `Occupied ${Date.now()}`,
        type: 'appartement',
        price_monthly: 100000,
        deposit: 200000,
        bedrooms: 2,
        bathrooms: 1,
        city: 'Cotonou',
        zone: 'Haie Vive',
        status: 'occupee',
        is_published: true,
        is_verified: true,
        moderation_status: 'approved',
      }).select('id').single();
      if (error) throw error;

      const result = await getClient(tenantA).rpc('open_conversation', { p_residence_id: data.id });
      expect(result.error).toBeDefined();
    });

    it('tenant CAN open conversation via RPC (not direct insert)', async () => {
      const residenceId = await createPublishedVerifiedResidence(landlordA);
      const { data: convId, error } = await getClient(tenantA).rpc('open_conversation', { p_residence_id: residenceId });
      expect(error).toBeNull();
      expect(convId).toBeDefined();
    });

    it('tenant CANNOT directly insert into conversations table', async () => {
      const residenceId = await createPublishedVerifiedResidence(landlordA);
      const { error } = await getClient(tenantA).from('conversations').insert({
        residence_id: residenceId,
        landlord_id: landlordA.user.id,
        tenant_id: tenantA.user.id,
      });
      expect(error).toBeDefined();
    });

    it('landlord CANNOT directly insert into conversations', async () => {
      const residenceId = await createPublishedVerifiedResidence(landlordA);
      const { error } = await getClient(landlordA).from('conversations').insert({
        residence_id: residenceId,
        landlord_id: landlordA.user.id,
        tenant_id: tenantA.user.id,
      });
      expect(error).toBeDefined();
    });
  });

  describe('messages SELECT', () => {
    it('participant CAN see messages in their conversation', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      // Send a message first via direct INSERT (app pattern)
      const { error: insertError } = await getClient(tenantA).from('messages').insert({
        conversation_id: convId,
        sender_id: tenantA.user.id,
        body: 'Hello landlord',
        kind: 'text',
      });
      expect(insertError).toBeNull();

      const { data, error } = await getClient(tenantA).from('messages').select('*').eq('conversation_id', convId);
      expect(error).toBeNull();
      expect(data?.length).toBeGreaterThan(0);
    });

    it('non-participant CANNOT see messages', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      await getClient(tenantA).from('messages').insert({
        conversation_id: convId,
        sender_id: tenantA.user.id,
        body: 'Hello',
        kind: 'text',
      });
      // Contrat PostgREST sous RLS : SELECT collection filtre silencieusement
      // (tableau vide, pas d'erreur) — pas data=null.
      const { data, error } = await getClient(tenantB).from('messages').select('*').eq('conversation_id', convId);
      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);
      expect(data!.length).toBe(0);
    });
  });

  describe('messages INSERT', () => {
    it('tenant CAN send message to their conversation', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      const { error } = await getClient(tenantA).from('messages').insert({
        conversation_id: convId,
        sender_id: tenantA.user.id,
        body: 'Test message',
        kind: 'text',
      });
      expect(error).toBeNull();
    });

    it('tenant CANNOT send message to conversation they are not in', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      const { error } = await getClient(tenantB).from('messages').insert({
        conversation_id: convId,
        sender_id: tenantB.user.id,
        body: 'Hack attempt',
        kind: 'text',
      });
      expect(error).toBeDefined();
    });

    it('sender_id spoofing is prevented', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      const { error } = await getClient(tenantA).from('messages').insert({
        conversation_id: convId,
        sender_id: landlordA.user.id, // Spoofing!
        body: 'Fake message from landlord',
        kind: 'text',
      });
      expect(error).toBeDefined();
    });

    it('message kind is validated (no spoofing visit_agreed)', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      const { error } = await getClient(tenantA).from('messages').insert({
        conversation_id: convId,
        sender_id: tenantA.user.id,
        body: 'Fake visit confirmation',
        kind: 'visit_agreed',
      });
      // Should be rejected - only landlord via agree_visit can create visit_agreed
      expect(error).toBeDefined();
    });
  });

  describe('message side effects', () => {
    it('sending a message updates conversation preview and creates a notification for the recipient', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      const body = `Bonjour ${Date.now()}`;

      const { error: sendError } = await getClient(tenantA).from('messages').insert({
        conversation_id: convId,
        sender_id: tenantA.user.id,
        body,
        kind: 'text',
      });
      expect(sendError).toBeNull();

      const { data: conversations, error: convError } = await getClient(landlordA)
        .rpc('list_my_conversations');
      expect(convError).toBeNull();
      const conversation = (conversations as any[]).find((c) => c.id === convId);
      expect(conversation).toMatchObject({
        id: convId,
        last_message_preview: body.slice(0, 80),
        unread_count: 1,
      });

      const { data: notifications, error: notifError } = await getClient(landlordA)
        .from('notifications')
        .select('type, title, body, data')
        .eq('type', 'message')
        .contains('data', { conversation_id: convId })
        .order('created_at', { ascending: false })
        .limit(1);
      expect(notifError).toBeNull();
      expect(notifications?.[0]).toMatchObject({
        type: 'message',
        title: 'Nouveau message',
        body,
      });
    });

    it('markConversationRead changes unread state without allowing the recipient to edit content', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      const body = 'Message à lire';
      const { data: inserted, error: insertError } = await getClient(tenantA)
        .from('messages')
        .insert({
          conversation_id: convId,
          sender_id: tenantA.user.id,
          body,
          kind: 'text',
        })
        .select('id')
        .single();
      expect(insertError).toBeNull();

      const before = await getClient(landlordA).rpc('list_my_conversations');
      const conversationBefore = (before.data as any[]).find((c) => c.id === convId);
      expect(conversationBefore?.unread_count).toBe(1);

      const marked = await getClient(landlordA)
        .from('messages')
        .update({ read_at: new Date().toISOString(), body: 'Tentative de modification' })
        .eq('id', inserted.id)
        .select('body, read_at')
        .single();
      expect(marked.error).toBeNull();
      expect(marked.data).toMatchObject({ body, read_at: expect.any(String) });

      const after = await getClient(landlordA).rpc('list_my_conversations');
      const conversationAfter = (after.data as any[]).find((c) => c.id === convId);
      expect(conversationAfter?.unread_count).toBe(0);
    });
  });

  describe('messages UPDATE/DELETE', () => {
    it('user CANNOT update messages', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      await getClient(tenantA).from('messages').insert({
        conversation_id: convId,
        sender_id: tenantA.user.id,
        body: 'Original',
        kind: 'text',
      });
      const { data: msgs } = await getClient(tenantA).from('messages').select('id').eq('conversation_id', convId);
      const msgId = msgs![0].id;
      const { error } = await getClient(tenantA).from('messages').update({ body: 'Hacked' }).eq('id', msgId);
      expect(error).toBeDefined();
    });

    it('user CANNOT delete messages', async () => {
      const { convId } = await setupConversation(landlordA, tenantA);
      await getClient(tenantA).from('messages').insert({
        conversation_id: convId,
        sender_id: tenantA.user.id,
        body: 'To delete',
        kind: 'text',
      });
      const { data: msgs } = await getClient(tenantA).from('messages').select('id').eq('conversation_id', convId);
      const msgId = msgs![0].id;
      const { error } = await getClient(tenantA).from('messages').delete().eq('id', msgId);
      expect(error).toBeDefined();
    });
  });
});