'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from './supabase-client';
import type { Profile, Role } from './types';
import { getMyProfile } from './supabase-api';
import { logger } from './logger';

export interface AuthState {
  loading: boolean;
  user: Profile | null;
  role: Role | null;
  isPremium: boolean;
  refresh: () => Promise<void>;
  setUserProfile: (profile: Profile) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const refresh = useCallback(async () => {
    // getUser() valide le JWT côté serveur (plus sûr que getSession, autorisé localement)
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setProfile(null);
      setLoading(false);
      return;
    }
    try {
      // note : le profil (rôle) vient de la table profiles — source de vérité unique.
      // getUser() vient de confirmer un JWT valide ; une panne de lecture de profiles
      // ne doit donc pas être transformée en déconnexion artificielle.
      const me = await getMyProfile();
      setProfile(me);
    } catch (error) {
      logger.error('auth_profile_load_failed', {
        error: error instanceof Error ? error : String(error),
        message: 'Impossible de charger le profil après authentification',
      });
      // Conserver le dernier profil connu pendant une panne transitoire du backend.
      // Lors du chargement initial, profile est déjà null et la session reste intacte.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => void refresh());
    return () => subscription.unsubscribe();
  }, [refresh]);

  const setUserProfile = useCallback((nextProfile: Profile) => {
    setProfile(nextProfile);
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
    router.push('/login');
  }, [router]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      user: profile,
      role: profile?.role ?? null,
      isPremium: profile?.is_premium ?? false,
      refresh,
      setUserProfile,
      signOut,
    }),
    [loading, profile, refresh, setUserProfile, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé sous AuthProvider');
  return ctx;
}