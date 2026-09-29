import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from './supabase-client';

export type AuthenticatedUser = {
  id: string;
  email: string | null;
  phone: string | null;
  phone_confirmed_at: string | null;
};

/**
 * Extract authenticated user from the browser session.
 * Throws a user-facing error if not authenticated.
 * Centralizes the repeated getUser + null-check pattern across API modules.
 */
export async function requireUser(
  client: SupabaseClient = supabase,
): Promise<AuthenticatedUser> {
  const {
    data: { user },
  } = await client.auth.getUser();

  if (!user) throw new Error('Connectez-vous pour effectuer cette action');

  return {
    id: user.id,
    email: user.email ?? null,
    phone: user.phone ?? null,
    phone_confirmed_at: user.phone_confirmed_at ?? null,
  };
}