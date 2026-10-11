-- Assertions SQL de la cible webhook (private.storage_validation_target) selon l'environnement
-- ENREGISTRÉ par l'activation. CI jetable uniquement, base locale activée en local-test, avec un
-- URL http locale et (optionnellement) une clé apikey anon/publishable dans Vault.
--   psql -v ON_ERROR_STOP=1 -f supabase/activation/ci/target_assertions.sql
-- Les modifications de Vault et de private.f05_activation sont annulées en fin de script.
begin;

create function pg_temp.vault_set(p_name text, p_value text)
returns void language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then
    perform vault.create_secret(p_value, p_name);
  else
    perform vault.update_secret(v_id, p_value);
  end if;
end $$;

create function pg_temp.must_raise(p_pattern text, p_label text)
returns void language plpgsql as $$
begin
  begin
    perform private.storage_validation_target();
  exception when others then
    if sqlerrm like p_pattern then
      return;
    end if;
    raise exception 'ASSERTION FAILED (%): wrong error: %', p_label, sqlerrm;
  end;
  raise exception 'ASSERTION FAILED (target must be refused): %', p_label;
end $$;

-- Base de départ : activation enregistrée = local-test (exigée par ce script).
do $$
begin
  assert (select target_env from private.f05_activation) = 'local-test', 'script requires a local-test activation';
  assert (select o_url from private.storage_validation_target()) ~ '^http://',
    'CI is expected to use the reachable local HTTP route';
end $$;

-- 1) La cible locale n'est valable QUE pour l'environnement enregistré local-test.
update private.f05_activation set target_env = 'test', project_ref = 'bzvlnefowgtuasqjfpem';
select pg_temp.vault_set('kaza_storage_validation_expected_project_ref', 'bzvlnefowgtuasqjfpem');
select pg_temp.must_raise('Local HTTP function URL is only allowed%', 'remote test environment refuses a local HTTP URL');

update private.f05_activation set target_env = 'production', project_ref = 'qbogbuwnkwqgarbchtyr';
select pg_temp.vault_set('kaza_storage_validation_expected_project_ref', 'qbogbuwnkwqgarbchtyr');
select pg_temp.must_raise('Local HTTP function URL is only allowed%', 'production refuses a local HTTP URL');

-- 2) Une URL https reste valable si son ref est celui de l'environnement enregistré ; sinon refusée.
select pg_temp.vault_set('kaza_storage_validation_function_url',
  'https://qbogbuwnkwqgarbchtyr.supabase.co/functions/v1/validate-file-upload-v2');
do $$ begin perform private.storage_validation_target(); end $$;
select pg_temp.vault_set('kaza_storage_validation_function_url',
  'https://bzvlnefowgtuasqjfpem.supabase.co/functions/v1/validate-file-upload-v2');
select pg_temp.must_raise('%targets a different project%', 'production refuses another project URL');
select pg_temp.vault_set('kaza_storage_validation_function_url',
  'http://evil.example:80/functions/v1/validate-file-upload');
select pg_temp.must_raise('Local HTTP function URL is only allowed%', 'production refuses any http URL');
select pg_temp.vault_set('kaza_storage_validation_function_url',
  'https://qbogbuwnkwqgarbchtyr.supabase.co.evil.example/functions/v1/validate-file-upload');
select pg_temp.must_raise('%missing or malformed%', 'suffix domain trick refused');

-- 3) Divergence entre l'enregistrement et le ref Vault.
update private.f05_activation set target_env = 'production', project_ref = 'qbogbuwnkwqgarbchtyr';
select pg_temp.vault_set('kaza_storage_validation_function_url',
  'https://qbogbuwnkwqgarbchtyr.supabase.co/functions/v1/validate-file-upload');
select pg_temp.vault_set('kaza_storage_validation_expected_project_ref', 'bzvlnefowgtuasqjfpem');
select pg_temp.must_raise('%differs from the registered activation%', 'Vault ref differs from registered activation');

-- 4) Aucune activation enregistrée => aucune cible.
delete from private.f05_activation;
select pg_temp.must_raise('Storage validation is not activated%', 'no registration');

-- 5) Retour à local-test : la cible locale redevient valide, avec la clé apikey anon.
insert into private.f05_activation (singleton, target_env, project_ref) values (true, 'local-test', 'localtestrefaaaaaaaa');
select pg_temp.vault_set('kaza_storage_validation_expected_project_ref', 'localtestrefaaaaaaaa');
select pg_temp.vault_set('kaza_storage_validation_function_url', 'http://kong:8000/functions/v1/validate-file-upload-v2');
do $$ begin perform private.storage_validation_target(); end $$;

-- 6) Clé apikey : jamais une clé secrète / service_role.
select pg_temp.vault_set('kaza_storage_validation_apikey', 'sb_secret_' || repeat('x', 30));
select pg_temp.must_raise('%not a secret key%', 'sb_secret_ key refused');

select pg_temp.vault_set('kaza_storage_validation_apikey',
  translate(rtrim(encode(convert_to('{"alg":"HS256","typ":"JWT"}', 'utf8'), 'base64'), '='), '+/', '-_') || '.'
  || translate(rtrim(encode(convert_to('{"role":"service_role"}', 'utf8'), 'base64'), '='), '+/', '-_')
  || '.sig');
select pg_temp.must_raise('%must carry the anon role%', 'service_role JWT refused');

select pg_temp.vault_set('kaza_storage_validation_apikey', 'not-a-key');
select pg_temp.must_raise('%unrecognised format%', 'garbage apikey refused');

select pg_temp.vault_set('kaza_storage_validation_apikey', 'sb_publishable_' || repeat('x', 30));
do $$ begin perform private.storage_validation_target(); end $$;

select pg_temp.vault_set('kaza_storage_validation_apikey',
  translate(rtrim(encode(convert_to('{"alg":"HS256","typ":"JWT"}', 'utf8'), 'base64'), '='), '+/', '-_') || '.'
  || translate(rtrim(encode(convert_to('{"role":"anon"}', 'utf8'), 'base64'), '='), '+/', '-_')
  || '.sig');
do $$ begin perform private.storage_validation_target(); end $$;

-- 7) Le rôle des clients n'a aucun accès à ces fonctions ni à l'enregistrement.
do $$
begin
  assert not has_function_privilege('anon', 'private.storage_validation_target()', 'execute');
  assert not has_function_privilege('authenticated', 'private.storage_validation_target()', 'execute');
  assert not has_function_privilege('service_role', 'private.storage_validation_target()', 'execute');
  assert not has_table_privilege('authenticated', 'private.f05_activation', 'select');
  assert not has_table_privilege('service_role', 'private.f05_activation', 'select');
end $$;

rollback;
