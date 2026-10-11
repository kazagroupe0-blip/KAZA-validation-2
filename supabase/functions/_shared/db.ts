import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { resolveAdminSecretKey } from './admin-key.ts';

let client: SupabaseClient | null = null;

/**
 * Client Supabase avec la clé service_role (bypass RLS).
 * Utilisé uniquement côté Edge Functions — jamais exposé au navigateur.
 */
export function getAdminClient(): SupabaseClient {
  if (client) return client;
  const url = Deno.env.get('SUPABASE_URL');
  if (!url) {
    throw new Error('SUPABASE_URL manquant');
  }
  const key = resolveAdminSecretKey({ get: (name) => Deno.env.get(name) });
  client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}
