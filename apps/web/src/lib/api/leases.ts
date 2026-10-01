import { supabase } from '../supabase-client';
import type { LeaseWithRelations, Profile } from '../types';
import { normalizeError } from '../supabase-api';

export type LeaseInvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface LeaseInvitationSummary {
  invitation_id: string;
  residence_id: string;
  status: LeaseInvitationStatus;
  expires_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
  created_at: string;
}

export interface CreatedLeaseInvitation {
  invitation_id: string;
  token: string;
  expires_at: string;
}

export interface LeaseInvitationDetails {
  invitation_id: string;
  expires_at: string;
  residence: {
    id: string;
    title: string;
    city: string;
    zone: string | null;
    price_monthly: number;
    deposit: number;
  };
  landlord: {
    full_name: string | null;
  };
}

export async function listMyLeases(): Promise<LeaseWithRelations[]> {
  const { data, error } = await supabase.rpc('list_my_leases');
  if (error) throw normalizeError(error, 'Chargement impossible');
  return (data ?? []) as unknown as LeaseWithRelations[];
}

export async function createLease(input: {
  residence_id: string;
  tenant_id: string;
  start_date: string;
  end_date?: string;
  monthly_rent: number;
  deposit: number;
}): Promise<string> {
  const { data, error } = await supabase.rpc('create_lease', {
    p_residence_id: input.residence_id,
    p_tenant_id: input.tenant_id,
    p_start_date: input.start_date,
    p_end_date: input.end_date,
    p_monthly_rent: input.monthly_rent,
    p_deposit: input.deposit,
  });
  if (error) throw normalizeError(error, 'Bail impossible');
  return data as string;
}

export async function terminateLease(leaseId: string): Promise<void> {
  const { error } = await supabase.rpc('terminate_lease', { p_lease_id: leaseId });
  if (error) throw normalizeError(error, 'Clôture impossible');
}

export async function listTenants(): Promise<Profile[]> {
  const { data, error } = await supabase.rpc('list_tenants');
  if (error) throw normalizeError(error, 'Chargement impossible');
  return (data ?? []) as unknown as Profile[];
}

export async function createLeaseInvitation(residenceId: string): Promise<CreatedLeaseInvitation> {
  const { data, error } = await supabase.rpc('create_lease_invitation', {
    p_residence_id: residenceId,
  });
  if (error) throw normalizeError(error, 'Création du lien impossible');
  return data as unknown as CreatedLeaseInvitation;
}

export async function listLeaseInvitations(residenceId?: string): Promise<LeaseInvitationSummary[]> {
  const { data, error } = await supabase.rpc('list_my_lease_invitations', {
    p_residence_id: residenceId ?? null,
  });
  if (error) throw normalizeError(error, 'Chargement des invitations impossible');
  return (data ?? []) as unknown as LeaseInvitationSummary[];
}

export async function getLeaseInvitation(token: string): Promise<LeaseInvitationDetails> {
  const { data, error } = await supabase.rpc('get_lease_invitation', {
    p_token: token,
  });
  if (error) throw normalizeError(error, 'Invitation invalide ou expirée');
  return data as unknown as LeaseInvitationDetails;
}

export async function acceptLeaseInvitation(token: string): Promise<{
  invitation_id: string;
  residence_id: string;
  accepted_at: string;
}> {
  const { data, error } = await supabase.rpc('accept_lease_invitation', {
    p_token: token,
  });
  if (error) throw normalizeError(error, 'Acceptation impossible');
  return data as {
    invitation_id: string;
    residence_id: string;
    accepted_at: string;
  };
}

export async function revokeLeaseInvitation(invitationId: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_lease_invitation', {
    p_invitation_id: invitationId,
  });
  if (error) throw normalizeError(error, 'Révocation impossible');
}
