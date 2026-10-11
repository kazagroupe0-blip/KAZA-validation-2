import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'node:fs';
import {
  supabaseAdmin,
  createTestUser,
  signInTestUser,
  deleteTestUser,
} from '../../helpers/supabase-test-client';

/**
 * F05 — validateur Edge RÉEL (supabase functions serve) piloté DIRECTEMENT par ces tests.
 *
 * ATTENTION — ces appels directs NE PROUVENT PAS le trajet automatique PostgreSQL -> pg_net -> Edge :
 * c'est le rôle de storage-validation-automatic.test.ts. Ici le dispatcher webhook est remplacé
 * temporairement par un no-op dans la base CI jetable (les triggers Storage restent actifs) afin que
 * chaque état soit piloté à la main :
 * transitions, rejeux, concurrence, défense en profondeur et échec de suppression.
 *
 * Variables : KAZA_F05_ACTIVATED=1, KAZA_F05_WEBHOOK_PAUSED=1, KAZA_F05_EDGE_URL, KAZA_F05_WEBHOOK_SECRET
 * (secret jetable du runner, jamais journalisé). Facultatif : KAZA_F05_DELETE_BLOCKER=1 (helper CI
 * public.ci_f05_blocked_names installé), KAZA_F05_PDF_FIXTURE=<fichier JSON {bucket,name}> créé AVANT
 * l'activation par f05-prepare-legacy-fixture.test.ts.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const edgeUrl = process.env.KAZA_F05_EDGE_URL;
const edgeSecret = process.env.KAZA_F05_WEBHOOK_SECRET;
const deleteBlocker = process.env.KAZA_F05_DELETE_BLOCKER === '1';
const pdfFixturePath = process.env.KAZA_F05_PDF_FIXTURE;
const enabled =
  process.env.KAZA_F05_ACTIVATED === '1' &&
  process.env.KAZA_F05_WEBHOOK_PAUSED === '1' &&
  !!edgeUrl &&
  !!edgeSecret;

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(36).fill(1)]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(32).fill(2)]);

describe.skipIf(!enabled)('F05 Edge validator driven directly (webhook paused)', () => {
  let owner: any;
  let ownerClient: ReturnType<typeof createClient>;
  const objects: { bucket: string; name: string }[] = [];
  const blocked: string[] = [];

  const callValidator = (bucket: string, name: string, mimetype: string, secret: string | null = edgeSecret!) =>
    fetch(edgeUrl!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(anonKey ? { apikey: anonKey } : {}),
        ...(secret ? { 'x-storage-validation-secret': secret } : {}),
      },
      body: JSON.stringify({
        type: 'INSERT',
        schema: 'storage',
        table: 'objects',
        record: { bucket_id: bucket, name, metadata: { mimetype, size: 40 } },
      }),
    });

  const stateOf = async (bucket: string, name: string) =>
    (
      await supabaseAdmin
        .from('storage_upload_validations')
        .select('status, detected_mime, rejection_reason, deleted_at, delete_attempts')
        .eq('bucket_id', bucket)
        .eq('object_name', name)
        .single()
    ).data;

  const objectExists = async (bucket: string, name: string) =>
    !(await supabaseAdmin.storage.from(bucket).download(name)).error;

  const signedUrl = async (bucket: string, name: string) =>
    (await ownerClient.storage.from(bucket).createSignedUrl(name, 60)).data?.signedUrl;

  beforeAll(async () => {
    owner = await createTestUser('locataire');
    const token = (await signInTestUser(owner.email, owner.password)).session!.access_token;
    ownerClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });

  afterAll(async () => {
    if (deleteBlocker) {
      for (const n of blocked) await supabaseAdmin.from('ci_f05_blocked_names').delete().eq('name', n);
    }
    for (const o of objects) await supabaseAdmin.storage.from(o.bucket).remove([o.name]);
    if (owner) await deleteTestUser(owner.user.id);
  });

  // Aucune erreur d'upload n'est ignorée ; le fixture n'est enregistré pour nettoyage qu'après succès.
  async function put(bucket: string, name: string, bytes: Uint8Array, contentType: string) {
    const { error } = await ownerClient.storage.from(bucket).upload(name, bytes, { contentType, upsert: false });
    if (error) throw new Error(`fixture upload failed for ${bucket}/${name}: ${error.message}`);
    objects.push({ bucket, name });
  }

  it('refuses unauthenticated and wrongly authenticated webhook calls', async () => {
    expect((await callValidator('chat-files', 'x/y.jpg', 'image/jpeg', null)).status).toBe(401);
    expect((await callValidator('chat-files', 'x/y.jpg', 'image/jpeg', 'w'.repeat(40))).status).toBe(401);
  });

  it('validates a genuine JPEG, persists the state and unlocks the owner read, idempotently', async () => {
    const name = `${owner.user.id}/e2e-ok-${Date.now()}.jpg`;
    await put('chat-files', name, JPEG, 'image/jpeg');
    expect((await stateOf('chat-files', name))?.status).toBe('pending');
    expect(await signedUrl('chat-files', name)).toBeUndefined();

    expect((await callValidator('chat-files', name, 'image/jpeg')).status).toBe(200);
    expect((await stateOf('chat-files', name))?.status).toBe('validated');
    expect(await signedUrl('chat-files', name)).toBeTruthy();

    const replay = await callValidator('chat-files', name, 'image/jpeg');
    expect((await replay.json()).alreadyProcessed).toBe(true);
    expect(await objectExists('chat-files', name)).toBe(true);
  });

  it('rejects and deletes a PNG declared as JPEG; replays only acknowledge and never make it readable', async () => {
    const name = `${owner.user.id}/e2e-mismatch-${Date.now()}.jpg`;
    await put('chat-files', name, PNG, 'image/jpeg');
    const res = await callValidator('chat-files', name, 'image/jpeg');
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(false);

    const state = await stateOf('chat-files', name);
    expect(state?.status).toBe('rejected');
    expect(state?.deleted_at).toBeTruthy();
    expect(await objectExists('chat-files', name)).toBe(false);

    const replay = await callValidator('chat-files', name, 'image/jpeg');
    expect((await replay.json()).alreadyProcessed).toBe(true);
    expect((await stateOf('chat-files', name))?.status).toBe('rejected');
    expect(await signedUrl('chat-files', name)).toBeUndefined();
  });

  it('never deletes nor overwrites an object that was validated concurrently (late invalid event)', async () => {
    const name = `${owner.user.id}/e2e-late-${Date.now()}.jpg`;
    await put('chat-files', name, PNG, 'image/jpeg');
    // Un autre traitement a déjà validé la ligne (course gagnée par la validation).
    const { error } = await supabaseAdmin
      .from('storage_upload_validations')
      .update({ status: 'validated', validated_at: new Date().toISOString() })
      .eq('bucket_id', 'chat-files')
      .eq('object_name', name)
      .eq('status', 'pending');
    expect(error).toBeNull();

    const res = await callValidator('chat-files', name, 'image/jpeg');
    expect(res.status).toBe(200);
    expect((await res.json()).alreadyProcessed).toBe(true);
    expect((await stateOf('chat-files', name))?.status).toBe('validated');
    expect(await objectExists('chat-files', name)).toBe(true);
  });

  it('cannot reverse a terminal state, even with an unconditional write', async () => {
    const name = `${owner.user.id}/e2e-terminal-${Date.now()}.jpg`;
    await put('chat-files', name, JPEG, 'image/jpeg');
    expect((await callValidator('chat-files', name, 'image/jpeg')).status).toBe(200);

    const forced = await supabaseAdmin
      .from('storage_upload_validations')
      .update({ status: 'rejected', validated_at: null })
      .eq('bucket_id', 'chat-files')
      .eq('object_name', name);
    expect(forced.error).not.toBeNull();
    expect((await stateOf('chat-files', name))?.status).toBe('validated');
  });

  it('retries the deletion of a rejected object whose deletion never completed, keeping it unreadable', async () => {
    const name = `${owner.user.id}/e2e-undeleted-${Date.now()}.jpg`;
    await put('chat-files', name, JPEG, 'image/jpeg');
    const { error } = await supabaseAdmin
      .from('storage_upload_validations')
      .update({ status: 'rejected', rejection_reason: 'simulated: deletion did not complete' })
      .eq('bucket_id', 'chat-files')
      .eq('object_name', name)
      .eq('status', 'pending');
    expect(error).toBeNull();

    expect(await objectExists('chat-files', name)).toBe(true);
    expect(await signedUrl('chat-files', name)).toBeUndefined();

    const replay = await callValidator('chat-files', name, 'image/jpeg');
    expect(replay.status).toBe(200);
    expect((await replay.json()).deleted).toBe(true);
    expect((await stateOf('chat-files', name))?.deleted_at).toBeTruthy();
    expect(await objectExists('chat-files', name)).toBe(false);

    const again = await callValidator('chat-files', name, 'image/jpeg');
    expect((await again.json()).alreadyProcessed).toBe(true);
  });

  it.skipIf(!deleteBlocker)(
    'keeps a rejected object unreadable when Storage deletion really fails, then deletes it on replay',
    async () => {
      const name = `${owner.user.id}/e2e-delfail-${Date.now()}.jpg`;
      await put('chat-files', name, PNG, 'image/jpeg');

      const block = await supabaseAdmin.from('ci_f05_blocked_names').insert({ name });
      expect(block.error).toBeNull();
      blocked.push(name);

      const failed = await callValidator('chat-files', name, 'image/jpeg');
      expect(failed.status).toBe(503);
      expect((await failed.json()).retryable).toBe(true);

      const state = await stateOf('chat-files', name);
      expect(state?.status).toBe('rejected');
      expect(state?.deleted_at).toBeNull();
      expect(await objectExists('chat-files', name)).toBe(true);
      expect(await signedUrl('chat-files', name)).toBeUndefined();

      const unblock = await supabaseAdmin.from('ci_f05_blocked_names').delete().eq('name', name);
      expect(unblock.error).toBeNull();

      const retried = await callValidator('chat-files', name, 'image/jpeg');
      expect(retried.status).toBe(200);
      expect((await stateOf('chat-files', name))?.status).toBe('rejected');
      expect((await stateOf('chat-files', name))?.deleted_at).toBeTruthy();
      expect(await objectExists('chat-files', name)).toBe(false);
    },
  );

  it('settles concurrent identical webhook deliveries on a single terminal state (valid file)', async () => {
    const name = `${owner.user.id}/e2e-race-ok-${Date.now()}.jpg`;
    await put('chat-files', name, JPEG, 'image/jpeg');

    const results = await Promise.all(
      Array.from({ length: 4 }, () => callValidator('chat-files', name, 'image/jpeg')),
    );
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect((await stateOf('chat-files', name))?.status).toBe('validated');
    expect(await objectExists('chat-files', name)).toBe(true);
  });

  it('settles concurrent deliveries on an invalid file as rejected and deleted, never validated', async () => {
    const name = `${owner.user.id}/e2e-race-bad-${Date.now()}.jpg`;
    await put('chat-files', name, PNG, 'image/jpeg');

    const results = await Promise.all(
      Array.from({ length: 4 }, () => callValidator('chat-files', name, 'image/jpeg')),
    );
    for (const r of results) {
      expect([200, 409, 503]).toContain(r.status);
      const body = await r.json();
      expect(body.ok).toBe(false);
      expect(body.validated).not.toBe(true);
    }

    // Un 503 de course est rejouable : un rejeu final converge.
    await callValidator('chat-files', name, 'image/jpeg');
    const state = await stateOf('chat-files', name);
    expect(state?.status).toBe('rejected');
    expect(state?.deleted_at).toBeTruthy();
    expect(await objectExists('chat-files', name)).toBe(false);
    expect(await signedUrl('chat-files', name)).toBeUndefined();
  });

  it('rejects a PDF that already sits in residence-photos (defense in depth, real prepared object)', async () => {
    if (!pdfFixturePath || !existsSync(pdfFixturePath)) {
      throw new Error(
        'KAZA_F05_PDF_FIXTURE is missing: the legacy PDF fixture must be created BEFORE activation (f05-prepare-legacy-fixture.test.ts)',
      );
    }
    const fixture = JSON.parse(readFileSync(pdfFixturePath, 'utf8')) as { bucket: string; name: string };
    expect(fixture.bucket).toBe('residence-photos');
    expect(await objectExists(fixture.bucket, fixture.name)).toBe(true);
    objects.push(fixture);

    // L'objet existe réellement : on crée l'état pending comme le ferait le trigger, jamais pour un fichier absent.
    const seeded = await supabaseAdmin.from('storage_upload_validations').insert({
      bucket_id: fixture.bucket,
      object_name: fixture.name,
      status: 'pending',
      declared_mime: 'image/jpeg',
      byte_size: 40,
    });
    expect(seeded.error).toBeNull();

    const res = await callValidator(fixture.bucket, fixture.name, 'image/jpeg');
    const body = await res.json();
    expect(body.ok).toBe(false);
    const state = await stateOf(fixture.bucket, fixture.name);
    expect(state?.status).toBe('rejected');
    expect(state?.deleted_at).toBeTruthy();
    expect(await objectExists(fixture.bucket, fixture.name)).toBe(false);
  });

  it('answers 409 for an object without a state row', async () => {
    const res = await callValidator('chat-files', `${owner.user.id}/no-state-${Date.now()}.jpg`, 'image/jpeg');
    expect(res.status).toBe(409);
  });

  it('answers 400 for an unexpected event type', async () => {
    const res = await fetch(edgeUrl!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(anonKey ? { apikey: anonKey } : {}),
        'x-storage-validation-secret': edgeSecret!,
      },
      body: JSON.stringify({ type: 'DELETE', schema: 'storage', table: 'objects', record: {} }),
    });
    expect(res.status).toBe(400);
  });
});
