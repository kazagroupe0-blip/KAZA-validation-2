'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from './supabase-client';
import type { Profile, Role } from './types';
import { resolveAuthProfile } from './auth-refresh';

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
    const result = await resolveAuthProfile();

    if (result.kind === 'signed-out') {
      setProfile(null);
    } else if (result.kind === 'authenticated') {
      // note : le profil (rôle) vient de la table profiles — source de vérité unique
      setProfile(result.profile);
    } else {
      // Une panne d'auth/profil ne doit pas détruire une session encore valide.
      // Le prochain événement d'authentification réel recalculera l'état.
      console.error('[KAZA:AUTH] refresh unavailable', result.error);
    }

    setLoading(false);
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