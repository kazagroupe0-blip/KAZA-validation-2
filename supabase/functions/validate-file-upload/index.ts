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
 * Machine d'états (public.storage_upload_validations) :
 *   pending   -> validated | rejected   (transitions conditionnelles .eq('status','pending'))
 *   validated -> jamais modifié ni supprimé (rejeu = alreadyProcessed)
 *   rejected  -> jamais relu comme valide ; un rejeu ne fait que (re)tenter la suppression
 *                de l'objet tant que deleted_at est vide.
 * Génération : chaque transition conditionnelle porte aussi sur la génération de contenu lue au
 * début du traitement (colonne generation). Si l'objet a été remplacé entre-temps (nouvelle
 * génération, état remis à pending par la garde SQL), le verdict calculé sur l'ancien contenu
 * n'écrit rien : il ne peut ni valider ni rejeter le nouveau contenu.
 * Aucune écriture n'utilise upsert : un événement tardif ou concurrent ne peut donc pas
 * renverser un état terminal (le trigger SQL storage_validation_state_guard le refuse aussi).
 */
type AdminClient = ReturnType<typeof getAdminClient>;

// Filtre de génération : égalité si la génération est connue, IS NULL sinon (états antérieurs).
// deno-lint-ignore no-explicit-any
function withGeneration<T extends { eq: (c: string, v: string) => any; is: (c: string, v: null) => any }>(
  query: T,
  generation: string | null,
) {
  return generation === null ? query.is('generation', null) : query.eq('generation', generation);
}

/** Passe pending -> validated uniquement. */
async function markValidated(
  supabase: AdminClient,
  input: {
    bucket: string;
    path: string;
    generation: string | null;
    declaredMime: string;
    detectedMime: string;
    byteSize: number;
  },
): Promise<'validated' | 'not-pending' | 'error'> {
  const now = new Date().toISOString();
  const { data, error } = await withGeneration(supabase
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
    .eq('status', 'pending'), input.generation)
    .select('object_name');

  if (error) {
    console.error(
      `[validate-upload] Could not persist state for ${input.bucket}/${input.path}: ${error.message}`,
    );
    return 'error';
  }

  return data && data.length === 1 ? 'validated' : 'not-pending';
}

/** Passe pending -> rejected uniquement (jamais depuis validated). */
async function markRejected(
  supabase: AdminClient,
  input: { bucket: string; path: string; generation: string | null; reason: string },
): Promise<'rejected' | 'not-pending' | 'error'> {
  const { data, error } = await withGeneration(supabase
    .from('storage_upload_validations')
    .update({
      status: 'rejected',
      rejection_reason: input.reason,
      validated_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('bucket_id', input.bucket)
    .eq('object_name', input.path)
    .eq('status', 'pending'), input.generation)
    .select('object_name');

  if (error) {
    console.error(
      `[validate-upload] Could not persist rejection for ${input.bucket}/${input.path}: ${error.message}`,
    );
    return 'error';
  }

  return data && data.length === 1 ? 'rejected' : 'not-pending';
}

/**
 * Supprime l'objet d'un état DÉJÀ rejected puis enregistre la suppression.
 * Idempotent : réessayable par rejeu du webhook ou par la reprise SQL.
 */
async function deleteRejectedObject(
  supabase: AdminClient,
  bucket: string,
  path: string,
  reason: string | null,
  origin: string | null,
) {
  const { error } = await supabase.storage.from(bucket).remove([path]);

  if (error) {
    console.error(
      `[validate-upload] DELETE failed after rejection: ${bucket}/${path} — ${error.message}`,
    );
    await supabase
      .from('storage_upload_validations')
      .update({ last_error: 'storage deletion failed', updated_at: new Date().toISOString() })
      .eq('bucket_id', bucket)
      .eq('object_name', path)
      .eq('status', 'rejected');
    return jsonResponse(
      { ok: false, deleted: false, retryable: true, reason: 'validation cleanup failed' },
      503,
      origin,
    );
  }

  const now = new Date().toISOString();
  const { error: markErr } = await supabase
    .from('storage_upload_validations')
    .update({ deleted_at: now, last_error: null, updated_at: now })
    .eq('bucket_id', bucket)
    .eq('object_name', path)
    .eq('status', 'rejected')
    .is('deleted_at', null);

  if (markErr) {
    console.error(
      `[validate-upload] Could not record deletion for ${bucket}/${path}: ${markErr.message}`,
    );
    return jsonResponse(
      { ok: false, deleted: true, retryable: true, reason: 'validation state write failed' },
      503,
      origin,
    );
  }

  console.warn(`[validate-upload] REJECTED: ${bucket}/${path} — ${reason ?? 'previously rejected'}`);
  return jsonResponse({ ok: false, deleted: true, reason: reason ?? 'rejected' }, 200, origin);
}

async function rejectAndDelete(
  supabase: AdminClient,
  bucket: string,
  path: string,
  generation: string | null,
  reason: string,
  origin: string | null,
) {
  const outcome = await markRejected(supabase, { bucket, path, generation, reason });

  if (outcome === 'error') {
    return jsonResponse(
      { ok: false, deleted: false, retryable: true, reason: 'validation state write failed' },
      503,
      origin,
    );
  }

  if (outcome === 'not-pending') {
    // Un autre traitement a déjà tranché. Un objet validé n'est JAMAIS supprimé ici.
    const { data: current, error } = await supabase
      .from('storage_upload_validations')
      .select('status, deleted_at')
      .eq('bucket_id', bucket)
      .eq('object_name', path)
      .maybeSingle();

    if (error || !current) {
      return jsonResponse(
        { ok: false, validated: false, retryable: true, reason: 'validation state read failed' },
        503,
        origin,
      );
    }

    if (current.status !== 'rejected') {
      return jsonResponse(
        { ok: false, validated: false, retryable: false, reason: 'state changed during validation' },
        409,
        origin,
      );
    }

    if (current.deleted_at) {
      return jsonResponse({ ok: false, validated: false, alreadyProcessed: true }, 200, origin);
    }
  }

  return deleteRejectedObject(supabase, bucket, path, reason, origin);
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

    // Idempotence : seul un état pending est (re)validé. Aucune ligne d'état =
    // événement inattendu, jamais présenté comme validé.
    const { data: stateRow, error: stateErr } = await supabase
      .from('storage_upload_validations')
      .select('status, deleted_at, generation')
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
      // Rejeu sur un objet rejeté : jamais relu comme valide. Tant que la suppression n'est pas
      // enregistrée, on la retente ; ensuite le rejeu est un simple accusé.
      if (stateRow.deleted_at) {
        return jsonResponse({ ok: false, validated: false, alreadyProcessed: true }, 200, origin);
      }
      return deleteRejectedObject(supabase, bucket, path, null, origin);
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
      return rejectAndDelete(supabase, bucket, path, stateRow.generation ?? null, verdict.reason, origin);
    }

    const outcome = await markValidated(supabase, {
      bucket,
      path,
      generation: stateRow.generation ?? null,
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
