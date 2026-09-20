import { getAdminClient } from '../_shared/db.ts';
import { unwrapFedapay } from '../_shared/fedapay.ts';

const API_BASE = Deno.env.get('FEDAPAY_API_BASE');
const SECRET_KEY = Deno.env.get('FEDAPAY_SECRET_KEY');
const PAYOUTS_ENABLED = Deno.env.get('PAYOUTS_ENABLED') === 'true';
const MAX_PAYOUT_AMOUNT = 500_000;

const PHONE_RE = /^\+229[0-9]{10}$/;
const PROVIDER_MODE: Record<string, string> = {
  mtn: 'mtn_open',
  moov: 'moov',
  celtiis: 'sbin',
};

async function getCronSecret(): Promise<string> {
  const envSecret = Deno.env.get('CRON_SECRET');
  if (envSecret) return envSecret;

  const supabase = getAdminClient();
  const { data: payoutSecret } = await supabase
    .from('_cron_secrets')
    .select('secret')
    .eq('name', 'landlord-payouts')
    .maybeSingle();
  if (payoutSecret?.secret) return payoutSecret.secret;

  const { data: fallbackSecret } = await supabase
    .from('_cron_secrets')
    .select('secret')
    .eq('name', 'overdue-cron')
    .maybeSingle();
  if (fallbackSecret?.secret) return fallbackSecret.secret;
  throw new Error('CRON_SECRET non défini');
}

function secretMatches(header: string | null, secret: string): boolean {
  if (!header || header.length !== secret.length) return false;
  const a = new TextEncoder().encode(header);
  const b = new TextEncoder().encode(secret);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
}

function customerParts(fullName: string): { firstname: string; lastname: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    firstname: parts[0] ?? 'KAZA',
    lastname: parts.slice(1).join(' ') || 'Proprietaire',
  };
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function notify(
  userId: string,
  title: string,
  body: string,
  payoutId: string,
): Promise<void> {
  const supabase = getAdminClient();
  await supabase.from('notifications').insert({
    user_id: userId,
    type: 'system',
    title,
    body,
    data: { kind: 'landlord_payout', payout_id: payoutId, href: '/landlord' },
  });
}

async function releaseWaitingConfiguration(
  payoutId: string,
  reason: string,
): Promise<void> {
  const supabase = getAdminClient();
  await supabase
    .from('landlord_payouts')
    .update({
      status: 'waiting_configuration',
      next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      last_error: reason,
    })
    .eq('id', payoutId)
    .eq('status', 'processing');
}

async function releaseRetry(
  payoutId: string,
  reason: string,
): Promise<void> {
  const supabase = getAdminClient();
  await supabase
    .from('landlord_payouts')
    .update({
      status: 'queued',
      next_attempt_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      last_error: reason,
    })
    .eq('id', payoutId)
    .eq('status', 'processing');
}

async function deferProviderLimit(
  payoutId: string,
  cleanPhone: string,
): Promise<void> {
  const supabase = getAdminClient();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await supabase
    .from('landlord_payouts')
    .select('created_at')
    .eq('recipient_phone', cleanPhone)
    .in('status', ['processing', 'sent'])
    .gte('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(3);

  const oldest = recent?.[0]?.created_at
    ? new Date(recent[0].created_at).getTime()
    : Date.now();

  await supabase
    .from('landlord_payouts')
    .update({
      status: 'queued',
      next_attempt_at: new Date(Math.max(Date.now() + 60 * 60 * 1000, oldest + 24 * 60 * 60 * 1000 + 5 * 60 * 1000)).toISOString(),
      last_error: 'Limite FedaPay de 3 reversements sur 24 h atteinte pour ce numéro',
    })
    .eq('id', payoutId)
    .eq('status', 'processing');
}

async function failPermanent(
  payoutId: string,
  reason: string,
): Promise<void> {
  const supabase = getAdminClient();
  await supabase
    .from('landlord_payouts')
    .update({
      status: 'failed',
      failed_at: new Date().toISOString(),
      last_error: reason,
    })
    .eq('id', payoutId)
    .eq('status', 'processing');
}

async function moveToManualReview(
  payoutId: string,
  reason: string,
): Promise<void> {
  const supabase = getAdminClient();
  await supabase
    .from('landlord_payouts')
    .update({
      status: 'manual_review',
      last_error: reason,
    })
    .eq('id', payoutId)
    .eq('status', 'processing');
}

async function processPayout(job: {
  id: string;
  payment_id: string;
  landlord_id: string;
  amount: number;
  recipient_provider: string | null;
  recipient_phone: string | null;
  provider_payout_id: string | null;
  provider_reference: string | null;
  provider_started_at: string | null;
}): Promise<void> {
  if (!API_BASE || !SECRET_KEY) {
    throw new Error('FedaPay payout non configuré');
  }

  const supabase = getAdminClient();
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('full_name, email, momo_provider, momo_number, onboarding_completed')
    .eq('id', job.landlord_id)
    .maybeSingle();

  if (profileError) throw profileError;

  if (!profile || profile.onboarding_completed !== true) {
    await releaseWaitingConfiguration(job.id, 'Profil propriétaire incomplet');
    return;
  }

  const provider = job.recipient_provider ?? profile.momo_provider;
  const phone = job.recipient_phone ?? profile.momo_number;

  if (!provider || !PROVIDER_MODE[provider] || !phone || !PHONE_RE.test(phone.replace(/\s+/g, ''))) {
    await releaseWaitingConfiguration(job.id, 'Coordonnées Mobile Money invalides');
    return;
  }

  const cleanPhone = phone.replace(/\s+/g, '');
  if (Number(job.amount) > MAX_PAYOUT_AMOUNT) {
    await supabase
      .from('landlord_payouts')
      .update({
        status: 'manual_review',
        last_error: `Montant ${job.amount} XOF supérieur à la limite automatique de ${MAX_PAYOUT_AMOUNT} XOF`,
      })
      .eq('id', job.id)
      .eq('status', 'processing');
    await notify(
      job.landlord_id,
      'Reversement à traiter',
      'Le montant de ce loyer dépasse la limite automatique de reversement Mobile Money. Le support KAZA doit le traiter.',
      job.id,
    );
    return;
  }
  // FedaPay limite les payouts à 3/24h vers un même numéro.
  // On déporte localement le quatrième au-delà de la fenêtre plutôt que de
  // solliciter inutilement le provider.
  const { count: recentCount } = await supabase
    .from('landlord_payouts')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_phone', cleanPhone)
    .in('status', ['processing', 'sent'])
    .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  if ((recentCount ?? 0) >= 3 && !job.provider_payout_id) {
    await deferProviderLimit(job.id, cleanPhone);
    return;
  }

  const name = customerParts(profile.full_name ?? '');
  let providerPayoutId = job.provider_payout_id;
  let providerStarted = Boolean(job.provider_started_at);

  // Reconcile an already-created payout before creating anything new. This
  // protects against worker/network crashes between provider and DB writes.
  if (providerPayoutId) {
    const inspectResponse = await fetchWithTimeout(`${API_BASE}/payouts/${providerPayoutId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${SECRET_KEY}` },
    });

    const inspectPayload = await inspectResponse.json().catch(() => null);
    const currentPayout = unwrapFedapay<{
      id?: number | string;
      reference?: string;
      status?: string;
    } | null>(inspectPayload);

    if (inspectResponse.ok && currentPayout?.status) {
      const state = String(currentPayout.status).toLowerCase();

      if (state === 'sent' || state === 'transferred' || state === 'completed') {
        await supabase
          .from('landlord_payouts')
          .update({
            status: 'sent',
            provider_reference: currentPayout.reference ?? job.provider_reference,
            sent_at: new Date().toISOString(),
            last_error: null,
          })
          .eq('id', job.id)
          .eq('status', 'processing');

        await notify(
          job.landlord_id,
          'Loyer envoyé',
          `${job.amount} FCFA ont été envoyés sur votre Mobile Money.`,
          job.id,
        );
        return;
      }

      if (state === 'failed' || state === 'declined' || state === 'canceled' || state === 'cancelled') {
        const message = `FedaPay payout statut: ${state}`;
        await failPermanent(job.id, message);
        await notify(job.landlord_id, 'Reversement échoué', message, job.id);
        return;
      }

      // A payout object already exists and is still pending/scheduled. Do not
      // create another object; continue with start only when necessary.
      if (state === 'pending' || state === 'scheduled') {
        providerStarted = providerStarted || state === 'scheduled';
      }
    } else if (!inspectResponse.ok && isRetryable(inspectResponse.status)) {
      await releaseRetry(job.id, `FedaPay get payout HTTP ${inspectResponse.status}`);
      return;
    }
  }

  if (!providerPayoutId) {
    const createBody = {
      amount: Math.round(Number(job.amount)),
      currency: { iso: 'XOF' },
      mode: PROVIDER_MODE[provider],
      customer: {
        firstname: name.firstname,
        lastname: name.lastname,
        email: profile.email ?? '',
        phone_number: {
          number: cleanPhone,
          country: 'bj',
        },
      },
    };

    const response = await fetchWithTimeout(`${API_BASE}/payouts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createBody),
    });

    const payload = await response.json().catch(() => null);
    const payout = unwrapFedapay<{ id?: number | string; reference?: string } | null>(payload);

    if (!response.ok || !payout?.id) {
      const message = `FedaPay create payout HTTP ${response.status}`;
      if (isRetryable(response.status)) {
        await releaseRetry(job.id, message);
      } else {
        await moveToManualReview(job.id, message);
        await notify(job.landlord_id, 'Reversement à traiter', message, job.id);
      }
      return;
    }

    providerPayoutId = String(payout.id);

    const { error: saveError } = await supabase
      .from('landlord_payouts')
      .update({
        recipient_provider: provider,
        recipient_phone: cleanPhone,
        provider_payout_id: providerPayoutId,
        provider_reference: payout.reference ?? null,
        last_error: null,
      })
      .eq('id', job.id)
      .eq('status', 'processing');

    if (saveError) {
      const reconciliationMessage = `ID FedaPay ${providerPayoutId} créé mais non enregistré localement. Réconciliation manuelle requise.`;
      await moveToManualReview(job.id, reconciliationMessage);
      await notify(
        job.landlord_id,
        'Reversement à vérifier',
        reconciliationMessage,
        job.id,
      );
      return;
    }
  }

  // If the provider object is already scheduled, don't call start again.
  if (!providerStarted) {
    const startResponse = await fetchWithTimeout(`${API_BASE}/payouts/start`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payouts: [{ id: providerPayoutId }] }),
    });

    if (!startResponse.ok) {
      const message = `FedaPay start payout HTTP ${startResponse.status}`;
      if (isRetryable(startResponse.status)) {
        await releaseRetry(job.id, message);
      } else {
        await moveToManualReview(job.id, message);
        await notify(job.landlord_id, 'Reversement à traiter', message, job.id);
      }
      return;
    }

    await supabase
      .from('landlord_payouts')
      .update({
        provider_started_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('id', job.id)
      .eq('status', 'processing');
  }

  // The provider may still be settling the payout. Keep it processing and let
  // the next cron pass reconcile the final status instead of claiming success
  // prematurely.
  const finalCheck = await fetchWithTimeout(`${API_BASE}/payouts/${providerPayoutId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${SECRET_KEY}` },
  });

  const finalPayload = await finalCheck.json().catch(() => null);
  const finalPayout = unwrapFedapay<{ status?: string; reference?: string } | null>(finalPayload);
  const finalState = String(finalPayout?.status ?? '').toLowerCase();

  if (finalCheck.ok && (finalState === 'sent' || finalState === 'transferred' || finalState === 'completed')) {
    await supabase
      .from('landlord_payouts')
      .update({
        status: 'sent',
        provider_reference: finalPayout?.reference ?? null,
        sent_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('id', job.id)
      .eq('status', 'processing');

    await notify(
      job.landlord_id,
      'Loyer envoyé',
      `${job.amount} FCFA ont été envoyés sur votre Mobile Money.`,
      job.id,
    );
    return;
  }

  if (finalCheck.ok && (finalState === 'failed' || finalState === 'declined' || finalState === 'canceled' || finalState === 'cancelled')) {
    const message = `FedaPay payout statut: ${finalState}`;
    await failPermanent(job.id, message);
    await notify(job.landlord_id, 'Reversement échoué', message, job.id);
  }
}
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const secret = await getCronSecret();
    if (!secretMatches(req.headers.get('x-cron-secret'), secret)) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Production kill-switch: the queue can accumulate safely while the
    // merchant requests FedaPay Payout activation. No provider call occurs
    // until PAYOUTS_ENABLED=true.
    if (!PAYOUTS_ENABLED) {
      return new Response(JSON.stringify({ enabled: false, claimed: 0, processed: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const supabase = getAdminClient();
    const { data: jobs, error } = await supabase.rpc('claim_landlord_payouts', { p_limit: 10 });
    if (error) throw error;

    let processed = 0;
    let errors = 0;

    for (const job of (jobs ?? []) as typeof jobs) {
      try {
        await processPayout(job);
        processed++;
      } catch (error) {
        errors++;
        console.error('Erreur payout', job.id, error);
        await releaseRetry(job.id, error instanceof Error ? error.message : 'Erreur inconnue');
      }
    }

    return new Response(JSON.stringify({ claimed: jobs?.length ?? 0, processed, errors }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Erreur landlord-payouts', error);
    return new Response('Internal error', { status: 500 });
  }
});
