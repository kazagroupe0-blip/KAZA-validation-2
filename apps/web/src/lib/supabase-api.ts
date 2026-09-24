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

  constructor(status: number, message: string, fields?: Record<string, string[]>) {
    super(message);
    this.status = status;
    this.fields = fields;
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

export function normalizeError(err: unknown, fallback: string): ApiError {
  const e = err as { code?: string; message?: string; details?: string } | null;
  if (e?.message) {
    return new ApiError(PGRST_CODE(e.code), e.message);
  }
  if (e?.details) return new ApiError(400, e.details);
  return new ApiError(400, fallback);
}

type FunctionErrorPayload = {
  error?: unknown;
  error_description?: unknown;
  message?: unknown;
  details?: unknown;
  fields?: unknown;
};

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseFunctionErrorPayload(payload: unknown, status: number): { message: string; fields?: Record<string, string[]> } {
  if (!payload || typeof payload !== 'object') {
    return { message: `Erreur HTTP ${status}` };
  }

  const body = payload as FunctionErrorPayload;
  const nestedError = body.error && typeof body.error === 'object'
    ? body.error as FunctionErrorPayload
    : null;
  const message =
    asNonEmptyString(body.error_description) ??
    asNonEmptyString(body.message) ??
    asNonEmptyString(body.error) ??
    asNonEmptyString(nestedError?.message) ??
    asNonEmptyString(nestedError?.error_description) ??
    asNonEmptyString(nestedError?.error) ??
    asNonEmptyString(body.details) ??
    asNonEmptyString(nestedError?.details) ??
    `Erreur HTTP ${status}`;

  const rawFields = body.fields ?? nestedError?.fields;
  if (rawFields && typeof rawFields === 'object' && !Array.isArray(rawFields)) {
    const fields: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(rawFields as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        const messages = value.filter((item): item is string => typeof item === 'string');
        if (messages.length > 0) fields[key] = messages;
      }
    }
    return Object.keys(fields).length > 0 ? { message, fields } : { message };
  }

  return { message };
}

async function callFunction<T>(name: string, body: unknown): Promise<T> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) throw new ApiError(401, 'Session invalide — reconnectez-vous');

  const { data: { session } } = await supabase.auth.getSession();
  const base = env.supabaseUrl;

  return withRetry(
    async () => {
      const res = await fetch(`${base}/functions/v1/${name}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token
            ? { Authorization: `Bearer ${session.access_token}` }
            : {}),
        },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => null) as FunctionErrorPayload | T | null;
      if (!res.ok) {
        const parsed = parseFunctionErrorPayload(payload, res.status);
        throw new ApiError(res.status, parsed.message, parsed.fields);
      }
      return payload as T;
    },
    {
      maxRetries: 2,
      baseDelayMs: 500,
      retryableStatuses: [429, 500, 502, 503, 504],
    }
  );
}

export { callFunction };

// Ré-export de tous les modules d'API découpés
export * from './api';