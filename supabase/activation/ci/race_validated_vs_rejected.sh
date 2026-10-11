#!/usr/bin/env bash
# Course RÉELLE entre deux sessions PostgreSQL (CI jetable uniquement) : une transition terminale
# déjà décidée (mais pas encore validée par COMMIT) ne peut pas être renversée par une transition
# concurrente conditionnelle .eq('status','pending') -- exactement la requête du validateur Edge.
#   usage : race_validated_vs_rejected.sh <conteneur-db>
set -euo pipefail

DB="${1:?usage: race_validated_vs_rejected.sh <db-container>}"
q() { docker exec -i "$DB" psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }

race() {
  local first="$1" second="$2"
  local name="race/${first}-then-${second}-$(date +%s)-$RANDOM.jpg"

  q -c "insert into public.storage_upload_validations (bucket_id, object_name, status, declared_mime, byte_size)
        values ('chat-files', '$name', 'pending', 'image/jpeg', 40)"

  # Session A : décide d'abord, garde sa transaction ouverte 3 s avant COMMIT.
  (
    q <<SQL
begin;
update public.storage_upload_validations
   set status = '$first',
       validated_at = case when '$first' = 'validated' then now() end,
       rejection_reason = case when '$first' = 'rejected' then 'race' end
 where bucket_id = 'chat-files' and object_name = '$name' and status = 'pending';
select pg_sleep(3);
commit;
SQL
  ) &
  local pid_a=$!
  sleep 1

  # Session B : même transition conditionnelle que le validateur. Elle attend le verrou de A,
  # puis réévalue sa clause WHERE : plus aucune ligne pending -> 0 ligne mise à jour.
  local matched
  matched=$(q -c "update public.storage_upload_validations
                     set status = '$second',
                         validated_at = case when '$second' = 'validated' then now() end,
                         rejection_reason = case when '$second' = 'rejected' then 'race' end
                   where bucket_id = 'chat-files' and object_name = '$name' and status = 'pending'
                   returning object_name")
  wait "$pid_a"

  local final
  final=$(q -c "select status from public.storage_upload_validations where bucket_id = 'chat-files' and object_name = '$name'")

  q -c "delete from public.storage_upload_validations where object_name = '$name'"

  if [ -n "$matched" ]; then
    echo "::error::race $first/$second: the second transition matched a row that was already decided"
    exit 1
  fi
  if [ "$final" != "$first" ]; then
    echo "::error::race $first/$second: final state is '$final', expected '$first'"
    exit 1
  fi
  echo "race ok: first=$first second=$second -> second matched 0 rows, final=$final"
}

race validated rejected
race rejected validated
