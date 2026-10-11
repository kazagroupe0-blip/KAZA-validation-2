import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  supabaseAdmin,
  createTestUser,
  signInTestUser,
  deleteTestUser,
} from '../../helpers/supabase-test-client';

/**
 * F05 — validateur Edge RÉEL (supabase functions serve) appelé comme le ferait le webhook SQL.
 * Le trajet Postgres -> Edge (pg_net vers https://<ref>.supabase.co) n'est pas testable en local :
 * la requête webhook est construite ici avec le secret jetable du runner (variables d'environnement,
 * jamais journalisées). Nécessite l'activation F05 (env local-test) et KAZA_F05_ACTIVATED=1.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const edgeUrl = process.env.KAZA_F05_EDGE_URL;
const edgeSecret = process.env.KAZA_F05_WEBHOOK_SECRET;
const enabled = process.env.KAZA_F05_ACTIVATED === '1' && !!edgeUrl && !!edgeSecret;

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(36).fill(1)]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(32).fill(2)]);
const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, ...new Array(36).fill(3)]);

describe.skipIf(!enabled)('F05 Edge validator end-to-end (local functions runtime)', () => {
  let owner: any;
  let ownerClient: ReturnType<typeof createClient>;
  const objects: { bucket: string; name: string }[] = [];

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
        .select('status, detected_mime, rejection_reason')
        .eq('bucket_id', bucket)
        .eq('object_name', name)
        .single()
    ).data;

  beforeAll(async () => {
    owner = await createTestUser('locataire');
    const token = (await signInTestUser(owner.email, owner.password)).session!.access_token;
    ownerClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });

  afterAll(async () => {
    for (const o of objects) await supabaseAdmin.storage.from(o.bucket).remove([o.name]);
    await deleteTestUser(owner.user.id);
  });

  async function put(bucket: string, name: string, bytes: Uint8Array, contentType: string) {
    const { error } = await ownerClient.storage.from(bucket).upload(name, bytes, { contentType, upsert: false });
    expect(error).toBeNull();
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
    expect((await ownerClient.storage.from('chat-files').createSignedUrl(name, 60)).data?.signedUrl).toBeUndefined();

    expect((await callValidator('chat-files', name, 'image/jpeg')).status).toBe(200);
    expect((await stateOf('chat-files', name))?.status).toBe('validated');
    expect((await ownerClient.storage.from('chat-files').createSignedUrl(name, 60)).data?.signedUrl).toBeTruthy();

    const replay = await callValidator('chat-files', name, 'image/jpeg');
    expect((await replay.json()).alreadyProcessed).toBe(true);
  });

  it('rejects and deletes a PNG declared as JPEG, and never revalidates it', async () => {
    const name = `${owner.user.id}/e2e-mismatch-${Date.now()}.jpg`;
    await put('chat-files', name, PNG, 'image/jpeg');
    const res = await callValidator('chat-files', name, 'image/jpeg');
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(false);
    expect((await stateOf('chat-files', name))?.status).toBe('rejected');

    const { data: files } = await supabaseAdmin.storage.from('chat-files').list(owner.user.id);
    expect((files ?? []).some((f) => name.endsWith(f.name))).toBe(false);

    const replay = await callValidator('chat-files', name, 'image/jpeg');
    expect((await replay.json()).alreadyProcessed).toBe(true);
    expect((await stateOf('chat-files', name))?.status).toBe('rejected');
  });

  it('rejects a PDF in residence-photos even if it reached Storage (defense in depth)', async () => {
    const name = `${owner.user.id}/e2e-pdf-${Date.now()}.pdf`;
    await supabaseAdmin.storage.from('residence-photos').upload(name, PDF, { contentType: 'image/jpeg', upsert: false });
    await supabaseAdmin.from('storage_upload_validations').upsert({
      bucket_id: 'residence-photos',
      object_name: name,
      status: 'pending',
      declared_mime: 'image/jpeg',
      byte_size: PDF.length,
    });
    objects.push({ bucket: 'residence-photos', name });

    const res = await callValidator('residence-photos', name, 'image/jpeg');
    expect((await res.json()).ok).toBe(false);
    expect((await stateOf('residence-photos', name))?.status).toBe('rejected');
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
