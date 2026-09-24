'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from './supabase-client';
import type { Profile, Role } from './types';
import { getMyProfile } from './supabase-api';

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
  const refreshGeneration = useRef(0);
  const router = useRouter();

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    // getUser() valide le JWT côté serveur (plus sûr que getSession, autorisé localement).
    const { data: { user } } = await supabase.auth.getUser();
    if (generation !== refreshGeneration.current) return;

    if (!user) {
      setProfile(null);
      setLoading(false);
      return;
    }

    try {
      // note : le profil (rôle) vient de la table profiles — source de vérité unique.
      const me = await getMyProfile();
      if (generation !== refreshGeneration.current) return;
      setProfile(me);
    } catch {
      if (generation !== refreshGeneration.current) return;
      await supabase.auth.signOut();
      if (generation !== refreshGeneration.current) return;
      setProfile(null);
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
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
    // Invalider les refreshes déjà lancés afin qu'une réponse plus ancienne
    // ne puisse pas réinjecter un profil périmé après une sauvegarde réussie.
    refreshGeneration.current += 1;
    setProfile(nextProfile);
    setLoading(false);
  }, []);

  const signOut = useCallback(async () => {
    refreshGeneration.current += 1;
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