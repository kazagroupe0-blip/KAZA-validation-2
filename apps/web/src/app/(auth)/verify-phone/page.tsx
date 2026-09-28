'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getMyProfile, requestPhoneVerification, verifyPhoneVerification, ApiError } from '@/lib/supabase-api';
import { supabase } from '@/lib/supabase-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';

export default function VerifyPhonePage() {
  const [phone, setPhone] = useState('');
  const [token, setToken] = useState('');
  const [step, setStep] = useState<'loading' | 'request' | 'verify' | 'verified'>('loading');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError) throw authError;
        if (!user) {
          if (!cancelled) {
            setError('Session invalide — reconnectez-vous.');
            setStep('request');
          }
          return;
        }

        const profile = await getMyProfile();
        const profilePhone = profile?.phone?.replace(/\s+/g, '') ?? '';

        if (!profilePhone) {
          if (!cancelled) {
            setError('Ajoutez d’abord un numéro de téléphone dans votre profil.');
            setStep('request');
          }
          return;
        }

        if (!cancelled) {
          setPhone(profilePhone);
          setStep(user.phone === profilePhone && Boolean(user.phone_confirmed_at) ? 'verified' : 'request');
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Impossible de vérifier l’état du téléphone.',
          );
          setStep('request');
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const verifiedPhone = await requestPhoneVerification();
      setPhone(verifiedPhone);
      setToken('');
      setStep('verify');
      toast.info('Code envoyé', 'Un code à 6 chiffres a été envoyé au ' + verifiedPhone + '.');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Envoi impossible',
      );
    } finally {
      setLoading(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await verifyPhoneVerification(phone, token);

      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError) throw authError;

      const normalized = phone.replace(/\s+/g, '');
      if (!user?.phone_confirmed_at || user.phone !== normalized) {
        throw new ApiError(400, 'Le téléphone n’a pas pu être confirmé. Réessayez.');
      }

      setStep('verified');
      toast.success('Numéro activé', 'Votre téléphone peut maintenant servir à la connexion par SMS.');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Code invalide',
      );
    } finally {
      setLoading(false);
    }
  }

  if (step === 'loading') {
    return (
      <div className="space-y-3 text-center">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-kaza-text">
          Vérification du téléphone
        </h1>
        <p className="text-sm text-kaza-muted">Chargement de votre numéro enregistré…</p>
      </div>
    );
  }

  if (step === 'verified') {
    return (
      <div className="space-y-5 text-center">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-kaza-text">
            Numéro activé
          </h1>
          <p className="mt-1 text-sm text-kaza-muted">
            <span className="font-medium text-kaza-text">{phone}</span> est confirmé sur votre compte.
          </p>
        </div>
        <p className="rounded-kaza border border-kaza-border bg-kaza-surface px-4 py-3 text-sm text-kaza-muted">
          Vous pouvez maintenant utiliser « Connexion par SMS » avec ce numéro.
        </p>
        <Button type="button" className="w-full" size="lg" onClick={() => router.push('/explorer')}>
          Retour à KAZA
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-kaza-text">
          Activer mon numéro
        </h1>
        <p className="mt-1 text-sm text-kaza-muted">
          Confirmez que vous contrôlez le numéro enregistré dans votre profil pour activer la connexion par SMS.
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-kaza border border-kaza-danger/30 bg-kaza-danger/10 px-4 py-2.5 text-sm text-kaza-danger"
        >
          {error}
        </p>
      )}

      <div className="rounded-kaza border border-kaza-border bg-kaza-surface px-4 py-3 text-sm">
        <p className="text-xs uppercase tracking-wide text-kaza-muted">Numéro à confirmer</p>
        <p className="mt-1 font-medium text-kaza-text">{phone || 'Aucun numéro enregistré'}</p>
      </div>

      {step === 'request' ? (
        <form onSubmit={requestCode} className="space-y-4">
          <Button type="submit" loading={loading} disabled={!phone} className="w-full btn-responsive-lg" size="lg">
            Recevoir le code par SMS
          </Button>
        </form>
      ) : (
        <form onSubmit={verify} className="space-y-4">
          <Input
            label="Code à 6 chiffres"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            placeholder="000000"
            value={token}
            onChange={(e) => setToken(e.target.value.replace(/\D/g, ''))}
            hint="Le code reçu est à usage unique."
          />
          <Button type="submit" loading={loading} className="w-full btn-responsive-lg" size="lg">
            Confirmer mon numéro
          </Button>
          <button
            type="button"
            onClick={() => {
              setToken('');
              setError(null);
              setStep('request');
            }}
            className="w-full text-center text-sm text-kaza-muted transition-colors hover:text-kaza-text"
          >
            Recommencer
          </button>
        </form>
      )}

      <p className="text-center text-sm text-kaza-muted">
        <Link href="/explorer" className="font-medium text-kaza-brand hover:opacity-80">
          ← Retour à KAZA
        </Link>
      </p>
    </div>
  );
}
