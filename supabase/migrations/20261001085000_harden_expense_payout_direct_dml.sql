-- 20261001085000_harden_expense_payout_direct_dml.sql
-- Keep read access for client roles, but remove direct table mutation.
-- Application mutations use SECURITY DEFINER RPCs; landlord_payouts is read
-- directly by the web app and therefore retains SELECT only.
revoke insert, update, delete, truncate, references, trigger
  on public.expenses, public.landlord_payouts
  from anon, authenticated;

do $$
declare
  v_bad_count integer;
begin
  select count(*)
    into v_bad_count
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('expenses', 'landlord_payouts')
     and grantee in ('anon', 'authenticated')
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');

  if v_bad_count <> 0 then
    raise exception 'Unexpected direct DML privileges remain on expenses/landlord_payouts: %', v_bad_count;
  end if;

  if exists (
    select 1
      from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name in ('expenses', 'landlord_payouts')
       and grantee in ('anon', 'authenticated')
       and privilege_type <> 'SELECT'
  ) then
    raise exception 'Client roles have a non-SELECT table privilege on expenses/landlord_payouts';
  end if;
end
$$;