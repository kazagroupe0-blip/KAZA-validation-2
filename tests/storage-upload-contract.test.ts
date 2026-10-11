import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  validateUploadContent,
  isUploadBucket,
  MAX_VALIDATED_FILE_SIZE_BYTES,
} from '../supabase/functions/_shared/file-validation';
import { detectImageMime } from '../packages/shared/src/utils/image-format';

const pad = (head: number[], total = 32) =>
  Uint8Array.from([...head, ...new Array(Math.max(0, total - head.length)).fill(0)]);

const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = pad([0x25, 0x50, 0x44, 0x46, 0x2d]);
const WEBP = pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const HEIC = pad([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);

describe('per-bucket content contract', () => {
  it('residence-photos accepts JPEG/PNG/WEBP only', () => {
    expect(validateUploadContent({ bucket: 'residence-photos', declaredMime: 'image/jpeg', bytes: JPEG }).ok).toBe(true);
    expect(validateUploadContent({ bucket: 'residence-photos', declaredMime: 'image/png', bytes: PNG }).ok).toBe(true);
    expect(validateUploadContent({ bucket: 'residence-photos', declaredMime: 'image/webp', bytes: WEBP }).ok).toBe(true);
    expect(validateUploadContent({ bucket: 'residence-photos', declaredMime: 'application/pdf', bytes: PDF }).ok).toBe(false);
  });

  it('chat-files accepts images and PDF', () => {
    for (const [mime, bytes] of [
      ['image/jpeg', JPEG],
      ['image/png', PNG],
      ['image/webp', WEBP],
      ['application/pdf', PDF],
    ] as const) {
      expect(validateUploadContent({ bucket: 'chat-files', declaredMime: mime, bytes }).ok).toBe(true);
    }
  });

  it('rejects a declared MIME that disagrees with the real bytes', () => {
    expect(validateUploadContent({ bucket: 'residence-photos', declaredMime: 'image/jpeg', bytes: PNG })).toEqual({
      ok: false,
      reason: 'declared MIME does not match detected file content',
    });
  });

  it('rejects missing or non-string declared MIME and normalizes case/whitespace', () => {
    for (const declaredMime of [undefined, null, '', '   ', 42, {}]) {
      expect(validateUploadContent({ bucket: 'chat-files', declaredMime, bytes: JPEG }).ok).toBe(false);
    }
    expect(validateUploadContent({ bucket: 'chat-files', declaredMime: ' IMAGE/JPEG ', bytes: JPEG }).ok).toBe(true);
  });

  it('rejects unsupported or malformed content', () => {
    expect(validateUploadContent({ bucket: 'chat-files', declaredMime: 'image/jpeg', bytes: HEIC }).ok).toBe(false);
    expect(validateUploadContent({ bucket: 'chat-files', declaredMime: 'image/jpeg', bytes: new Uint8Array(5) }).ok).toBe(false);
    expect(validateUploadContent({ bucket: 'chat-files', declaredMime: 'image/jpeg', bytes: new Uint8Array(0) }).ok).toBe(false);
    const wav = pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(validateUploadContent({ bucket: 'chat-files', declaredMime: 'image/webp', bytes: wav }).ok).toBe(false);
  });

  it('rejects files above the 20 MiB server limit', () => {
    const big = new Uint8Array(MAX_VALIDATED_FILE_SIZE_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(validateUploadContent({ bucket: 'chat-files', declaredMime: 'image/jpeg', bytes: big }).ok).toBe(false);
  });

  it('only treats the two known buckets as validated buckets', () => {
    expect(isUploadBucket('chat-files')).toBe(true);
    expect(isUploadBucket('residence-photos')).toBe(true);
    for (const other of ['receipts', '', undefined, null, 1]) expect(isUploadBucket(other)).toBe(false);
  });
});

describe('client-side real image format detection', () => {
  it('detects JPEG/PNG/WEBP from bytes and ignores everything else', () => {
    expect(detectImageMime(JPEG)).toBe('image/jpeg');
    expect(detectImageMime(PNG)).toBe('image/png');
    expect(detectImageMime(WEBP)).toBe('image/webp');
    expect(detectImageMime(PDF)).toBeNull();
    expect(detectImageMime(HEIC)).toBeNull();
    expect(detectImageMime(new Uint8Array(0))).toBeNull();
    expect(detectImageMime(Uint8Array.from([0xff, 0xd8]))).toBeNull();
  });
});

const readSql = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('F05 phase 1 migration static invariants (text checks, SQL is not executed here)', () => {
  const sql = readSql('../supabase/migrations/20261010175125_harden_storage_upload_validation.sql');

  it('is replay-safe: no trigger, cron job or storage policy is created or dropped', () => {
    expect(sql).not.toMatch(/^\s*create trigger/im);
    expect(sql).not.toMatch(/^\s*drop trigger/im);
    expect(sql).not.toMatch(/cron\.schedule|cron\.unschedule/i);
    expect(sql).not.toMatch(/on storage\.objects/i);
    expect(sql).not.toMatch(/raise exception 'pg_cron is required/);
  });

  it('never hardcodes a project ref or functions URL', () => {
    expect(sql).not.toMatch(/bzvlnefowgtuasqjfpem|qbogbuwnkwqgarbchtyr/);
    expect(sql).not.toMatch(/'https:\/\/[a-z0-9]{20}\.supabase\.co/);
  });

  it('validates the Vault URL against an explicit expected project ref in dispatch and retry', () => {
    expect(sql).toContain('kaza_storage_validation_expected_project_ref');
    expect(sql).toContain('targets a different project');
    expect(sql.match(/private\.storage_validation_target\(\)/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps privileged tokens out of the webhook', () => {
    expect(sql).not.toMatch(/'authorization'/i);
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(sql).toContain('x-storage-validation-secret');
  });

  it('defines the F05 guard under a new name without rebinding the existing trigger', () => {
    expect(sql).toContain('public._guard_storage_upload_f05()');
    expect(sql).not.toMatch(/function public\._guard_storage_upload\(\)/);
    expect(sql).toMatch(/v_bucket = 'residence-photos' and v_mime = 'application\/pdf'/);
    expect(sql).toMatch(/length\(v_size_text\) > 12/);
  });

  it('revokes SECURITY DEFINER helpers from client roles', () => {
    expect(sql).toMatch(
      /revoke all on function private\.storage_validation_target\(\)\s+from public, anon, authenticated, service_role/,
    );
    expect(sql).toMatch(
      /revoke all on function private\.dispatch_storage_validation_webhook\(\)\s+from public, anon, authenticated/,
    );
  });
});

describe('F05 phase 2 activation script static invariants', () => {
  const act = readSql('../supabase/activation/f05_activate_storage_validation.sql');

  it('lives outside supabase/migrations and runs in a single transaction', () => {
    expect(act).toMatch(/^begin;$/m);
    expect(act).toMatch(/^commit;$/m);
    expect(act.indexOf('begin;')).toBeLessThan(act.indexOf('$check$'));
    expect(act.indexOf('$check$;')).toBeLessThan(act.indexOf('create trigger guard_storage_upload'));
  });

  it('ties each environment to its own project ref and cross-checks Vault', () => {
    expect(act).toMatch(/when 'production' then 'qbogbuwnkwqgarbchtyr'/);
    expect(act).toMatch(/when 'test' then 'bzvlnefowgtuasqjfpem'/);
    expect(act).toContain('expected_ref does not match target_env');
    expect(act).toContain('Vault expected project ref differs');
    expect(act).toContain('perform private.storage_validation_target()');
  });

  it('checks every prerequisite before touching triggers or policies', () => {
    const check = act.slice(0, act.indexOf('$check$;'));
    for (const needle of ['pg_cron is required', 'pg_net', 'phase 1 migration not applied', 'storage buckets are missing']) {
      expect(check).toContain(needle);
    }
    const mutations = act.slice(act.indexOf('$check$;'));
    expect(mutations).toContain('create trigger "kaza-storage-content-validation"');
    expect(mutations).toContain('create policy "chat-files-read-owner"');
    expect(mutations).toContain('attachment.path = objects.name');
    expect(mutations.match(/storage_upload_validation_allows_read\(bucket_id, name\)/g)!.length).toBe(2);
  });

  it('does not touch protect_objects_delete or update_objects_updated_at, and holds no secret', () => {
    const mutations = act.slice(act.indexOf('$check$;'));
    expect(mutations).not.toMatch(/(create|drop) trigger[^;]*(protect_objects_delete|update_objects_updated_at)/i);
    expect(act).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });

  it('has a rollback that restores the original guard and never recreates the legacy webhook', () => {
    const rb = readSql('../supabase/activation/f05_rollback_storage_validation.sql');
    expect(rb).toContain('execute function public._guard_storage_upload();');
    expect(rb).not.toMatch(/create trigger "kaza-storage-content-validation"/);
    expect(rb).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});

describe('validate-file-upload handler static invariants', () => {
  const src = readFileSync(
    new URL('../supabase/functions/validate-file-upload/index.ts', import.meta.url),
    'utf8',
  );

  it('authenticates before reading the body and never overwrites a terminal state', () => {
    expect(src.indexOf('isAuthorizedStorageValidationWebhook(')).toBeLessThan(src.indexOf('req.json()'));
    expect(src).toContain(".eq('status', 'pending')");
    expect(src).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|Authorization/);
  });
});
