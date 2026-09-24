import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { supabaseAnon, supabaseAdmin, createTestUser, signInTestUser, deleteTestUser, resetDatabase } from '../../helpers/supabase-test-client';
import { createClient } from '@supabase/supabase-js';

describe('RLS: leases, payments, receipts tables', () => {
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

  async function createPublishedVerifiedResidence(ownerId: string): Promise<string> {
    const { data, error } = await supabaseAdmin.from('residences').insert({
      owner_id: ownerId,
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

  async function reportCashPaymentAndGetId(
    client: any,
    leaseId: string,
    amount: number,
    periodStart: string,
    periodEnd: string
  ): Promise<string> {
    const { error } = await client.rpc('report_cash_payment', {
      p_lease_id: leaseId,
      p_amount: amount,
      p_period_start: periodStart,
      p_period_end: periodEnd,
    });
    if (error) throw error;

    // report_cash_payment renvoie void. L'action testée (la déclaration) passe par le
    // client réel ci-dessus ; la récupération de l'identifiant est un détail technique
    // de setup, faite côté admin : l'état cible de prod (F-38/F-26) n'accorde PAS
    // SELECT sur payments à `authenticated`, le harness ne doit pas en dépendre.
    const { data: payments, error: queryError } = await supabaseAdmin
      .from('payments')
      .select('id')
      .eq('lease_id', leaseId)
      .eq('amount', amount)
      .eq('period_start', periodStart)
      .eq('period_end', periodEnd)
      .order('created_at', { ascending: false })
      .limit(1);
    if (queryError) throw queryError;
    if (!payments || payments.length === 0) {
      throw new Error('Payment not found after report_cash_payment');
    }
    return payments[0].id;
  }

  describe('leases SELECT', () => {
    it('tenant CAN see own lease', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const { data, error } = await getClient(tenantA).from('leases').select('*').eq('id', leaseId).single();
      expect(error).toBeNull();
      expect(data).toBeDefined();
    });

    it('landlord CAN see lease for their property', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const { data, error } = await getClient(landlordA).from('leases').select('*').eq('id', leaseId).single();
      expect(error).toBeNull();
      expect(data).toBeDefined();
    });

    it('tenant B CANNOT see tenant A lease', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const { data, error } = await getClient(tenantB).from('leases').select('*').eq('id', leaseId).single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('landlord B CANNOT see lease for landlord A property', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const { data, error } = await getClient(landlordB).from('leases').select('*').eq('id', leaseId).single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('anon CANNOT see any lease', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const { data, error } = await supabaseAnon.from('leases').select('*').eq('id', leaseId).single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('admin CAN see all leases', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const { data, error } = await getClient(adminUser).from('leases').select('*').eq('id', leaseId).single();
      expect(error).toBeNull();
      expect(data).toBeDefined();
    });
  });

  describe('leases INSERT', () => {
    it('landlord CAN create lease via RPC', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      expect(leaseId).toBeDefined();
    });

    it('tenant CANNOT create lease', async () => {
      const residenceId = await createPublishedVerifiedResidence(landlordA.user.id);
      await supabaseAdmin.rpc('admin_moderate_residence', { p_residence_id: residenceId, p_action: 'approve' });
      const { error } = await getClient(tenantA).rpc('create_lease', {
        p_residence_id: residenceId,
        p_tenant_id: tenantA.user.id,
        p_start_date: new Date().toISOString().split('T')[0],
        p_monthly_rent: 100000,
      });
      // create_lease lève pour un non-propriétaire : erreur réelle attendue (null est « défini »).
      expect(error).not.toBeNull();
    });
  });

  describe('payments SELECT', () => {
    it('tenant CAN see own payment', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const periodStart = new Date().toISOString().split('T')[0];
      const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const paymentId = await reportCashPaymentAndGetId(getClient(tenantA), leaseId, 100000, periodStart, periodEnd);
      const { data, error } = await getClient(tenantA).from('payments').select('*').eq('id', paymentId).single();
      expect(error).toBeNull();
      expect(data).toBeDefined();
    });

    it('landlord CAN see payment for their property', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const periodStart = new Date().toISOString().split('T')[0];
      const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const paymentId = await reportCashPaymentAndGetId(getClient(tenantA), leaseId, 100000, periodStart, periodEnd);
      const { data, error } = await getClient(landlordA).from('payments').select('*').eq('id', paymentId).single();
      expect(error).toBeNull();
      expect(data).toBeDefined();
    });

    it('tenant B CANNOT see tenant A payment', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const periodStart = new Date().toISOString().split('T')[0];
      const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const paymentId = await reportCashPaymentAndGetId(getClient(tenantA), leaseId, 100000, periodStart, periodEnd);
      const { data, error } = await getClient(tenantB).from('payments').select('*').eq('id', paymentId).single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('landlord B CANNOT see payment for landlord A property', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const periodStart = new Date().toISOString().split('T')[0];
      const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const paymentId = await reportCashPaymentAndGetId(getClient(tenantA), leaseId, 100000, periodStart, periodEnd);
      const { data, error } = await getClient(landlordB).from('payments').select('*').eq('id', paymentId).single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });

    it('anon CANNOT see any payment', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const periodStart = new Date().toISOString().split('T')[0];
      const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const paymentId = await reportCashPaymentAndGetId(getClient(tenantA), leaseId, 100000, periodStart, periodEnd);
      const { data, error } = await supabaseAnon.from('payments').select('*').eq('id', paymentId).single();
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });
  });

  describe('payments INSERT (cash payment)', () => {
    it('tenant CAN report cash payment for own lease', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const periodStart = new Date().toISOString().split('T')[0];
      const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const paymentId = await reportCashPaymentAndGetId(getClient(tenantA), leaseId, 100000, periodStart, periodEnd);
      expect(paymentId).toBeDefined();
    });

    it('tenant CANNOT report payment for other tenant lease', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const periodStart = new Date().toISOString().split('T')[0];
      const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const { error } = await getClient(tenantB).rpc('report_cash_payment', {
        p_lease_id: leaseId,
        p_amount: 100000,
        p_period_start: periodStart,
        p_period_end: periodEnd,
      });
      // report_cash_payment lève si l'appelant n'est pas le locataire du bail.
      expect(error).not.toBeNull();
    });

    it('tenant CANNOT inject amount mismatch (server validates)', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const periodStart = new Date().toISOString().split('T')[0];
      const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      // Try to report 1 FCFA on a 100000 FCFA/month lease
      const { error } = await getClient(tenantA).rpc('report_cash_payment', {
        p_lease_id: leaseId,
        p_amount: 1,
        p_period_start: periodStart,
        p_period_end: periodEnd,
      });
      // Should be blocked by amount validation trigger (0.5x–6x du loyer).
      expect(error).not.toBeNull();
    });

    it('tenant CANNOT inject confirmed status directly', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const periodStart = new Date().toISOString().split('T')[0];
      const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const { error } = await getClient(tenantA).from('payments').insert({
        lease_id: leaseId,
        tenant_id: tenantA.user.id,
        landlord_id: landlordA.user.id,
        amount: 100000,
        period_start: periodStart,
        period_end: periodEnd,
        method: 'cash',
        provider: 'cash',
        status: 'confirmed',
      });
      // Aucune policy INSERT sur payments (migration 999999) : l'INSERT direct doit être refusé,
      // pas seulement renvoyer un objet error « défini ».
      expect(error).not.toBeNull();
      // Invariant d'état : aucun paiement n'a été créé par ce chemin direct.
      const { count } = await supabaseAdmin
        .from('payments')
        .select('id', { count: 'exact', head: true })
        .eq('lease_id', leaseId);
      expect(count).toBe(0);
    });
  });

  describe('payments UPDATE', () => {
    it('tenant CANNOT confirm own payment', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const periodStart = new Date().toISOString().split('T')[0];
      const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const paymentId = await reportCashPaymentAndGetId(getClient(tenantA), leaseId, 100000, periodStart, periodEnd);
      // Le locataire n'est pas couvert par payments_update_landlord (USING landlord_id = auth.uid()) :
      // sous PostgREST/RLS l'UPDATE ne matche aucune ligne et NE renvoie PAS d'erreur.
      // L'invariant vérifiable est donc que le statut reste 'pending' (pas « error défini »).
      await getClient(tenantA).from('payments').update({ status: 'confirmed' }).eq('id', paymentId);
      const { data: after } = await supabaseAdmin.from('payments').select('status').eq('id', paymentId).single();
      expect(after?.status).toBe('pending');
    });

    it('landlord CANNOT confirm a payment without confirmed_at (incomplete update rejected)', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const periodStart = new Date().toISOString().split('T')[0];
      const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const paymentId = await reportCashPaymentAndGetId(getClient(tenantA), leaseId, 100000, periodStart, periodEnd);
      // Confirmer sans confirmed_at viole le garde payments_before_update_guard (« confirmed_at requis »).
      // Ce test était auparavant vide (aucune assertion). Invariant : l'update est refusé ET le paiement reste 'pending'.
      const { error } = await getClient(landlordA).from('payments').update({ status: 'confirmed' }).eq('id', paymentId);
      expect(error).not.toBeNull();
      const { data: after } = await supabaseAdmin.from('payments').select('status').eq('id', paymentId).single();
      expect(after?.status).toBe('pending');
    });

    // TEST DE CARACTÉRISATION du comportement actuel (F-01) — NE PAS lire comme un invariant.
    // Il documente que le bailleur peut aujourd'hui confirmer un paiement par UPDATE direct
    // (payments.ts:61-73). Après correction de F-01/F-26 (confirmation via RPC dédiée +
    // vérification de la collecte), ce test DOIT devenir négatif, avec pour invariant :
    //   - confirmation directe d'un paiement `mobile_money` par le bailleur → refusée (erreur) ;
    //   - statut inchangé (reste 'pending', relu côté admin) ;
    //   - aucun effet payout (aucune ligne landlord_payouts créée pour ce paiement).
    // Le paiement `mobile_money` pending devra alors être amorcé côté admin (setup).
    // Sous les grants cibles de prod (pas de SELECT sur payments), cet UPDATE filtré échoue
    // déjà (F-26) : le test sera rouge après convergence des grants, ce qui est attendu.
    // Comportement attendu volontairement inchangé dans ce lot.
    it('landlord CAN confirm payment via direct UPDATE (app pattern)', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const periodStart = new Date().toISOString().split('T')[0];
      const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const paymentId = await reportCashPaymentAndGetId(getClient(tenantA), leaseId, 100000, periodStart, periodEnd);
      const { error } = await getClient(landlordA)
        .from('payments')
        .update({
          status: 'confirmed',
          confirmed_at: new Date().toISOString(),
          confirmed_by: landlordA.user.id,
        })
        .eq('id', paymentId);
      // App uses direct UPDATE for confirmation (payments.ts:61-73)
      expect(error).toBeNull();
    });
  });

  describe('receipts SELECT', () => {
    it('tenant CAN see own receipt', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const periodStart = new Date().toISOString().split('T')[0];
      const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const paymentId = await reportCashPaymentAndGetId(getClient(tenantA), leaseId, 100000, periodStart, periodEnd);
      // Setup : confirmation faite côté admin. La propriété testée ici est la visibilité
      // de la quittance, pas l'autorisation de confirmer ; l'UPDATE filtré du bailleur
      // dépend d'un SELECT sur payments absent de l'état cible de prod (F-26).
      const { error: confirmErr } = await supabaseAdmin
        .from('payments')
        .update({
          status: 'confirmed',
          confirmed_at: new Date().toISOString(),
          confirmed_by: landlordA.user.id,
        })
        .eq('id', paymentId);
      expect(confirmErr).toBeNull();
      // La quittance est créée par le trigger sur pending→confirmed : elle DOIT exister
      // (l'ancien `if (length>0)` faisait passer le test à vide si le trigger ne se déclenchait pas).
      const { data: receipts } = await supabaseAdmin.from('receipts').select('id').eq('payment_id', paymentId);
      expect(receipts?.length).toBe(1);
      const { data, error } = await getClient(tenantA).from('receipts').select('*').eq('id', receipts![0].id).single();
      expect(error).toBeNull();
      expect(data).toBeDefined();
    });

    it('tenant B CANNOT see tenant A receipt', async () => {
      const { leaseId } = await createLease(landlordA, tenantA);
      const periodStart = new Date().toISOString().split('T')[0];
      const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const paymentId = await reportCashPaymentAndGetId(getClient(tenantA), leaseId, 100000, periodStart, periodEnd);
      // Setup côté admin (voir « tenant CAN see own receipt ») : la propriété testée est
      // l'isolation des quittances, pas l'autorisation de confirmer.
      const { error: confirmErr } = await supabaseAdmin
        .from('payments')
        .update({
          status: 'confirmed',
          confirmed_at: new Date().toISOString(),
          confirmed_by: landlordA.user.id,
        })
        .eq('id', paymentId);
      expect(confirmErr).toBeNull();
      // La quittance existe (trigger) ; le test ne doit pas être vacant.
      const { data: receipts } = await supabaseAdmin.from('receipts').select('id').eq('payment_id', paymentId);
      expect(receipts?.length).toBe(1);
      const { data, error } = await getClient(tenantB).from('receipts').select('*').eq('id', receipts![0].id).single();
      // SELECT filtré par RLS : le guard fort est data=null (une fuite ferait échouer cette assertion).
      expect(error).toBeDefined();
      expect(data).toBeNull();
    });
  });
});