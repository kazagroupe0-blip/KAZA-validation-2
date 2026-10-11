import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  supabaseAdmin,
  createTestUser,
  signInTestUser,
  deleteTestUser,
} from '../../helpers/supabase-test-client';

/**
 * F05 — TRAJET AUTOMATIQUE RÉEL : upload Storage -> garde SQL -> trigger AFTER INSERT ->
 * pg_net (depuis le conteneur PostgreSQL) -> fonction Edge locale -> état terminal.
 *
 * Aucun appel direct à la fonction Edge, aucun changement d'état manuel : seuls l'upload (client
 * authentifié, API Storage réelle) et l'attente d'un état terminal. Le trigger webhook doit être
 * ACTIF (KAZA_F05_AUTOMATIC=1, posé par la CI après la sonde pg_net -> Edge).
 * Si le trajet automatique est cassé, ces tests échouent avec un diagnostic ; ils ne passent jamais
 * grâce à un appel manuel.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const enabled = process.env.KAZA_F05_ACTIVATED === '1' && process.env.KAZA_F05_AUTOMATIC === '1';

const TERMINAL_TIMEOUT_MS = Number(process.env.KAZA_F05_TERMINAL_TIMEOUT_MS ?? 90_000);
const POLL_MS = 1_000;

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(36).fill(1)]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(32).fill(2)]);
const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, ...new Array(36).fill(3)]);

type Row = {
  status: string;
  retry_attempts: number;
  deleted_at: string | null;
  rejection_reason: string | null;
  last_error: string | null;
};

describe.skipIf(!enabled)('F05 automatic path: Storage -> pg_net -> Edge (no direct call)', () => {
  let owner: any;
  let ownerClient: ReturnType<typeof createClient>;
  const objects: { bucket: string; name: string }[] = [];

  const rowOf = async (bucket: string, name: string): Promise<Row | null> =>
    (
      await supabaseAdmin
        .from('storage_upload_validations')
        .select('status, retry_attempts, deleted_at, rejection_reason, last_error')
        .eq('bucket_id', bucket)
        .eq('object_name', name)
        .maybeSingle()
    ).data as Row | null;

  const objectExists = async (bucket: string, name: string) =>
    !(await supabaseAdmin.storage.from(bucket).download(name)).error;

  /** Attend un état terminal ; en cas de dépassement, échoue avec le dernier état observé. */
  async function waitTerminal(bucket: string, name: string, until: (r: Row) => boolean, label: string) {
    const started = Date.now();
    let last: Row | null = null;
    while (Date.now() - started < TERMINAL_TIMEOUT_MS) {
      last = await rowOf(bucket, name);
      if (last && until(last)) return last;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error(
      `TIMEOUT after ${TERMINAL_TIMEOUT_MS} ms waiting for "${label}" on ${bucket}/${name}. ` +
        `Last observed state: ${JSON.stringify(last)}. ` +
        'retry_attempts>=1 means the SQL trigger fired; if the status is still pending the pg_net -> Edge hop ' +
        '(URL, secret, apikey, network route) is the suspect — see the CI "PG to Edge" step output.',
    );
  }

  async function put(bucket: string, name: string, bytes: Uint8Array, contentType: string) {
    const { error } = await ownerClient.storage.from(bucket).upload(name, bytes, { contentType, upsert: false });
    if (error) throw new Error(`fixture upload failed for ${bucket}/${name}: ${error.message}`);
    objects.push({ bucket, name });
  }

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
    if (owner) await deleteTestUser(owner.user.id);
  });

  it('a genuine JPEG upload ends as validated through the automatic webhook, then becomes readable', async () => {
    const name = `${owner.user.id}/auto-ok-${Date.now()}.jpg`;
    await put('chat-files', name, JPEG, 'image/jpeg');

    const row = await waitTerminal('chat-files', name, (r) => r.status !== 'pending', 'terminal state');
    expect(row.status).toBe('validated');
    expect(row.retry_attempts).toBeGreaterThanOrEqual(1);

    const signed = await ownerClient.storage.from('chat-files').createSignedUrl(name, 60);
    expect(signed.data?.signedUrl).toBeTruthy();
  });

  it('a PNG declared as JPEG ends as rejected and is deleted by the automatic webhook', async () => {
    const name = `${owner.user.id}/auto-bad-${Date.now()}.jpg`;
    await put('chat-files', name, PNG, 'image/jpeg');

    const row = await waitTerminal(
      'chat-files',
      name,
      (r) => r.status === 'rejected' && r.deleted_at !== null,
      'rejected and deleted',
    );
    expect(row.status).toBe('rejected');
    expect(await objectExists('chat-files', name)).toBe(false);

    const signed = await ownerClient.storage.from('chat-files').createSignedUrl(name, 60);
    expect(signed.data?.signedUrl).toBeUndefined();
  });

  it('a genuine PDF in chat-files is validated automatically', async () => {
    const name = `${owner.user.id}/auto-pdf-${Date.now()}.pdf`;
    await put('chat-files', name, PDF, 'application/pdf');
    const row = await waitTerminal('chat-files', name, (r) => r.status !== 'pending', 'terminal state');
    expect(row.status).toBe('validated');
  });

  it('a PDF in residence-photos is refused synchronously by the SQL guard and leaves no state', async () => {
    const name = `${owner.user.id}/auto-ph-${Date.now()}.pdf`;
    const { error } = await ownerClient.storage
      .from('residence-photos')
      .upload(name, PDF, { contentType: 'application/pdf', upsert: false });
    expect(error).not.toBeNull();
    expect(await rowOf('residence-photos', name)).toBeNull();
  });

  it('a genuine photo in residence-photos is validated automatically', async () => {
    const name = `${owner.user.id}/auto-photo-${Date.now()}.jpg`;
    await put('residence-photos', name, JPEG, 'image/jpeg');
    const row = await waitTerminal('residence-photos', name, (r) => r.status !== 'pending', 'terminal state');
    expect(row.status).toBe('validated');
  });
});
