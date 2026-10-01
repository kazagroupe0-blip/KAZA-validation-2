import { supabase } from '../supabase-client';
import type { Profile } from '../types';
import { ApiError, normalizeError } from '../supabase-api';
import { requireUser } from '../require-user';
import type { MomoProvider } from './account';
import { BENIN_PHONE_RE, normalizeBeninPhone } from '../phone';
import { resolveAuthIdentifier } from '../auth-identifier';

/** Valide un numéro de téléphone béninois : +229 suivi de 10 chiffres. */
function assertBeninPhone(phone: string): void {
  const cleaned = normalizeBeninPhone(phone);
  if (!BENIN_PHONE_RE.test(cleaned)) {
    throw new ApiError(400, 'Numéro invalide — format attendu : +229 01 00 00 00 00');
  }
}

export async function signIn(identifier: string, password: string, captchaToken: string): Promise<void> {
  const resolved = resolveAuthIdentifier(identifier);
  if (!resolved) {
    throw new ApiError(400, 'Saisissez un email ou un numéro de téléphone béninois valide.');
  }

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: resolved.value, password, captchaToken }),
  });
  const payload = (await res.json().catch(() => null)) as {
    error?: string;
    access_token?: string;
    refresh_token?: string;
    retryAfter?: number;
  } | null;

  if (!res.ok || !payload?.access_token || !payload.refresh_token) {
    if (res.status === 429) {
      throw new ApiError(
        429,
        'Trop de tentatives de connexion. Patientez quelques secondes avant de réessayer.',
      );
    }
    throw new ApiError(res.status, payload?.error ?? `Erreur ${res.status}`);
  }

  const { error } = await supabase.auth.setSession({
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
  });
  if (error) throw new ApiError(400, error.message);
}

export async function signInWithGoogle(): Promise<void> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
    },
  });
  if (error) throw new ApiError(400, error.message);
}

export async function signUp(
  input: {
    email: string;
    password: string;
    full_name: string;
    phone: string;
    role: 'locataire' | 'bailleur';
    consent_apdp: boolean;
  },
  captchaToken: string,
): Promise<{ needsEmailConfirmation: boolean }> {
  const normalizedPhone = normalizeBeninPhone(input.phone);
  assertBeninPhone(normalizedPhone);
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 2000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { data, error } = await supabase.auth.signUp({
      email: input.email,
      password: input.password,
      options: {
        captchaToken,
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        data: {
          full_name: input.full_name,
          phone: normalizedPhone,
          role: input.role,
          consent_apdp: input.consent_apdp,
        },
      },
    });

    if (!error) {
      if (!data.user) throw new ApiError(400, 'Inscription impossible');
      return { needsEmailConfirmation: !data.session };
    }

    const msg = (error.message ?? '').toLowerCase();
    const isRateLimit =
      error.status === 429 ||
      msg.includes('rate limit') ||
      msg.includes('too many requests') ||
      msg.includes('email rate') ||
      msg.includes('database error saving new user');

    if (isRateLimit && attempt < MAX_RETRIES - 1) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (isRateLimit) {
      throw new ApiError(
        429,
        'Trop de tentatives d\'inscription. Patientez quelques minutes avant de réessayer.',
      );
    }

    throw new ApiError(400, error.message);
  }

  throw new ApiError(400, 'Inscription impossible');
}

export async function requestOtp(phone: string, captchaToken: string): Promise<void> {
  const normalizedPhone = normalizeBeninPhone(phone);
  assertBeninPhone(normalizedPhone);
  const { error } = await supabase.auth.signInWithOtp({
    phone: normalizedPhone,
    options: { captchaToken },
  });
  if (error) throw new ApiError(400, error.message);
}

export async function verifyOtp(phone: string, token: string, captchaToken: string): Promise<void> {
  const normalizedPhone = normalizeBeninPhone(phone);
  assertBeninPhone(normalizedPhone);
  const { error } = await supabase.auth.verifyOtp({
    phone: normalizedPhone,
    token,
    type: 'sms',
    options: { captchaToken },
  });
  if (error) throw new ApiError(400, error.message);
}

export async function requestPasswordReset(
  email: string,
  captchaToken: string,
  redirectTo?: string,
): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    captchaToken,
    redirectTo: redirectTo ?? '/reset-password',
  });
  if (error) throw new ApiError(400, error.message);
}

export async function updatePassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new ApiError(400, error.message);
}

export async function requestPhoneChange(phone: string): Promise<void> {
  const user = await requireUser();
  const normalizedPhone = normalizeBeninPhone(phone);
  assertBeninPhone(normalizedPhone);

  const { error } = await supabase.auth.updateUser({ phone: normalizedPhone });
  if (error) throw new ApiError(400, error.message);

  if (!user.id) {
    throw new ApiError(401, 'Session invalide — reconnectez-vous');
  }
}

export async function verifyPhoneChange(phone: string, token: string): Promise<void> {
  const normalizedPhone = normalizeBeninPhone(phone);
  assertBeninPhone(normalizedPhone);

  const { error } = await supabase.auth.verifyOtp({
    phone: normalizedPhone,
    token,
    type: 'phone_change',
  });
  if (error) throw new ApiError(400, error.message);

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw normalizeError(authError, 'Session invalide après vérification');
  if (!authData.user || authData.user.phone !== normalizedPhone || !authData.user.phone_confirmed_at) {
    throw new ApiError(409, 'Le numéro n’a pas été confirmé. Recommencez la vérification.');
  }

  await updateProfile({ phone: normalizedPhone });
}


export async function getMyProfile(): Promise<Profile | null> {
  const user = await requireUser().catch(() => null);
  if (!user) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw normalizeError(error, 'Profil introuvable');
  return data;
}

export interface ProfileUpdateInput {
  full_name?: string;
  phone?: string | null;
  business_name?: string | null;
  tax_id?: string | null;
  momo_provider?: MomoProvider | null;
  momo_number?: string | null;
  bank_name?: string | null;
  bank_iban?: string | null;
}

export async function updateProfile(patch: ProfileUpdateInput): Promise<Profile> {
  const user = await requireUser();

  const payload = { ...patch };

  if (typeof payload.full_name === 'string') {
    payload.full_name = payload.full_name.trim();
  }

  if (typeof payload.phone === 'string') {
    const cleaned = normalizeBeninPhone(payload.phone);
    if (cleaned === '') {
      payload.phone = null;
    } else {
      assertBeninPhone(cleaned);
      payload.phone = cleaned;
    }
  }

  if (typeof payload.momo_number === 'string') {
    const cleaned = normalizeBeninPhone(payload.momo_number);
    if (cleaned === '') {
      payload.momo_number = null;
    } else {
      assertBeninPhone(cleaned);
      payload.momo_number = cleaned;
    }
  }

  if (payload.momo_provider !== undefined && payload.momo_provider !== null) {
    if (!['mtn', 'moov', 'celtiis'].includes(payload.momo_provider)) {
      throw new ApiError(400, 'Opérateur Mobile Money invalide');
    }
  }

  if (payload.momo_number && !payload.momo_provider) {
    const { data: current } = await supabase
      .from('profiles')
      .select('momo_provider')
      .eq('id', user.id)
      .maybeSingle();
    if (!current?.momo_provider) {
      throw new ApiError(400, 'Choisissez un opérateur Mobile Money avant d’enregistrer le numéro.');
    }
  }

  if ('business_name' in payload && typeof payload.business_name === 'string') {
    payload.business_name = payload.business_name.trim() || null;
  }
  if ('tax_id' in payload && typeof payload.tax_id === 'string') {
    payload.tax_id = payload.tax_id.trim() || null;
  }
  if ('bank_name' in payload && typeof payload.bank_name === 'string') {
    payload.bank_name = payload.bank_name.trim() || null;
  }
  if ('bank_iban' in payload && typeof payload.bank_iban === 'string') {
    payload.bank_iban = payload.bank_iban.replace(/\s+/g, '').trim() || null;
  }

  const { error } = await supabase
    .from('profiles')
    .update(payload)
    .eq('id', user.id);
  if (error) throw normalizeError(error, 'Mise à jour impossible');

  // Le workflow de complétude est porté par un trigger AFTER UPDATE.
  // Une clause RETURNING sur l'UPDATE initial peut donc refléter la ligne
  // avant le recalcul du champ onboarding_completed. Relire la ligne après
  // la transaction permet de retourner l'état réellement persisté.
  const { data: persisted, error: persistedError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();
  if (persistedError) throw normalizeError(persistedError, 'Profil introuvable après la mise à jour');
  if (!persisted) throw new ApiError(500, 'Profil introuvable après la mise à jour');
  return persisted;
}