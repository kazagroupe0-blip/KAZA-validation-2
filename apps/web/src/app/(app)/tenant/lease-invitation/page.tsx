'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, CheckCircle2, Clock, Home, ShieldCheck } from 'lucide-react';
import { acceptLeaseInvitation, getLeaseInvitation, ApiError } from '@/lib/supabase-api';
import { useAuth } from '@/lib/auth-context';
import { formatXof } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

function formatExpiry(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export default function TenantLeaseInvitationPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, role } = useAuth();
  const token = useMemo(() => searchParams.get('token')?.trim() ?? '', [searchParams]);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [details, setDetails] = useState<Awaited<ReturnType<typeof getLeaseInvitation>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError('Lien d’invitation incomplet.');
      setLoading(false);
      return;
    }
    if (!user || !role) return;
    if (role !== 'locataire') {
      setError('Ce lien est réservé à un compte locataire.');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void getLeaseInvitation(token)
      .then((data) => {
        if (!cancelled) setDetails(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setDetails(null);
          setError(err instanceof ApiError ? err.message : 'Invitation invalide ou expirée.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, user, role]);

  async function handleAccept() {
    if (!token) return;
    setAccepting(true);
    setError(null);

    try {
      await acceptLeaseInvitation(token);
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Acceptation impossible.');
    } finally {
      setAccepting(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 px-4 py-10">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <div className="rounded-kaza border border-kaza-danger/30 bg-kaza-danger/5 p-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-kaza-danger" aria-hidden />
            <div>
              <h1 className="font-display text-xl font-semibold text-kaza-text">Invitation indisponible</h1>
              <p className="mt-2 text-sm leading-relaxed text-kaza-muted">{error}</p>
              {role && role !== 'locataire' ? (
                <p className="mt-2 text-xs text-kaza-faint">
                  Connectez-vous avec un compte ayant le rôle locataire pour utiliser ce lien.
                </p>
              ) : null}
            </div>
          </div>
          <Button type="button" variant="secondary" onClick={() => router.push('/dashboard')} className="mt-5">
            Retour au tableau de bord
          </Button>
        </div>
      </div>
    );
  }

  if (!details) return null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="overflow-hidden rounded-kaza border border-kaza-border bg-kaza-bg">
        <div className="border-b border-kaza-border p-6 sm:p-8">
          <div className="flex items-start gap-3">
            <span className="rounded-xl bg-kaza-brand/10 p-2.5 text-kaza-brand">
              <ShieldCheck className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-kaza-faint">Invitation privée KAZA</p>
              <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-kaza-text">
                Rejoindre ce logement
              </h1>
              <p className="mt-2 text-sm text-kaza-muted">
                Cette invitation rattache votre compte à ce bien pour permettre au bailleur de créer votre bail.
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-6 p-6 sm:p-8">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-kaza-text">
              <Home className="h-4 w-4 text-kaza-brand" aria-hidden />
              {details.residence.title}
            </div>
            <p className="mt-1 text-sm text-kaza-muted">
              {details.residence.zone ? `${details.residence.zone} · ` : ''}{details.residence.city}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-kaza border border-kaza-border p-4">
              <p className="text-xs text-kaza-faint">Loyer mensuel</p>
              <p className="mt-1 text-lg font-semibold text-kaza-text">{formatXof(details.residence.price_monthly)}</p>
            </div>
            <div className="rounded-kaza border border-kaza-border p-4">
              <p className="text-xs text-kaza-faint">Caution</p>
              <p className="mt-1 text-lg font-semibold text-kaza-text">{formatXof(details.residence.deposit)}</p>
            </div>
          </div>

          <div className="rounded-kaza border border-kaza-border bg-kaza-bg p-4">
            <p className="text-xs text-kaza-faint">Bailleur</p>
            <p className="mt-1 text-sm font-medium text-kaza-text">{details.landlord.full_name ?? 'Bailleur KAZA'}</p>
            <p className="mt-3 flex items-center gap-2 text-xs text-kaza-muted">
              <Clock className="h-3.5 w-3.5" aria-hidden />
              Lien valable jusqu’au {formatExpiry(details.expires_at)}
            </p>
          </div>

          <div className="rounded-kaza border border-kaza-brand/30 bg-kaza-brand/5 p-4 text-sm leading-relaxed text-kaza-muted">
            En acceptant, votre compte devient lié à ce bien. Le bailleur pourra ensuite sélectionner votre profil
            pour créer le bail. L’acceptation ne crée pas encore le bail et n’effectue aucun paiement.
          </div>

          <Button type="button" size="lg" loading={accepting} onClick={() => void handleAccept()} className="w-full">
            <CheckCircle2 className="h-5 w-5" aria-hidden />
            Accepter l’invitation
          </Button>
        </div>
      </div>
    </div>
  );
}
