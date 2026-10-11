import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  validateUploadContent,
  isUploadBucket,
  MAX_VALIDATED_FILE_SIZE_BYTES,
} from '../supabase/functions/_shared/file-validation';
import {
  detectImageMime,
  MAX_UPLOAD_FILE_SIZE_BYTES,
  MIN_UPLOAD_FILE_SIZE_BYTES,
} from '../packages/shared/src/utils/image-format';

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

  it('enforces exactly 5 MiB on the real bytes (server content check)', () => {
    expect(MAX_VALIDATED_FILE_SIZE_BYTES).toBe(5 * 1024 * 1024);
    const exact = new Uint8Array(MAX_VALIDATED_FILE_SIZE_BYTES);
    exact.set([0xff, 0xd8, 0xff]);
    expect(validateUploadContent({ bucket: 'chat-files', declaredMime: 'image/jpeg', bytes: exact }).ok).toBe(true);
    expect(validateUploadContent({ bucket: 'residence-photos', declaredMime: 'image/jpeg', bytes: exact }).ok).toBe(true);
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

describe('5 MiB functional cap is aligned across server, SQL, local config and clients (static)', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('shared client constants equal the server content cap', () => {
    expect(MAX_UPLOAD_FILE_SIZE_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_UPLOAD_FILE_SIZE_BYTES).toBe(MAX_VALIDATED_FILE_SIZE_BYTES);
    expect(MIN_UPLOAD_FILE_SIZE_BYTES).toBe(12);
  });

  it('local Storage config keeps the 5MiB limit (not raised for CI)', () => {
    expect(read('../supabase/config.toml')).toMatch(/^file_size_limit = "5MiB"$/m);
  });

  it('web clients validate and message 5 Mo, never 8 Mo or 20 Mo', () => {
    for (const rel of [
      '../apps/web/src/components/chat/chat-window.tsx',
      '../apps/web/src/components/property/residence-form.tsx',
      '../apps/web/src/lib/api/chat.ts',
    ]) {
      const src = read(rel);
      expect(src, rel).toMatch(/5 \* 1024 \* 1024/);
      expect(src, rel).not.toMatch(/8 \* 1024 \* 1024|\b8 Mo\b|\b20 Mo\b/);
      expect(src, rel).toContain('5 Mo');
    }
  });

  it('mobile checks the real byte length against the shared 5 MiB cap before upload', () => {
    const src = read('../apps/mobile/lib/storage-upload.ts');
    expect(src).toContain('MAX_UPLOAD_FILE_SIZE_BYTES');
    expect(src).toContain('5 Mo maximum');
    expect(src.indexOf('byteLength > MAX_UPLOAD_FILE_SIZE_BYTES')).toBeLessThan(src.indexOf('detectImageMime('));
  });

  it('SQL guard: final size capped at exactly 5 MiB, provisional contentLength has only an overhead allowance', () => {
    const sql = read('../supabase/migrations/20261010175125_harden_storage_upload_validation.sql');
    expect(sql).not.toMatch(/20 \* 1024 \* 1024/);
    expect(sql).toContain('v_size > 5 * 1024 * 1024 then');
    expect(sql).toContain('v_size > 5 * 1024 * 1024 + 65536');
    const a = read('../supabase/activation/ci/guard_assertions.sql');
    // raw mode : contentLength == size ; multipart : contentLength > size (overhead)
    expect(a).toContain('"size":5242880}');
    expect(a).toContain('"size":5242880,"contentLength":5243200');
    expect(a).toContain('"size":5242881,"contentLength":5242881');
    expect(a).toContain('"size":5242881,"contentLength":5243200');
    expect(a).toContain('"contentLength":5308416');
    expect(a).toContain('"contentLength":5308417');
    expect(a).not.toMatch(/2097\d{3}|21037/);
  });
});

const readSql = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('F05 phase 1 migration static invariants (text checks, SQL is not executed here)', () => {
  const sql = readSql('../supabase/migrations/20261010175125_harden_storage_upload_validation.sql');

  it('is replay-safe: no trigger on storage.objects, cron job or storage policy is created or dropped', () => {
    // Le seul trigger de la migration porte sur la table d'etats propre a F05.
    for (const m of sql.matchAll(/^\s*(?:create|drop) trigger[^;]*;/gim)) {
      expect(m[0]).toContain('storage_upload_validations');
      expect(m[0]).not.toMatch(/storage\.objects/);
    }
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

describe('F05 guard and state machine static invariants (text checks, SQL is not executed here)', () => {
  const sql = readSql('../supabase/migrations/20261010175125_harden_storage_upload_validation.sql');
  const guard = sql.slice(
    sql.indexOf('create or replace function public._guard_storage_upload_f05()'),
    sql.indexOf('create or replace function private.dispatch_storage_validation_webhook()'),
  );

  it('separates the provisional permission check from the final insertion', () => {
    expect(guard).toContain("v_meta->>'size'");
    expect(guard).toContain("v_meta->>'contentLength'");
    const finalBranch = guard.slice(guard.indexOf('if v_size_text is not null then'), guard.indexOf('v_len_text :='));
    const provisionalBranch = guard.slice(guard.indexOf('v_len_text :='));
    expect(finalBranch).toContain('insert into public.storage_upload_validations');
    expect(provisionalBranch).not.toContain('insert into public.storage_upload_validations');
    // La taille definitive est la seule qui fait foi : contentLength n'est lu qu'en l'absence de size.
    expect(guard.indexOf("v_meta->>'contentLength'")).toBeGreaterThan(guard.indexOf('if v_size_text is not null then'));
  });

  it('refuses disallowed MIME before looking at any length, in both phases', () => {
    expect(guard.indexOf('MIME type is not allowed')).toBeLessThan(guard.indexOf("v_meta->>'size'"));
    expect(guard).toMatch(/v_bucket = 'residence-photos' and v_mime = 'application\/pdf'/);
  });

  it('bounds the length text before casting, in both phases', () => {
    expect(guard.match(/length\(v_(size|len)_text\) > 12/g)).toHaveLength(2);
  });

  it('treats contentLength as a request length: multipart overhead tolerated, real size capped at exactly 5 MiB', () => {
    const provisional = guard.slice(guard.indexOf('v_len_text :='));
    const finalBranch = guard.slice(guard.indexOf('if v_size_text is not null then'), guard.indexOf('v_len_text :='));
    // Provisoire : filet = 5 MiB + 64 KiB de surcout multipart ; minimum inchange.
    expect(provisional).toContain('v_size > 5 * 1024 * 1024 + 65536');
    expect(provisional).toContain('v_size < 12');
    // Definitif : 5 MiB exactement, sans marge, et size obligatoire / numerique.
    expect(finalBranch).toContain('v_size > 5 * 1024 * 1024 then');
    expect(finalBranch).not.toContain('65536');
    expect(finalBranch).toContain("v_size_text !~ '^[0-9]+$'");
    expect(finalBranch).not.toContain('contentLength');
  });

  it('documents the raw vs multipart boundary cases in the SQL assertions', () => {
    const a = readSql('../supabase/activation/ci/guard_assertions.sql');
    // brut a la limite : contentLength = size
    expect(a).toContain('"size":5242880}'); // 5 MiB exact accepte
    expect(a).toContain('"size":5242881,"contentLength":5242881'); // brut +1 octet refuse
    // multipart : contentLength > size
    expect(a).toContain('"size":5242880,"contentLength":5243200');
    expect(a).toContain('"size":5242881,"contentLength":5243200');
    expect(a).toContain('"contentLength":5308416');
    expect(a).toContain('"contentLength":5308417');
  });

  it('dispatches on replacement (upsert => ON CONFLICT DO UPDATE) through a narrow AFTER UPDATE trigger', () => {
    const act = readSql('../supabase/activation/f05_activate_storage_validation.sql');
    const t = act.slice(act.indexOf('create trigger "kaza-storage-content-validation-update"'));
    expect(t).toContain('after update on storage.objects');
    expect(t.slice(0, t.indexOf('execute function'))).toContain("(new.metadata->>'size') is not null");
    expect(t.slice(0, t.indexOf('execute function'))).toContain('new.version is distinct from old.version');
    expect(act).toContain('storage.objects.version is required');
    // jamais de trigger sur les triggers existants
    expect(act).not.toMatch(/(create|drop) trigger[^;]*(protect_objects_delete|update_objects_updated_at)/i);
    const sql = readSql('../supabase/migrations/20261010175125_harden_storage_upload_validation.sql');
    const d = sql.slice(
      sql.indexOf('create or replace function private.dispatch_storage_validation_webhook()'),
      sql.indexOf('create or replace function private.retry_stale_storage_validations()'),
    );
    // UPDATE sans etat pending => aucun envoi, aucune exception (pas de boucle, pas de blocage)
    expect(d).toContain("tg_op not in ('INSERT', 'UPDATE')");
    expect(d).toContain("'type', 'INSERT'");
    const rb = readSql('../supabase/activation/f05_rollback_storage_validation.sql');
    expect(rb).toContain('drop trigger if exists "kaza-storage-content-validation-update"');
  });

  it('only dispatches the webhook for the final insertion', () => {
    const dispatch = sql.slice(
      sql.indexOf('create or replace function private.dispatch_storage_validation_webhook()'),
      sql.indexOf('create or replace function private.retry_stale_storage_validations()'),
    );
    expect(dispatch).toContain("(new.metadata->>'size') is null");
    expect(dispatch.indexOf("(new.metadata->>'size') is null")).toBeLessThan(dispatch.indexOf('net.http_post'));
    // L'etat pending est consulte avant la cible Vault : un UPDATE sans pending ne lit pas Vault.
    expect(dispatch.indexOf("status = 'pending'")).toBeLessThan(dispatch.indexOf('private.storage_validation_target()'));
  });

  it('forbids reversing terminal states and re-sends a rejected object whose deletion failed', () => {
    expect(sql).toContain('create trigger storage_validation_state_guard');
    expect(sql).toContain('kaza.f05_reupload');
    expect(sql).toContain('delete_attempts');
    expect(sql).toContain('deleted_at');
    const retry = sql.slice(sql.indexOf('create or replace function private.retry_stale_storage_validations()'));
    expect(retry).toMatch(/where v\.status = 'rejected'\s+and v\.deleted_at is null\s+and v\.delete_attempts < 5/);
  });

  it('binds the local HTTP exception to the REGISTERED activation environment', () => {
    expect(sql).toContain('private.f05_activation');
    expect(sql).toContain('Local HTTP function URL is only allowed for the registered local-test environment');
    expect(sql).toContain("v_env <> 'local-test' or v_expected_ref <> 'localtestrefaaaaaaaa'");
    expect(sql).toContain('must be an anon/publishable key, not a secret key');
  });
});

describe('F05 webhook idempotence static invariants (text checks, SQL is not executed here)', () => {
  const sql = readSql('../supabase/migrations/20261010175125_harden_storage_upload_validation.sql');
  const dispatch = sql.slice(
    sql.indexOf('create or replace function private.dispatch_storage_validation_webhook()'),
    sql.indexOf('create or replace function private.retry_stale_storage_validations()'),
  );
  const retry = sql.slice(sql.indexOf('create or replace function private.retry_stale_storage_validations()'));

  it('adds generation / dispatched_generation / last_request_id columns', () => {
    for (const c of ['generation text', 'dispatched_generation text', 'last_request_id bigint']) {
      expect(sql).toContain(`add column if not exists ${c}`);
    }
  });

  it('claims the dispatch atomically per content generation, before reading Vault', () => {
    const claim = dispatch.indexOf('dispatched_generation is distinct from v_key');
    expect(claim).toBeGreaterThan(-1);
    // un seul UPDATE conditionnel : verification et ecriture ne sont pas separees
    expect(dispatch.slice(0, claim)).toMatch(/update public\.storage_upload_validations/);
    expect(dispatch.slice(0, claim)).toContain("status = 'pending'");
    expect(claim).toBeLessThan(dispatch.indexOf('private.storage_validation_target()'));
    expect(claim).toBeLessThan(dispatch.indexOf('net.http_post'));
    expect(dispatch).toContain('retry_attempts = least(retry_attempts + 1, 5)');
    // un doublon de la meme generation sort sans envoi ; seul un INSERT sans aucun etat est une erreur
    expect(dispatch).toMatch(/tg_op = 'INSERT' and not exists/);
  });

  it('records the pg_net request id and survives an enqueue failure without losing the upload', () => {
    expect(dispatch).toContain('v_req := net.http_post(');
    expect(dispatch).toContain('set last_request_id = v_req');
    expect(dispatch).toMatch(/exception when others then[\s\S]*last_error = left\(sqlerrm, 500\)[\s\S]*last_request_id = null/);
    // la reprise cron n'est PAS soumise a la revendication : c'est une vraie tentative
    expect(retry).not.toContain('dispatched_generation');
    expect(retry.match(/v_req := net\.http_post\(/g)).toHaveLength(2);
  });

  it('upload guard records the generation and resets the dispatch markers on a new upload only', () => {
    const guard = sql.slice(
      sql.indexOf('create or replace function public._guard_storage_upload_f05()'),
      sql.indexOf('create or replace function private.dispatch_storage_validation_webhook()'),
    );
    expect(guard).toContain('private.f05_object_generation(NEW.version::text, v_meta)');
    expect(guard).toContain('generation = excluded.generation');
    expect(guard).toContain('dispatched_generation = null');
    expect(guard).toContain('last_request_id = null');
    expect(sql).toContain('The content generation of a validation state cannot change outside a new upload');
  });

  it('the AFTER UPDATE trigger only fires for content changes (version, eTag, size)', () => {
    const act = readSql('../supabase/activation/f05_activate_storage_validation.sql');
    const when = act.slice(act.indexOf('create trigger "kaza-storage-content-validation-update"'));
    const cond = when.slice(0, when.indexOf('execute function'));
    expect(cond).toContain('new.version is distinct from old.version');
    expect(cond).toContain("(new.metadata->>'eTag') is distinct from (old.metadata->>'eTag')");
    expect(cond).toContain("(new.metadata->>'size') is distinct from (old.metadata->>'size')");
    expect(cond).not.toContain('new.metadata is distinct from old.metadata');
  });

  it('Edge transitions are conditional on the generation read at the start of the processing', () => {
    const src = readFileSync(new URL('../supabase/functions/validate-file-upload/index.ts', import.meta.url), 'utf8');
    expect(src).toContain("select('status, deleted_at, generation')");
    expect(src).toContain('function withGeneration');
    expect(src.match(/withGeneration\(/g)!.length).toBe(2); // markValidated + markRejected
    expect(src).toContain('generation: stateRow.generation ?? null');
    expect(src).toContain('stateRow.generation ?? null, verdict.reason');
  });
});

describe('F05 rollback fail-closed static invariants (text checks, SQL is not executed here)', () => {
  const rb = readSql('../supabase/activation/f05_rollback_storage_validation.sql');

  it('refuses before any protection is removed, inside the transaction, under a share lock', () => {
    const begin = rb.indexOf('begin;');
    const lock = rb.indexOf('lock table public.storage_upload_validations in share mode');
    const guard = rb.indexOf('F05 rollback refused');
    const firstMutation = Math.min(
      ...['drop trigger', 'delete from private.f05_activation', 'create trigger', 'cron.unschedule', 'drop policy']
        .map((m) => rb.indexOf(m))
        .filter((i) => i > -1),
    );
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(lock);
    expect(lock).toBeLessThan(guard);
    expect(guard).toBeLessThan(firstMutation);
    expect(rb).toContain('\\set ON_ERROR_STOP on');
  });

  it('compares real objects on (bucket_id, name) and does not rely on deleted_at', () => {
    const g = rb.slice(rb.indexOf('do $rollback_guard$'), rb.indexOf('$rollback_guard$;', rb.indexOf('do $rollback_guard$') + 10));
    expect(g).toContain('join storage.objects o');
    expect(g).toContain('o.bucket_id = v.bucket_id');
    expect(g).toContain('o.name = v.object_name');
    expect(g).toContain("v.status is distinct from 'validated'");
    expect(g).not.toContain('deleted_at');
    expect(g).toContain("errcode = 'check_violation'");
  });

  it('never deletes user files and clears the marker only after the guard', () => {
    expect(rb).not.toMatch(/delete from storage\.objects/i);
    expect(rb).not.toMatch(/storage\.objects[^;]*\bremove\b/i);
    expect(rb.indexOf('F05 rollback refused')).toBeLessThan(rb.indexOf('delete from private.f05_activation'));
    expect(rb.trim().split('\n').filter((l) => l.trim() === 'commit;')).toHaveLength(1);
  });

  it('is exercised by CI scripts for pending, rejected, injected failure, safe rollback and reactivation', () => {
    const a = readSql('../supabase/activation/ci/rollback_assertions.sh');
    for (const needle of [
      'case 2 ok',
      'case 3 ok',
      'case 5 ok',
      'case 1/4 ok',
      'rejected-present-with-deleted_at',
      'rejected-absent',
      'set local role authenticated',
      'reactivation ok',
    ]) {
      expect(a).toContain(needle);
    }
    expect(a).toContain("as _claims \\gset");
    const wf = readSql('../.github/workflows/f05-storage-validation.yml');
    for (const f of ['rollback_assertions.sh', 'race_dispatch_claim.sh', 'idempotence_assertions', 'enqueue_failure_assertions']) {
      expect(wf).toContain(f);
    }
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
    // Enregistrement de l'environnement AVANT la validation de la cible (qui en depend).
    expect(act.indexOf('insert into private.f05_activation')).toBeLessThan(
      act.indexOf('perform private.storage_validation_target()'),
    );
    expect(act).toMatch(
      /when \(new\.bucket_id in \('residence-photos', 'chat-files'\) and \(new\.metadata->>'size'\) is not null\)/,
    );
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
    expect(rb).toContain('delete from private.f05_activation');
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

  it('uses conditional transitions only: no upsert, never deletes a non-rejected object', () => {
    expect(src).not.toMatch(/\.upsert\(/);
    expect(src).toContain('async function markRejected');
    expect(src.match(/\.eq\('status', 'pending'\)/g)!.length).toBeGreaterThanOrEqual(2);
    // La suppression n'est atteinte que depuis un etat rejected (nouvellement pose ou rejeu).
    const reject = src.slice(src.indexOf('async function rejectAndDelete'), src.indexOf('Deno.serve('));
    expect(reject).toContain("current.status !== 'rejected'");
    expect(reject.indexOf("current.status !== 'rejected'")).toBeLessThan(reject.lastIndexOf('deleteRejectedObject('));
    expect(src).toContain("stateRow.status === 'rejected'");
    expect(src).toContain('deleted_at');
  });
});

describe('F05 CI workflow static invariants (text checks, the workflow is not executed here)', () => {
  const wf = readSql('../.github/workflows/f05-storage-validation.yml');
  const at = (needle: string) => {
    const i = wf.indexOf(needle);
    expect(i, needle).toBeGreaterThan(-1);
    return i;
  };

  it('starts and probes the Edge server and the PG->Edge route before any activation', () => {
    expect(at('name: Serve Edge validator locally')).toBeLessThan(at('name: PG to Edge'));
    expect(at('name: PG to Edge')).toBeLessThan(at('name: Prepare disposable local Vault entries'));
    expect(at('name: Prepare disposable local Vault entries')).toBeLessThan(at('name: Phase 2 - activate'));
  });

  it('prepares the legacy PDF fixture before activation and never targets the fake supabase.co domain', () => {
    expect(at('name: Prepare legacy PDF-in-residence-photos fixture')).toBeLessThan(at('name: Phase 2 - activate'));
    expect(wf).not.toMatch(/localtestrefaaaaaaaa\.supabase\.co/);
  });

  it('stores only the anon key as apikey and discovers the route instead of inventing it', () => {
    expect(wf).toContain("vault.create_secret(:'k', 'kaza_storage_validation_apikey')");
    expect(wf).toContain('-v k="$F05_ANON_KEY"');
    expect(wf).not.toMatch(/kaza_storage_validation_apikey[^\n]*SERVICE/);
    expect(wf).toContain('docker inspect');
    expect(wf).toContain('net._http_response');
  });

  it('runs each SQL assertion file once in the loop, stops at the first error and never hides a failure behind a pipe', () => {
    const loop = wf.slice(wf.indexOf('for f in guard_assertions'), wf.indexOf('          done', wf.indexOf('for f in guard_assertions')));
    const names = ['guard_assertions', 'state_machine_assertions', 'target_assertions', 'retry_assertions', 'idempotence_assertions', 'enqueue_failure_assertions'];
    for (const n of names) expect(loop.match(new RegExp(`\\b${n}\\b`, 'g'))).toHaveLength(1);
    // pas de pipe vers tee : le shell par defaut (bash -e) n'a pas pipefail
    expect(wf).not.toMatch(/psql[^\n]*\|\s*tee/);
    expect(loop).not.toMatch(/\|\s*tee/);
    expect(loop).toContain('exit 1');
    expect(wf).toContain('SET ROLE supabase_admin;');
    expect(wf).toContain('SET ROLE supabase_storage_admin;');
    expect(wf).not.toContain('psql -U supabase_admin -d postgres');
    expect(wf).not.toContain('psql -U supabase_storage_admin -d postgres');
    // seuls rejoues apres reactivation, volontairement et documentes
    expect(wf.match(/ci\/target_assertions\.sql/g)).toHaveLength(1); // le rejeu post-reactivation
    expect(wf).toContain('rejoues APRES la réactivation'.replace('rejoues', 'rejoués'));
  });

  it('reports a not-executed pg_net test and any skipped integration test as NOT a pass', () => {
    expect(wf).toContain('NOT EXECUTED - pg_net enqueue-failure assertions');
    expect(wf).toContain('GITHUB_STEP_SUMMARY');
    const skip = wf.slice(wf.indexOf('name: No skipped F05 integration test'));
    expect(skip).toContain("grep -c '<skipped'");
    expect(skip).toContain('f05-controlled-junit.xml');
    expect(skip).toContain('f05-automatic-junit.xml');
    expect(skip).toContain('exit 1');
    const sqlFile = readSql('../supabase/activation/ci/enqueue_failure_assertions.sql');
    expect(sqlFile).toContain('ENQUEUE_FAILURE_TEST_SKIPPED');
    expect(sqlFile).toContain("then 'true'");
    expect(sqlFile).toContain("else 'false'");
  });

  it('fails the run (explicit gate) when a mandatory assertion was not executed', () => {
    expect(wf).toContain('reports/f05-not-executed.txt');
    const gate = wf.slice(wf.indexOf('name: Final gate'));
    expect(gate.slice(0, gate.indexOf('name: Edge and pg_net diagnostics'))).toContain('exit 1');
    expect(wf.indexOf('name: No skipped F05 integration test')).toBeLessThan(wf.indexOf('name: Final gate'));
    expect(wf.indexOf('name: Final gate')).toBeLessThan(wf.indexOf('name: Upload reports'));
  });

  it('pauses ONLY the two webhook triggers and always resumes them', () => {
    expect(wf).not.toMatch(/disable trigger (all|user)/i);
    const disabled = [...wf.matchAll(/disable trigger "([^"]+)"/gi)].map((m) => m[1]).sort();
    expect(disabled).toEqual(['kaza-storage-content-validation', 'kaza-storage-content-validation-update']);
    expect(wf).toContain('trap resume EXIT');
    expect(wf).toContain("tgenabled = 'D') = 2");
    const controlled = wf.slice(wf.indexOf('name: F05 integration tests - controlled states'), wf.indexOf('name: F05 integration tests - AUTOMATIC path'));
    expect(controlled).toContain('SET ROLE supabase_storage_admin;');
    expect(controlled).toContain('must own storage.objects');
    expect(controlled).not.toContain('psql -U supabase_storage_admin -d postgres');
  });

  it('runs the automatic-path tests with the webhook enabled and the direct tests with it paused', () => {
    expect(wf).toMatch(/disable trigger "kaza-storage-content-validation"/i);
    expect(wf).toMatch(/enable trigger "kaza-storage-content-validation"/i);
    expect(wf).toContain('storage-validation-automatic.test.ts');
    expect(wf).toContain('race_validated_vs_rejected.sh');
  });
});
