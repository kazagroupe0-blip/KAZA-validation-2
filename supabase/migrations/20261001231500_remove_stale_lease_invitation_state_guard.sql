-- KAZA: remove the pre-existing invitation state constraint that only
-- allowed accepted invitations to retain accepted_by/accepted_at.
-- The lifecycle now permits the one-time consumed state after lease creation.

alter table public.lease_invitations
  drop constraint if exists lease_invitations_state_coherence_check;
