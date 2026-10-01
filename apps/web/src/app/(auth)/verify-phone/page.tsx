'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, requestPhoneChange, verifyPhoneChange } from '@/lib/supabase-api';
import { normalizeBeninPhone, BENIN_PHONE_RE } from '@/lib/phone';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';

function VerifyPhoneForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [token, setToken] = useState('');
  const [step, setStep] = useState<'request' | 'verify'>('request');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const initial = normalizeBeninPhone(searchParams.get('phone') ?? '');
    if (BENIN_PHONE_RE.test(initial)) setPhone(initial);
  }, [searchParams]);

  const next = (() => {
    const value = searchParams.get('next');
    return value && value.startsWith('/') && !value.startsWith('//') ? value : '/profile';
  })();

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    const normalized = normalizeBeninPhone(phone);
    setError(null);
    if (!BENIN_PHONE_RE.test(normalized)) {
      setError('Saisissez un numéro béninois valide au format +229 01 00 00 00 00.');
      return;
    }

    setLoading(true);
    try {
      await requestPhoneChange(normalized);
      setPhone(normalized);
      setStep('verify');
      toast.info('Code envoyé', 'Un code de vérification a été envoyé par SMS.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Envoi du code impossible.');
    } finally {
      setLoading(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await verifyPhoneChange(phone, token);
      toast.success('Numéro vérifié', 'Vous pouvez maintenant vous connecter avec votre numéro et votre mot de passe.');
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Vérification impossible.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-kaza-text">
          {step === 'request' ? 'Activer votre numéro' : 'Vérifiez votre numéro'}
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-kaza-muted">
          {step === 'request'
            ? 'Votre numéro doit être vérifié une fois avant de pouvoir servir à la connexion par mot de passe.'
            : 'Saisissez le code envoyé au ' + phone + '.'}
        </p>
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded-kaza border border-kaza-danger/30 bg-kaza-danger/10 px-4 py-2.5 text-sm text-kaza-danger">
          {error}
        </p>
      )}

      {step === 'request' ? (
        <form onSubmit={(e) => void requestCode(e)} className="space-y-5">
          <Input
            label="Numéro de téléphone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            placeholder="+229 01 00 00 00 00"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <Button type="submit" loading={loading} className="w-full" size="lg">
            Envoyer le code
          </Button>
        </form>
      ) : (
        <form onSubmit={(e) => void verify(e)} className="space-y-5">
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
            hint="Le code reçu par SMS est valable pour cette vérification."
          />
          <Button type="submit" loading={loading} className="w-full" size="lg">
            Vérifier et activer le numéro
          </Button>
          <button
            type="button"
            onClick={() => setStep('request')}
            className="w-full text-center text-sm text-kaza-muted transition-colors hover:text-kaza-text"
          >
            Changer de numéro
          </button>
        </form>
      )}

      <p className="mt-6 text-center text-sm text-kaza-muted">
        <Link href="/profile" className="font-medium text-kaza-brand hover:opacity-80">
          ← Retour à mon profil
        </Link>
      </p>
    </div>
  );
}

export default function VerifyPhonePage() {
  return (
    <Suspense fallback={null}>
      <VerifyPhoneForm />
    </Suspense>
  );
}
