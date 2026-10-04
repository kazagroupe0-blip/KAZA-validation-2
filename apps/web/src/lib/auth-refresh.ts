import { supabase } from './supabase-client';
import { getMyProfile } from './api/auth';
import type { Profile } from './types';

export type AuthRefreshResult =
  | { kind: 'signed-out' }
  | { kind: 'unavailable'; error: unknown }
  | { kind: 'authenticated'; profile: Profile | null }
  | { kind: 'profile-unavailable'; error: unknown };

/**
 * Résout l'état d'authentification sans confondre une panne réseau/profil
 * avec une session invalide.
 */
export async function resolveAuthProfile(): Promise<AuthRefreshResult> {
  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error) {
      return { kind: 'unavailable', error };
    }

    if (!user) {
      return { kind: 'signed-out' };
    }

    try {
      return { kind: 'authenticated', profile: await getMyProfile() };
    } catch (error) {
      return { kind: 'profile-unavailable', error };
    }
  } catch (error) {
    return { kind: 'unavailable', error };
  }
}
