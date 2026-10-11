import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  supabaseAdmin,
  createTestUser,
  signInTestUser,
  deleteTestUser,
} from '../../helpers/supabase-test-client';

/**
 * F05 — états de validation Storage (pending / validated / rejected), garde MIME/taille
 * par bucket et isolation entre utilisateurs.
 *
 * Ces tests exigent une base locale sur laquelle l'ACTIVATION F05 a été appliquée
 * (supabase/activation/f05_activate_storage_validation.sql, env local-test, avec des
 * entrées Vault locales jetables) ET la fonction de dispatch webhook remplacée temporairement
 * par un no-op dans la base CI jetable (KAZA_F05_WEBHOOK_PAUSED=1) : les triggers restent actifs,
 * tandis que les états pending/validated/rejected sont pilotés manuellement en service_role.
 * Le trajet automatique réel est couvert par storage-validation-automatic.test.ts.
 * Ignorés tant que KAZA_F05_ACTIVATED != 1 ou KAZA_F05_WEBHOOK_PAUSED != 1.
 */
const enabled =
  process.env.KAZA_F05_ACTIVATED === '1' && process.env.KAZA_F05_WEBHOOK_PAUSED === '1';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(32).fill(1)]);
const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, ...new Array(32).fill(1)]);

describe.skipIf(!enabled)('F05 storage upload validation (activated database required)', () => {
  let owner: any;
  let other: any;
  let ownerClient: any;
  let otherClient: any;
  const created: { bucket: string; name: string }[] = [];

  const clientFor = (token: string) =>
    createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

  beforeAll(async () => {
    owner = await createTestUser('locataire');
    other = await createTestUser('locataire');
    ownerClient = clientFor((await signInTestUser(owner.email, owner.password)).session!.access_token);
    otherClient = clientFor((await signInTestUser(other.email, other.password)).session!.access_token);
  });

  afterAll(async () => {
    for (const o of created) await supabaseAdmin.storage.from(o.bucket).remove([o.name]);
    await deleteTestUser(owner.user.id);
    await deleteTestUser(other.user.id);
  });

  async function upload(client: any, bucket: string, name: string, bytes: Uint8Array, contentType: string) {
    const res = await client.storage.from(bucket).upload(name, bytes, { contentType, upsert: false });
    // Le fixture n'est enregistré pour nettoyage qu'après une création réussie.
    if (!res.error) created.push({ bucket, name });
    return res;
  }

  it('creates a pending state and denies signed URLs while pending', async () => {
    const name = `${owner.user.id}/pending-${Date.now()}.jpg`;
    const { error } = await upload(ownerClient, 'chat-files', name, JPEG, 'image/jpeg');
    expect(error).toBeNull();

    const { data: row } = await supabaseAdmin
      .from('storage_upload_validations').select('status').eq('bucket_id', 'chat-files').eq('object_name', name).single();
    expect(row?.status).toBe('pending');

    const signed = await ownerClient.storage.from('chat-files').createSignedUrl(name, 60);
    expect(signed.data?.signedUrl).toBeUndefined();
  });

  it('allows the owner (and only the owner) once validated', async () => {
    const name = `${owner.user.id}/valid-${Date.now()}.jpg`;
    expect((await upload(ownerClient, 'chat-files', name, JPEG, 'image/jpeg')).error).toBeNull();
    const validated = await supabaseAdmin.from('storage_upload_validations')
      .update({ status: 'validated', validated_at: new Date().toISOString() })
      .eq('bucket_id', 'chat-files').eq('object_name', name);
    expect(validated.error).toBeNull();

    expect((await ownerClient.storage.from('chat-files').createSignedUrl(name, 60)).data?.signedUrl).toBeTruthy();
    expect((await otherClient.storage.from('chat-files').createSignedUrl(name, 60)).data?.signedUrl).toBeUndefined();
  });

  it('keeps a rejected object unreadable', async () => {
    const name = `${owner.user.id}/rejected-${Date.now()}.jpg`;
    expect((await upload(ownerClient, 'chat-files', name, JPEG, 'image/jpeg')).error).toBeNull();
    const rejected = await supabaseAdmin.from('storage_upload_validations')
      .update({ status: 'rejected', rejection_reason: 'test' })
      .eq('bucket_id', 'chat-files').eq('object_name', name);
    expect(rejected.error).toBeNull();
    expect((await ownerClient.storage.from('chat-files').createSignedUrl(name, 60)).data?.signedUrl).toBeUndefined();
  });

  it('rejects a PDF in residence-photos and an unsupported MIME in chat-files at insertion', async () => {
    const pdfInPhotos = await upload(ownerClient, 'residence-photos', `${owner.user.id}/x-${Date.now()}.pdf`, PDF, 'application/pdf');
    expect(pdfInPhotos.error).not.toBeNull();
    const gif = await upload(ownerClient, 'chat-files', `${owner.user.id}/x-${Date.now()}.gif`, JPEG, 'image/gif');
    expect(gif.error).not.toBeNull();
  });

  it('accepts a PDF in chat-files at insertion (state pending)', async () => {
    const name = `${owner.user.id}/doc-${Date.now()}.pdf`;
    expect((await upload(ownerClient, 'chat-files', name, PDF, 'application/pdf')).error).toBeNull();
  });

  it('does not let a client write validation states', async () => {
    const name = `${owner.user.id}/forge-${Date.now()}.jpg`;
    expect((await upload(ownerClient, 'chat-files', name, JPEG, 'image/jpeg')).error).toBeNull();
    const { data } = await ownerClient.from('storage_upload_validations')
      .update({ status: 'validated', validated_at: new Date().toISOString() })
      .eq('bucket_id', 'chat-files').eq('object_name', name).select();
    expect(data ?? []).toHaveLength(0);
  });
});
