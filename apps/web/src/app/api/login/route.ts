import { NextResponse, type NextRequest } from 'next/server';
import { checkLoginAttempts } from '@/lib/rate-limit';
import { env } from '@/lib/env';
import { logger, getRequestId } from '@/lib/logger';
import { resolveAuthIdentifier } from '@/lib/auth-identifier';

export const runtime = 'nodejs';

function getClientIp(req: NextRequest): string {
  const fwd =
    req.headers.get('x-vercel-forwarded-for') ??
    req.headers.get('x-forwarded-for') ??
    req.headers.get('x-real-ip') ??
    '';
  const first = fwd.split(',')[0].trim();
  return first || 'unknown';
}

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const start = Date.now();

  const body = (await req.json().catch(() => null)) as
    | { identifier?: string; email?: string; password?: string; captchaToken?: string }
    | null;
  const rawIdentifier = (body?.identifier ?? body?.email ?? '').trim();
  const password = body?.password ?? '';
  const captchaToken = body?.captchaToken ?? '';
  const identifier = resolveAuthIdentifier(rawIdentifier);

  if (!identifier || !password) {
    logger.warn('login_validation_failed', {
      requestId,
      message: 'Invalid login identifier/password format',
      metadata: { identifier: rawIdentifier },
    });
    return NextResponse.json(
      { error: 'Email ou numéro de téléphone béninois invalide' },
      { status: 400 },
    );
  }

  const captchaRequired = Boolean(env.hcaptchaSitekey);
  if (captchaRequired && !captchaToken) {
    logger.warn('login_captcha_missing', {
      requestId,
      message: 'hCaptcha token required',
      metadata: { identifier: identifier.value },
    });
    return NextResponse.json(
      { error: 'Vérification anti-robot requise (hCaptcha)' },
      { status: 400 },
    );
  }

  const limit = await checkLoginAttempts({ identifier: identifier.value, ip: getClientIp(req) });
  if (!limit.allowed) {
    logger.warn('login_rate_limited', {
      requestId,
      message: 'Rate limit exceeded',
      metadata: { identifier: identifier.value, retry_after: limit.retryAfterSeconds },
    });
    return NextResponse.json(
      {
        error: 'Trop de tentatives de connexion. Patientez quelques secondes avant de réessayer.',
        retryAfter: limit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { 'Retry-After': String(limit.retryAfterSeconds) },
      },
    );
  }

  const supabaseUrl = env.supabaseUrl;
  const anonKey = env.supabaseAnonKey;
  if (!supabaseUrl || !anonKey) {
    logger.error('login_config_missing', { requestId, message: 'Supabase URL or anon key not configured' });
    return NextResponse.json({ error: 'Configuration serveur incomplète' }, { status: 503 });
  }

  try {
    const target = `${supabaseUrl}/auth/v1/token?grant_type=password`;
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify({
        ...(identifier.type === 'email' ? { email: identifier.value } : { phone: identifier.value }),
        password,
        ...(captchaToken ? { gotrue_meta_security: { captcha_token: captchaToken } } : {}),
      }),
    });
    const text = await res.text();
    const payload = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })() as {
      access_token?: string;
      refresh_token?: string;
      user?: unknown;
      error?: string;
      error_description?: string;
      msg?: string;
    } | null;

    if (!res.ok || !payload?.access_token) {
      const raw = payload?.error_description ?? payload?.msg ?? payload?.error ?? `Erreur ${res.status}`;
      const message = /invalid login credentials|invalid_credentials/i.test(raw)
        ? 'Identifiants invalides. Vérifiez votre email ou votre numéro et votre mot de passe.'
        : /phone.*not.*confirm|not.*confirm.*phone/i.test(raw)
          ? 'Ce numéro de téléphone n’est pas encore vérifié. Connectez-vous avec votre email puis vérifiez votre numéro dans Mon profil.'
          : raw;
      logger.warn('login_failed', {
        requestId,
        message,
        metadata: { identifier: identifier.value, status: res.status },
      });
      return NextResponse.json({ error: message }, { status: res.status === 400 ? 400 : res.status });
    }

    logger.info('login_success', { requestId, metadata: { identifier: identifier.value, duration_ms: Date.now() - start } });
    return NextResponse.json({
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      user: payload.user,
    });
  } catch (err) {
    logger.error('login_error', { requestId, error: err as Error, metadata: { identifier: identifier.value, duration_ms: Date.now() - start }, message: 'Service unavailable' });
    return NextResponse.json({ error: 'Service de connexion indisponible' }, { status: 502 });
  }
}