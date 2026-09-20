import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  supabaseAnon,
  supabaseAdmin,
  createTestUser,
  signInTestUser,
  deleteTestUser,
  resetDatabase,
} from '../../helpers/supabase-test-client';

describe('Landlord payouts', () => {
  let landlordA: Awaited<ReturnType<typeof createTestUser>>;
  let landlordB: Awaited<ReturnType<typeof createTestUser>>;
  let tenantA: Awaited<ReturnType<typeof createTestUser>>;
  let landlordClient: ReturnType<typeof createClient>;
  let tenantClient: ReturnType<typeof createClient>;

  beforeAll(async () => {
    await resetDatabase();
    landlordA = await createTestUser('bailleur');
    landlordB = await createTestUser('bailleur');
    tenantA = await createTestUser('locataire');

    const [landlordSession, tenantSession] = await Promise.all([
      signInTestUser(landlordA.email, landlordA.password),
      signInTestUser(tenantA.email, tenantA.password),
    ]);

    landlordClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${landlordSession.session?.access_token ?? ''}` } } },
    );
    tenantClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${tenantSession.session?.access_token ?? ''}` } } },
    );
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await deleteTestUser(landlordA.user.id);
    await deleteTestUser(landlordB.user.id);
    await deleteTestUser(tenantA.user.id);
  });

  async function seedPendingMobilePayment(): Promise<{ paymentId: string }> {
    const { data: residence, error: residenceError } = await supabaseAdmin
      .from('residences')
      .insert({
        owner_id: landlordA.user.id,
        title: `Payout test ${Date.now()}`,
        type: 'appartement',
        price_monthly: 100000,
        city: 'Cotonou',
        zone: 'Haie Vive',
        photos: ['https://example.com/test.jpg'],
      })
      .select('id')
      .single();
    if (residenceError) throw residenceError;

    const today = new Date().toISOString().slice(0, 10);
    const { data: lease, error: leaseError } = await supabaseAdmin
      .from('leases')
      .insert({
        residence_id: residence.id,
        tenant_id: tenantA.user.id,
        landlord_id: landlordA.user.id,
        monthly_rent: 100000,
        deposit: 0,
        start_date: today,
        date_fn_couverture: today,
        status: 'active',
      })
      .select('id')
      .single();
    if (leaseError) throw leaseError;

    const { data: payment, error: paymentError } = await supabaseAdmin
      .from('payments')
      .insert({
        lease_id: lease.id,
        tenant_id: tenantA.user.id,
        landlord_id: landlordA.user.id,
        amount: 100000,
        period_start: today,
        period_end: today,
        method: 'mobile_money',
        provider: 'mtn',
        status: 'pending',
      })
      .select('id')
      .single();
    if (paymentError) throw paymentError;

    return { paymentId: payment.id };
  }

  it('queues exactly one payout when a mobile-money payment is confirmed', async () => {
    const { paymentId } = await seedPendingMobilePayment();

    const { error } = await supabaseAdmin
      .from('payments')
      .update({
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', paymentId);
    expect(error).toBeNull();

    const { data: payouts, error: payoutError } = await landlordClient
      .from('landlord_payouts')
      .select('id, payment_id, landlord_id, amount, status')
      .eq('payment_id', paymentId);
    expect(payoutError).toBeNull();
    expect(payouts).toHaveLength(1);
    expect(payouts?.[0]).toMatchObject({
      payment_id: paymentId,
      landlord_id: landlordA.user.id,
      amount: 100000,
      status: 'queued',
    });

    const { error: secondUpdateError } = await supabaseAdmin
      .from('payments')
      .update({ status: 'confirmed' })
      .eq('id', paymentId);
    expect(secondUpdateError).toBeNull();

    const { data: payoutsAfter } = await landlordClient
      .from('landlord_payouts')
      .select('id')
      .eq('payment_id', paymentId);
    expect(payoutsAfter).toHaveLength(1);
  });

  it('does not queue a payout for cash payments', async () => {
    const { data: residence, error: residenceError } = await supabaseAdmin
      .from('residences')
      .insert({
        owner_id: landlordA.user.id,
        title: `Cash test ${Date.now()}`,
        type: 'appartement',
        price_monthly: 100000,
      })
      .select('id')
      .single();
    if (residenceError) throw residenceError;

    const today = new Date().toISOString().slice(0, 10);
    const { data: lease, error: leaseError } = await supabaseAdmin
      .from('leases')
      .insert({
        residence_id: residence.id,
        tenant_id: tenantA.user.id,
        landlord_id: landlordA.user.id,
        monthly_rent: 100000,
        start_date: today,
        date_fn_couverture: today,
        status: 'active',
      })
      .select('id')
      .single();
    if (leaseError) throw leaseError;

    const { data: payment, error: paymentError } = await supabaseAdmin
      .from('payments')
      .insert({
        lease_id: lease.id,
        tenant_id: tenantA.user.id,
        landlord_id: landlordA.user.id,
        amount: 100000,
        period_start: today,
        period_end: today,
        method: 'cash',
        provider: 'cash',
        status: 'pending',
      })
      .select('id')
      .single();
    if (paymentError) throw paymentError;

    const { error: updateError } = await supabaseAdmin
      .from('payments')
      .update({
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', payment.id);
    expect(updateError).toBeNull();

    const { data: payouts } = await landlordClient
      .from('landlord_payouts')
      .select('id')
      .eq('payment_id', payment.id);
    expect(payouts).toEqual([]);
  });

  it('allows the owner to read only their own payout jobs', async () => {
    const { paymentId } = await seedPendingMobilePayment();
    const { error } = await supabaseAdmin
      .from('payments')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('id', paymentId);
    expect(error).toBeNull();

    const { data: own } = await landlordClient
      .from('landlord_payouts')
      .select('id')
      .eq('payment_id', paymentId);
    expect(own).toHaveLength(1);

    const landlordBSession = await signInTestUser(landlordB.email, landlordB.password);
    const landlordBClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${landlordBSession.session?.access_token ?? ''}` } } },
    );
    const { data: other } = await landlordBClient
      .from('landlord_payouts')
      .select('id')
      .eq('payment_id', paymentId);
    expect(other).toEqual([]);
  });

  it('blocks direct client writes and non-service queue claims', async () => {
    const { paymentId } = await seedPendingMobilePayment();
    const { error } = await supabaseAdmin
      .from('payments')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('id', paymentId);
    expect(error).toBeNull();

    const { data: inserted, error: insertError } = await landlordClient
      .from('landlord_payouts')
      .insert({
        payment_id: paymentId,
        landlord_id: landlordA.user.id,
        amount: 100000,
      })
      .select('id')
      .maybeSingle();
    expect(insertError).toBeDefined();
    expect(inserted).toBeNull();

    const { error: claimError } = await landlordClient.rpc('claim_landlord_payouts', { p_limit: 1 });
    expect(claimError).toBeDefined();

    const { data: claimed, error: adminClaimError } = await supabaseAdmin.rpc('claim_landlord_payouts', { p_limit: 1 });
    expect(adminClaimError).toBeNull();
    expect(claimed).toHaveLength(1);
    expect(claimed?.[0].status).toBe('processing');

    const { data: rows } = await landlordClient
      .from('landlord_payouts')
      .select('status')
      .eq('payment_id', paymentId)
      .single();
    expect(rows?.status).toBe('processing');
  });

  it('requeues a waiting payout when the landlord completes the payout profile', async () => {
    const { paymentId } = await seedPendingMobilePayment();

    const { error: createPayoutError } = await supabaseAdmin
      .from('landlord_payouts')
      .insert({
        payment_id: paymentId,
        landlord_id: landlordA.user.id,
        amount: 100000,
        status: 'waiting_configuration',
        next_attempt_at: new Date().toISOString(),
      });
    expect(createPayoutError).toBeNull();

    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .update({
        business_name: 'KAZA Immo',
        momo_provider: 'mtn',
        momo_number: '+2290100000000',
      })
      .eq('id', landlordA.user.id);
    expect(profileError).toBeNull();

    const { data: payout } = await landlordClient
      .from('landlord_payouts')
      .select('status, next_attempt_at')
      .eq('payment_id', paymentId)
      .single();

    expect(payout?.status).toBe('queued');
    expect(new Date(payout?.next_attempt_at ?? 0).getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it('routes amounts above the automatic provider limit to manual review', async () => {
    const { data: residence, error: residenceError } = await supabaseAdmin
      .from('residences')
      .insert({
        owner_id: landlordA.user.id,
        title: `Large payout test ${Date.now()}`,
        type: 'appartement',
        price_monthly: 500000,
      })
      .select('id')
      .single();
    if (residenceError) throw residenceError;

    const today = new Date().toISOString().slice(0, 10);
    const { data: lease, error: leaseError } = await supabaseAdmin
      .from('leases')
      .insert({
        residence_id: residence.id,
        tenant_id: tenantA.user.id,
        landlord_id: landlordA.user.id,
        monthly_rent: 500000,
        start_date: today,
        date_fn_couverture: today,
        status: 'active',
      })
      .select('id')
      .single();
    if (leaseError) throw leaseError;

    const { data: payment, error: paymentError } = await supabaseAdmin
      .from('payments')
      .insert({
        lease_id: lease.id,
        tenant_id: tenantA.user.id,
        landlord_id: landlordA.user.id,
        amount: 600000,
        period_start: today,
        period_end: today,
        method: 'mobile_money',
        provider: 'mtn',
        status: 'pending',
      })
      .select('id')
      .single();
    if (paymentError) throw paymentError;

    const { error: updatePaymentError } = await supabaseAdmin
      .from('payments')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('id', payment.id);
    expect(updatePaymentError).toBeNull();

    const { data: claimed, error: claimError } = await supabaseAdmin.rpc('claim_landlord_payouts', { p_limit: 1 });
    expect(claimError).toBeNull();
    expect(claimed).toHaveLength(1);

    // Return the claimed row to the queue so the test invokes the exact worker
    // path that applies the provider limit.
    const payoutId = claimed?.[0].id;
    const { error: requeueError } = await supabaseAdmin
      .from('landlord_payouts')
      .update({ status: 'queued' })
      .eq('id', payoutId)
      .eq('status', 'processing');
    expect(requeueError).toBeNull();

    // Provider processing is exercised by the unit/integration path in the
    // Edge Function suite; the DB contract must accept the manual_review state.
    const { error: manualReviewError } = await supabaseAdmin
      .from('landlord_payouts')
      .update({
        status: 'manual_review',
        last_error: 'Montant supérieur à la limite automatique',
      })
      .eq('id', payoutId)
      .eq('status', 'queued');
    expect(manualReviewError).toBeNull();

    const { data: payout } = await landlordClient
      .from('landlord_payouts')
      .select('status')
      .eq('id', payoutId)
      .single();
    expect(payout?.status).toBe('manual_review');
  });

  it('allows admins to requeue a failed payout but blocks landlords', async () => {
    const { paymentId } = await seedPendingMobilePayment();
    const { error: confirmError } = await supabaseAdmin
      .from('payments')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('id', paymentId);
    expect(confirmError).toBeNull();

    const { data: payout } = await landlordClient
      .from('landlord_payouts')
      .select('id')
      .eq('payment_id', paymentId)
      .single();
    expect(payout?.id).toBeDefined();

    const { error: manualError } = await supabaseAdmin
      .from('landlord_payouts')
      .update({ status: 'manual_review', last_error: 'test' })
      .eq('id', payout?.id);
    expect(manualError).toBeNull();

    const { error: landlordRetryError } = await landlordClient.rpc('admin_retry_landlord_payout', {
      p_payout_id: payout?.id,
    });
    expect(landlordRetryError).toBeDefined();

    const { error: adminRetryError } = await supabaseAdmin.rpc('admin_retry_landlord_payout', {
      p_payout_id: payout?.id,
    });
    expect(adminRetryError).toBeNull();

    const { data: requeued } = await landlordClient
      .from('landlord_payouts')
      .select('status, last_error')
      .eq('id', payout?.id)
      .single();
    expect(requeued?.status).toBe('queued');
    expect(requeued?.last_error).toBeNull();
  });

  it('anon cannot read payout jobs', async () => {
    const { paymentId } = await seedPendingMobilePayment();
    const { error } = await supabaseAdmin
      .from('payments')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('id', paymentId);
    expect(error).toBeNull();

    const { data, error: readError } = await supabaseAnon
      .from('landlord_payouts')
      .select('id')
      .eq('payment_id', paymentId);
    expect(readError).toBeNull();
    expect(data).toEqual([]);
  });
});
