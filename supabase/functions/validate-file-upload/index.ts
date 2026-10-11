import { getAdminClient } from '../_shared/db.ts';
import { isAuthorizedStorageValidationWebhook } from '../_shared/storage-upload-auth.ts';
import { jsonResponse, errorResponse, handleOptions } from '../_shared/cors.ts';
import { isUploadBucket, validateUploadContent } from '../_shared/file-validation.ts';

/**
 * Validation côté serveur des fichiers uploadés dans Supabase Storage.
 * Vérifie le contenu réel (magic bytes) contre une liste blanche.
 * Appelé uniquement par le déclencheur SQL private.dispatch_storage_validation_webhook
 * (et sa reprise pg_cron) avec l'en-tête secret dédié x-storage-validation-secret.
 * verify_jwt = false : l'authentification est entièrement faite ici (fail-closed).
 * Règles par bucket : residence-photos = images ; chat-files = images + PDF.
 *
 * Si le fichier est invalide → suppression + log.
 * Si la lecture ou la suppression échoue → erreur non-2xx, jamais "validated".
 */
async function persistValidationStatus(
  supabase: ReturnType<typeof getAdminClient>,
  input: {
    bucket: string;
    path: string;
    status: 'pending' | 'validated' | 'rejected';
    declaredMime?: string | null;
    detectedMime?: string | null;
    byteSize?: number | null;
    reason?: string | null;
  },
): Promise<boolean> {
  const { error } = await supabase
    .from('storage_upload_validations')
    .upsert({
      bucket_id: input.bucket,
      object_name: input.path,
      status: input.status,
      declared_mime: input.declaredMime ?? null,
      detected_mime: input.detectedMime ?? null,
      byte_size: input.byteSize ?? null,
      rejection_reason: input.reason ?? null,
      validated_at: input.status === 'validated' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'bucket_id,object_name' });

  if (error) {
    console.error(
      `[validate-upload] Could not persist state for ${input.bucket}/${input.path}: ${error.message}`,
    );
    return false;
  }

  return true;
}

/**
 * Passe pending -> validated uniquement. Un état déjà rejeté ou validé n'est
 * jamais écrasé (rejeu de webhook, course avec la reprise automatique).
 */
async function markValidated(
  supabase: ReturnType<typeof getAdminClient>,
  input: { bucket: string; path: string; declaredMime: string; detectedMime: string; byteSize: number },
): Promise<'validated' | 'not-pending' | 'error'> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('storage_upload_validations')
    .update({
      status: 'validated',
      declared_mime: input.declaredMime,
      detected_mime: input.detectedMime,
      byte_size: input.byteSize,
      rejection_reason: null,
      validated_at: now,
      updated_at: now,
    })
    .eq('bucket_id', input.bucket)
    .eq('object_name', input.path)
    .eq('status', 'pending')
    .select('object_name');

  if (error) {
    console.error(
      `[validate-upload] Could not persist state for ${input.bucket}/${input.path}: ${error.message}`,
    );
    return 'error';
  }

  return data && data.length === 1 ? 'validated' : 'not-pending';
}

async function rejectAndDelete(
  supabase: ReturnType<typeof getAdminClient>,
  bucket: string,
  path: string,
  reason: string,
  origin: string | null,
) {
  const stateSaved = await persistValidationStatus(supabase, {
    bucket,
    path,
    status: 'rejected',
    reason,
  });

  const { error } = await supabase.storage.from(bucket).remove([path]);

  if (error) {
    console.error(
      `[validate-upload] DELETE failed after rejection: ${bucket}/${path} — ${error.message}`,
    );
    return jsonResponse(
      { ok: false, deleted: false, retryable: true, reason: 'validation cleanup failed' },
      503,
      origin,
    );
  }

  if (!stateSaved) {
    return jsonResponse(
      { ok: false, deleted: true, retryable: true, reason: 'validation state write failed' },
      503,
      origin,
    );
  }

  console.warn(`[validate-upload] REJECTED: ${bucket}/${path} — ${reason}`);
  return jsonResponse({ ok: false, deleted: true, reason }, 200, origin);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return handleOptions(req);
  if (req.method !== 'POST') return errorResponse('Méthode non autorisée', 405, origin);

  const expectedSecret = Deno.env.get('STORAGE_VALIDATION_WEBHOOK_SECRET');

  if (!expectedSecret || expectedSecret.length < 32) {
    console.error('[validate-upload] webhook secret is missing or too short');
    return jsonResponse(
      { ok: false, validated: false, retryable: false, reason: 'validator unavailable' },
      503,
      origin,
    );
  }

  if (!isAuthorizedStorageValidationWebhook(req.headers, expectedSecret)) {
    return jsonResponse(
      { ok: false, validated: false, reason: 'unauthorized' },
      401,
      origin,
    );
  }

  try {
    const payload = await req.json();

    if (
      payload?.type !== 'INSERT' ||
      payload?.schema !== 'storage' ||
      payload?.table !== 'objects'
    ) {
      return jsonResponse({ ok: false, reason: 'invalid webhook event' }, 400, origin);
    }

    const record = payload?.record;

    if (!record?.bucket_id || !record?.name) {
      return jsonResponse({ ok: false, reason: 'missing fields' }, 400, origin);
    }

    const bucket = record.bucket_id as unknown;
    const path = record.name as string;

    if (!isUploadBucket(bucket)) {
      return jsonResponse({ ok: true, skipped: true, reason: 'bucket not validated' }, 200, origin);
    }

    const supabase = getAdminClient();

    // Idempotence : seul un état pending est (re)traité. Aucune ligne d'état =
    // événement inattendu, jamais présenté comme validé.
    const { data: stateRow, error: stateErr } = await supabase
      .from('storage_upload_validations')
      .select('status')
      .eq('bucket_id', bucket)
      .eq('object_name', path)
      .maybeSingle();

    if (stateErr) {
      console.error(`[validate-upload] state read failed: ${bucket}/${path} — ${stateErr.message}`);
      return jsonResponse(
        { ok: false, validated: false, retryable: true, reason: 'validation state read failed' },
        503,
        origin,
      );
    }

    if (!stateRow) {
      return jsonResponse(
        { ok: false, validated: false, retryable: false, reason: 'no validation state for object' },
        409,
        origin,
      );
    }

    if (stateRow.status === 'validated') {
      return jsonResponse({ ok: true, validated: true, alreadyProcessed: true }, 200, origin);
    }

    if (stateRow.status === 'rejected') {
      return jsonResponse({ ok: false, validated: false, alreadyProcessed: true }, 200, origin);
    }

    const { data: fileData, error: dlErr } = await supabase.storage
      .from(bucket)
      .download(path);

    if (dlErr || !fileData) {
      console.error(
        `[validate-upload] download failed: ${bucket}/${path} — ${dlErr?.message ?? 'no file data'}`,
      );
      return jsonResponse(
        { ok: false, validated: false, retryable: true, reason: 'download failed' },
        503,
        origin,
      );
    }

    const bytes = new Uint8Array(await fileData.arrayBuffer());
    const verdict = validateUploadContent({
      bucket,
      declaredMime: record?.metadata?.mimetype,
      bytes,
    });

    if (!verdict.ok) {
      return rejectAndDelete(supabase, bucket, path, verdict.reason, origin);
    }

    const outcome = await markValidated(supabase, {
      bucket,
      path,
      declaredMime: verdict.mime,
      detectedMime: verdict.mime,
      byteSize: bytes.length,
    });

    if (outcome === 'error') {
      return jsonResponse(
        { ok: false, validated: false, retryable: true, reason: 'validation state write failed' },
        503,
        origin,
      );
    }

    if (outcome === 'not-pending') {
      return jsonResponse(
        { ok: false, validated: false, retryable: false, reason: 'state changed during validation' },
        409,
        origin,
      );
    }

    return jsonResponse({ ok: true, validated: verdict.type }, 200, origin);
  } catch (err) {
    console.error('[validate-upload] unexpected error', err);
    return jsonResponse(
      { ok: false, validated: false, retryable: true, reason: 'internal error' },
      500,
      origin,
    );
  }
});
