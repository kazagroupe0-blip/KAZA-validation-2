#!/usr/bin/env bash
# Assertions du rollback FAIL-CLOSED sur une base locale JETABLE déjà ACTIVÉE (local-test).
#   usage : rollback_assertions.sh <conteneur-db>
# Chaque refus est vérifié par un instantané du catalogue (triggers, politiques, cron, marqueur
# d'activation) identique avant/après, et par une lecture RLS réelle en rôle authenticated.
# Le script se termine par une réactivation et une comparaison avec l'instantané initial.
set -euo pipefail

DB="${1:?usage: rollback_assertions.sh <db-container>}"
ACT="supabase/activation"
q() { docker exec -i "$DB" psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
fail() { echo "::error::$*"; exit 1; }

UID1="00000000-0000-4000-8000-0000000000a1"
UID2="00000000-0000-4000-8000-0000000000a2"

snapshot() {
  q <<'SQL'
select md5(string_agg(x, E'\n' order by x)) from (
  select 'trg:' || t.tgname || ':' || t.tgenabled || ':' || p.proname
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'storage.objects'::regclass and not t.tgisinternal
  union all
  select 'pol:' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '')
    from pg_policies where schemaname = 'storage' and tablename = 'objects'
  union all
  select 'cron:' || jobname || ':' || schedule || ':' || active from cron.job
  union all
  select 'reg:' || target_env || ':' || project_ref from private.f05_activation
) s(x);
SQL
}

# Nombre d'objets de l'utilisateur visibles par RLS (rôle authenticated, sub = uuid).
rls_visible() {
  q -v uid="$1" <<'SQL'
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'uid', 'role', 'authenticated')::text, true);
select count(*) from storage.objects where bucket_id = 'chat-files' and name like :'uid' || '/%';
rollback;
SQL
}

obj() { # uid name status  -> objet réel + état souhaité
  q -v uid="$1" -v n="$2" <<'SQL' > /dev/null
insert into storage.objects (bucket_id, name, version, metadata)
values ('chat-files', :'uid' || '/' || :'n', 'rb-' || :'n', '{"mimetype":"image/jpeg","size":40,"eTag":"x"}');
SQL
  case "$3" in
    pending) ;;
    validated)
      q -v uid="$1" -v n="$2" <<'SQL' > /dev/null
update public.storage_upload_validations set status = 'validated', validated_at = now()
 where bucket_id = 'chat-files' and object_name = :'uid' || '/' || :'n';
SQL
      ;;
    rejected-present-with-deleted_at)  # état incohérent : deleted_at renseigné alors que l'objet existe
      q -v uid="$1" -v n="$2" <<'SQL' > /dev/null
update public.storage_upload_validations set status = 'rejected', rejection_reason = 'ci', deleted_at = now()
 where bucket_id = 'chat-files' and object_name = :'uid' || '/' || :'n';
SQL
      ;;
    rejected-absent)
      q -v uid="$1" -v n="$2" <<'SQL' > /dev/null
update public.storage_upload_validations set status = 'rejected', rejection_reason = 'ci'
 where bucket_id = 'chat-files' and object_name = :'uid' || '/' || :'n';
select set_config('storage.allow_delete_query', 'true', false);
delete from storage.objects where bucket_id = 'chat-files' and name = :'uid' || '/' || :'n';
SQL
      ;;
    legacy-no-state)
      q -v uid="$1" -v n="$2" <<'SQL' > /dev/null
delete from public.storage_upload_validations
 where bucket_id = 'chat-files' and object_name = :'uid' || '/' || :'n';
SQL
      ;;
    *) fail "unknown fixture state $3" ;;
  esac
}

wipe() {
  q -v a="$UID1" -v b="$UID2" <<'SQL' > /dev/null
select set_config('storage.allow_delete_query', 'true', false);
delete from storage.objects where bucket_id = 'chat-files' and (name like :'a' || '/%' or name like :'b' || '/%');
delete from public.storage_upload_validations where bucket_id = 'chat-files' and (object_name like :'a' || '/%' or object_name like :'b' || '/%');
SQL
}
trap 'wipe || true; q -c "drop trigger if exists ci_f05_fail_rollback on private.f05_activation" -c "drop function if exists public.ci_f05_fail_rollback()" > /dev/null 2>&1 || true' EXIT

activate() {
  docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -v target_env=local-test -v expected_ref=localtestrefaaaaaaaa < "$ACT/f05_activate_storage_validation.sql" > /dev/null
}
rollback_script() {
  docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$ACT/f05_rollback_storage_validation.sql"
}

wipe
S0=$(snapshot)
[ -n "$S0" ] || fail "empty initial snapshot"

# ---- Cas 2 : objet PENDING encore présent -> refus, rien ne change, lecture toujours bloquée.
obj "$UID1" ok.jpg validated
obj "$UID1" pend.jpg pending
obj "$UID2" legacy.jpg legacy-no-state
[ "$(rls_visible "$UID1")" = "1" ] || fail "positive control: the validated object must be readable by its owner under F05"
if rollback_script > /tmp/rb2.log 2>&1; then fail "case 2: rollback accepted with a pending object present"; fi
grep -q "F05 rollback refused" /tmp/rb2.log || { cat /tmp/rb2.log; fail "case 2: refusal message missing"; }
[ "$(snapshot)" = "$S0" ] || fail "case 2: the catalog changed after a refused rollback"
[ "$(rls_visible "$UID1")" = "1" ] || fail "case 2: only the validated object may be readable (pending must stay blocked)"
echo "case 2 ok: pending object present -> rollback refused, F05 intact"

# ---- Cas 3 : REJECTED présent avec deleted_at incohérent -> refus (deleted_at n'est pas une preuve).
obj "$UID1" rej.jpg rejected-present-with-deleted_at
q -v uid="$UID1" <<'SQL' > /dev/null
select set_config('storage.allow_delete_query', 'true', false);
delete from storage.objects where bucket_id = 'chat-files' and name = :'uid' || '/pend.jpg';
delete from public.storage_upload_validations where bucket_id = 'chat-files' and object_name = :'uid' || '/pend.jpg';
SQL
if rollback_script > /tmp/rb3.log 2>&1; then fail "case 3: rollback accepted with a rejected object still present"; fi
grep -q "F05 rollback refused" /tmp/rb3.log || fail "case 3: refusal message missing"
[ "$(snapshot)" = "$S0" ] || fail "case 3: the catalog changed after a refused rollback"
[ "$(rls_visible "$UID1")" = "1" ] || fail "case 3: the rejected object must stay unreadable (only the validated one is visible)"
echo "case 3 ok: rejected object present (deleted_at set) -> rollback refused, access still blocked"

# ---- Cas 5 : échec EN COURS de rollback -> aucune restauration partielle.
wipe
obj "$UID1" ok.jpg validated
q <<'SQL' > /dev/null
create function public.ci_f05_fail_rollback() returns trigger language plpgsql as $$
begin raise exception 'CI-only injected failure in the middle of the rollback'; end $$;
create trigger ci_f05_fail_rollback before delete on private.f05_activation
  for each row execute function public.ci_f05_fail_rollback();
SQL
if rollback_script > /tmp/rb5.log 2>&1; then fail "case 5: rollback succeeded despite the injected failure"; fi
grep -q "injected failure" /tmp/rb5.log || { cat /tmp/rb5.log; fail "case 5: the injected failure did not occur where expected"; }
[ "$(snapshot)" = "$S0" ] || fail "case 5: a failed rollback left a partially restored configuration"
q -c "drop trigger ci_f05_fail_rollback on private.f05_activation" -c "drop function public.ci_f05_fail_rollback()" > /dev/null
echo "case 5 ok: failure in the middle of the rollback -> everything rolled back"

# ---- Cas 1 + 4 : rollback sûr (validés + historique sans état + rejeté RÉELLEMENT absent).
wipe
obj "$UID1" ok.jpg validated
obj "$UID1" gone.jpg rejected-absent
obj "$UID2" legacy.jpg legacy-no-state
rollback_script > /tmp/rb1.log 2>&1 || { cat /tmp/rb1.log; fail "case 1/4: a safe rollback was refused"; }
q <<'SQL' > /dev/null
do $$
begin
  assert (select p.proname::text from pg_trigger t join pg_proc p on p.oid = t.tgfoid
           where t.tgrelid = 'storage.objects'::regclass and t.tgname = 'guard_storage_upload') = '_guard_storage_upload',
    'rollback must restore the original guard';
  assert not exists (select 1 from pg_trigger where tgname like 'kaza-storage-content-validation%' and not tgisinternal),
    'rollback must remove both webhook triggers';
  assert not exists (select 1 from private.f05_activation), 'rollback must clear the activation marker';
  assert not exists (select 1 from cron.job where jobname = 'storage-validation-retry-every-minute'), 'rollback must remove the retry job';
  assert not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                       and coalesce(qual, '') like '%storage_upload_validation_allows_read%'),
    'rollback must restore the pre-F05 read policies';
  assert exists (select 1 from public.storage_upload_validations where object_name like '%/gone.jpg' and status = 'rejected'),
    'validation rows are kept as audit trail';
end $$;
SQL
echo "case 1/4 ok: safe rollback (validated + legacy + absent rejected) succeeded and restored the historical configuration"

# ---- Réactivation : les invariants d'activation sont conservés.
wipe
activate
[ "$(snapshot)" = "$S0" ] || fail "reactivation did not restore the initial activated catalog snapshot"
echo "reactivation ok: catalog snapshot identical to the initial activated state"
echo "rollback assertions ok"
