// ============================================================
// Couche d'accès « Supabase seule » — barrel export pour compatibilité.
// Le code métier a été découpé dans src/lib/api/ (auth, payments, chat, etc.).
// Ce fichier ré-exporte l'API publique inchangée pour ne pas casser les imports existants.
// ============================================================

import { supabase } from './supabase-client';
import { env } from './env';
import { withRetry } from './retry';

export class ApiError extends Error {
  status: number;
  fields?: Record<string, string[]>;
  code?: string;
  details?: string;
  hint?: string;

  constructor(
    status: number,
    message: string,
    fields?: Record<string, string[]>,
    metadata: { code?: string; details?: string; hint?: string } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fields = fields;
    this.code = metadata.code;
    this.details = metadata.details;
    this.hint = metadata.hint;
  }
}

/** Valide un numéro de téléphone bénin : +229 suivi de 10 chiffres. */
export function assertBeninPhone(phone: string): void {
  const cleaned = phone.replace(/\s+/g, '');
  if (!/^\+229\d{10}$/.test(cleaned)) {
    throw new ApiError(400, 'Numéro invalide — format attendu : +229 01 00 00 00 00');
  }
}

const PGRST_CODE = (code: string | undefined): number => {
  switch (code) {
    case 'P0001':
      return 409; // conflit métier (ex : limite freemium, caution trop élevée)
    case 'P0002':
      return 404;
    case '42501':
      return 403;
    default:
      return 400;
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asOptionalFields(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).flatMap(([key, raw]) => {
    if (!Array.isArray(raw)) return [];
    const values = raw.filter((item): item is string => typeof item === 'string');
    return values.length > 0 ? [[key, values]] as const : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function normalizeError(err: unknown, fallback: string): ApiError {
  if (err instanceof ApiError) return err;

  const e = isRecord(err) ? err : {};
  const code = asOptionalString(e.code);
  const details = asOptionalString(e.details);
  const hint = asOptionalString(e.hint);
  const message = asOptionalString(e.message) ?? asOptionalString(e.error) ?? details ?? fallback;
  const explicitStatus =
    typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  const status = explicitStatus !== undefined && explicitStatus >= 400 && explicitStatus <= 599
    ? explicitStatus
    : PGRST_CODE(code);

  return new ApiError(status, message, asOptionalFields(e.fields), { code, details, hint });
}

async function callFunction<T>(name: string, body: unknown): Promise<T> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw normalizeError(authErr, 'Session invalide — reconnectez-vous');
  if (!user) throw new ApiError(401, 'Session invalide — reconnectez-vous');

  const { data: { session }, error: sessionErr } = await supabase.auth.getSession();
  if (sessionErr) throw normalizeError(sessionErr, 'Session indisponible — reconnectez-vous');
  const accessToken = session?.access_token;
  if (!accessToken) throw new ApiError(401, 'Session invalide — reconnectez-vous');

  const base = env.supabaseUrl;

  return withRetry(
    async () => {
      const res = await fetch(`${base}/functions/v1/${name}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      });

      const rawBody = await res.text();
      let payload: unknown = null;
      if (rawBody) {
        try {
          payload = JSON.parse(rawBody);
        } catch {
          payload = rawBody;
        }
      }

      if (!res.ok) {
        const data = isRecord(payload) ? payload : {};
        const code = asOptionalString(data.code);
        const details = asOptionalString(data.details);
        const hint = asOptionalString(data.hint);
        const message =
          asOptionalString(data.message) ??
          asOptionalString(data.error) ??
          details ??
          (typeof payload === 'string' && payload.trim() ? payload : `Erreur HTTP ${res.status}`);
        const fields = asOptionalFields(data.fields);
        throw new ApiError(res.status, message, fields, { code, details, hint });
      }

      return payload as T;
    },
    {
      maxRetries: 2,
      baseDelayMs: 500,
      retryableStatuses: [429, 500, 502, 503, 504],
    },
  );
}

export { callFunction };

// Ré-export de tous les modules d'API découpés
export * from './api';