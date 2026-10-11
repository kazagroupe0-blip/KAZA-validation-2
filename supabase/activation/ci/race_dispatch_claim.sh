#!/usr/bin/env bash
# Course RÉELLE entre sessions PostgreSQL (CI jetable uniquement) : plusieurs événements
# d'UNE MÊME génération déclenchent le vrai trigger AFTER UPDATE en parallèle ; la revendication
# atomique du dispatch ne doit consommer qu'UNE tentative et mettre UNE requête en file.
#   usage : race_dispatch_claim.sh <conteneur-db>
# Les requêtes pg_net réellement émises visent une URL locale de CI et un objet inexistant côté
# Storage : le validateur répond sans effet ; les lignes de test sont supprimées en fin de script.
set -euo pipefail

DB="${1:?usage: race_dispatch_claim.sh <db-container>}"
q() { docker exec -i "$DB" psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
name="race-claim/$(date +%s)-$RANDOM.jpg"

cleanup() {
  q <<SQL || true
select set_config('storage.allow_delete_query', 'true', false);
delete from storage.objects where bucket_id = 'chat-files' and name = '$name';
delete from public.storage_upload_validations where bucket_id = 'chat-files' and object_name = '$name';
SQL
}
trap cleanup EXIT

# Objet + état pending (le trigger INSERT revendique une première fois), puis remise à zéro
# du compteur pour observer exclusivement les événements de la course.
q -c "insert into storage.objects (bucket_id, name, version, metadata)
      values ('chat-files', '$name', 'race-ver', '{\"mimetype\":\"image/jpeg\",\"size\":40,\"eTag\":\"e0\"}')"
q -c "update public.storage_upload_validations
         set retry_attempts = 0, dispatched_generation = null, last_request_id = null
       where bucket_id = 'chat-files' and object_name = '$name'"

# N sessions modifient l'eTag (même version) : chacune déclenche le trigger UPDATE du webhook.
pids=()
for i in 1 2 3 4 5; do
  (
    q <<SQL
begin;
update storage.objects set metadata = metadata || '{"eTag":"race-$i"}'
 where bucket_id = 'chat-files' and name = '$name';
select pg_sleep(0.5);
commit;
SQL
  ) &
  pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid"; done

row=$(q -c "select retry_attempts || '|' || coalesce(dispatched_generation, '') || '|' || (last_request_id is not null)
              from public.storage_upload_validations
             where bucket_id = 'chat-files' and object_name = '$name'")
echo "after 5 concurrent events of one generation: attempts|generation|enqueued = $row"
if [ "$row" != "1|race-ver|true" ]; then
  echo "::error::expected exactly one claimed attempt and one enqueued request (1|race-ver|true), got $row"
  exit 1
fi

# Un vrai remplacement (nouvelle version) est revendiqué à nouveau, une seule fois, même en concurrence.
q -c "update public.storage_upload_validations
         set status = 'pending', dispatched_generation = null
       where bucket_id = 'chat-files' and object_name = '$name'" > /dev/null
pids=()
for i in 1 2 3; do
  (
    q <<SQL
begin;
update storage.objects set version = 'race-ver-2', metadata = metadata || '{"eTag":"new-$i"}'
 where bucket_id = 'chat-files' and name = '$name';
select pg_sleep(0.5);
commit;
SQL
  ) &
  pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid"; done

row=$(q -c "select retry_attempts || '|' || coalesce(dispatched_generation, '')
              from public.storage_upload_validations
             where bucket_id = 'chat-files' and object_name = '$name'")
echo "after 3 concurrent events of a new generation: attempts|generation = $row"
if [ "$row" != "2|race-ver-2" ]; then
  echo "::error::expected one more attempt for the new generation (2|race-ver-2), got $row"
  exit 1
fi
echo "dispatch claim race ok"
