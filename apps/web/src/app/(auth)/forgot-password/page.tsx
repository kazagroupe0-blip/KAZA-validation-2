'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { requestPasswordReset, ApiError } from '@/lib/supabase-api';
import { env } from '@/lib/env';
import { useVisibleHcaptcha } from '@/components/ui/hcaptcha';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [captchaTokenVisible, setCaptchaTokenVisible] = useState('');
  const toast = useToast();
  const visibleHcaptcha = useVisibleHcaptcha(
    'kaza-hcaptcha-recovery',
    env.hcaptchaSitekey,
    setCaptchaTokenVisible,
  );

  useEffect(() => {
    if (env.hcaptchaSitekey) void visibleHcaptcha.render();
  }, [visibleHcaptcha]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Saisissez une adresse email valide.');
      return;
    }

    if (env.hcaptchaSitekey && !captchaTokenVisible) {
      setError('Vérification anti-robot requise. Cochez la case « Je suis un humain ».');
      return;
    }

    setLoading(true);
    try {
      const redirectTo = `${window.location.origin}/auth/callback?next=/reset-password`;
      await requestPasswordReset(trimmed, captchaTokenVisible, redirectTo);
      visibleHcaptcha.reset();
      setCaptchaTokenVisible('');
      setSent(true);
      toast.success('Email envoyé', 'Vérifiez votre boîte de réception.');
    } catch (err) {
      visibleHcaptcha.reset();
      setCaptchaTokenVisible('');
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

  if (sent) {
    return (
      <div className="space-y-5 text-center">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-kaza-text">
          Vérifiez votre boîte mail
        </h1>
        <p className="text-sm text-kaza-muted">
          Nous avons envoyé un lien de réinitialisation à{' '}
          <span className="font-medium text-kaza-text">{email}</span>.
          <br />
          Le lien expire rapidement.
        </p>
        <p className="text-sm text-kaza-muted">
          <Link href="/login" className="font-medium text-kaza-brand hover:opacity-80">
            Retour à la connexion
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-kaza-text">
          Mot de passe oublié
        </h1>
        <p className="mt-1 text-sm text-kaza-muted">
          Saisissez votre email pour recevoir un lien de réinitialisation.
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

      <Input
        label="Email"
        type="email"
        autoComplete="email"
        required
        placeholder="vous@exemple.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      {env.hcaptchaSitekey && (
        <div className="flex justify-center">
          <div id="kaza-hcaptcha-recovery" className="min-h-[78px]" />
        </div>
      )}

      <Button type="submit" loading={loading} className="w-full btn-responsive-lg" size="lg">
        Envoyer le lien
      </Button>

      <p className="text-center text-sm text-kaza-muted">
        <Link href="/login" className="font-medium text-kaza-brand hover:opacity-80">
          Retour à la connexion
        </Link>
      </p>
    </form>
  );
}
