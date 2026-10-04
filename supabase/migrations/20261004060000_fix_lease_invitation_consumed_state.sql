-- KAZA: remove the obsolete invitation-state check left by the original
-- lease invitation migration. The lifecycle now supports the one-time
-- consumed state after a lease is created.
--
-- 20261001230000 introduced the accepted/consumed invariant with a new
-- constraint, but the original lease_invitations_check still rejected
-- consumed rows. Drop only that stale constraint; keep the current
-- lifecycle constraints intact.

alter table public.lease_invitations
  drop constraint if exists lease_invitations_check;
