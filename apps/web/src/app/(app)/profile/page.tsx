'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Landmark, Smartphone, Trash2, UserRound } from 'lucide-react';
import { updateProfile, deleteMyAccount, listMyLandlordPayouts, ApiError, type MomoProvider } from '@/lib/supabase-api';
import { useAuth } from '@/lib/auth-context';
import type { LandlordPayout, Profile } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { supabase } from '@/lib/supabase-client';
import { useToast } from '@/components/ui/toast';

const MOMO_OPTIONS = [
  { value: 'mtn', label: 'MTN MoMo' },
  { value: 'moov', label: 'Moov Money' },
  { value: 'celtiis', label: 'Celtiis Cash' },
];

const BENIN_PHONE_RE = /^\+229\d{10}$/;

function missingLandlordFields(profile: Profile | null): string[] {
  if (!profile || profile.role !== 'bailleur') return [];

  const missing: string[] = [];
  if (profile.full_name.trim().length < 2) missing.push('Nom complet');
  if (!profile.phone || !BENIN_PHONE_RE.test(profile.phone.replace(/\s+/g, ''))) missing.push('Téléphone');
  if (!profile.email?.trim()) missing.push('Email');
  if (!profile.business_name?.trim()) missing.push('Nom ou raison sociale');
  if (!profile.momo_provider) missing.push('Opérateur Mobile Money');
  if (!profile.momo_number || !BENIN_PHONE_RE.test(profile.momo_number.replace(/\s+/g, ''))) {
    missing.push('Numéro Mobile Money');
  }
  return missing;
}

export default function ProfilePage() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const router = useRouter();

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [momoProvider, setMomoProvider] = useState<MomoProvider | ''>('');
  const [momoNumber, setMomoNumber] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankIban, setBankIban] = useState('');
  const [payouts, setPayouts] = useState<LandlordPayout[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!user) return;
    setFullName(user.full_name ?? '');
    setPhone(user.phone ?? '');
    setBusinessName(user.business_name ?? '');
    setTaxId(user.tax_id ?? '');
    setMomoProvider((user.momo_provider as MomoProvider | null) ?? '');
    setMomoNumber(user.momo_number ?? '');
    setBankName(user.bank_name ?? '');
    setBankIban(user.bank_iban ?? '');
  }, [user]);

  const missing = useMemo(() => missingLandlordFields(user), [user]);
  const formComplete =
    user?.role === 'bailleur'
    && fullName.trim().length >= 2
    && /^\+229\d{10}$/.test(phone.replace(/\s+/g, ''))
    && Boolean(user.email?.trim())
    && businessName.trim().length > 0
    && Boolean(momoProvider)
    && /^\+229\d{10}$/.test(momoNumber.replace(/\s+/g, ''));
  const landlordComplete = user?.role === 'bailleur'
    && (user.onboarding_completed === true || formComplete);

  useEffect(() => {
    if (user?.role !== 'bailleur') return;
    void listMyLandlordPayouts(5).then(setPayouts).catch(() => setPayouts([]));
  }, [user]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await updateProfile({
        full_name: fullName,
        phone,
        ...(user?.role === 'bailleur'
          ? {
              business_name: businessName,
              tax_id: taxId,
              momo_provider: momoProvider || null,
              momo_number: momoNumber,
              bank_name: bankName,
              bank_iban: bankIban,
            }
          : {}),
      });
      await refresh();
      window.dispatchEvent(new Event('kaza:notifications-refresh'));
      toast.success(
        user?.role === 'bailleur' ? 'Profil enregistré' : 'Profil mis à jour',
        user?.role === 'bailleur'
          ? 'Le statut de complétude a été recalculé.'
          : undefined,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Mise à jour impossible');
    } finally {
      setSaving(false);
    }
  }

  async function deleteAccount() {
    setDeleting(true);
    try {
      await deleteMyAccount();
      await supabase.auth.signOut();
      toast.info('Compte supprimé', 'Vos données ont été effacées (RGPD).');
      router.push('/');
    } catch {
      toast.error('Suppression impossible');
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-tight text-kaza-text">
        <UserRound className="h-6 w-6 text-kaza-brand" aria-hidden />
        Mon profil
      </h1>
      <p className="mt-1 text-sm text-kaza-muted">
        Gardez vos informations à jour pour que KAZA puisse vous identifier et vous permettre de recevoir vos loyers.
      </p>

      {user?.role === 'bailleur' && (
        <section
          aria-live="polite"
          className={`mt-6 rounded-kaza-lg border p-4 ${landlordComplete
            ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
            : 'border-amber-500/30 bg-amber-500/[0.07]'}`}
        >
          <div className="flex items-start gap-3">
            {landlordComplete ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
            ) : (
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-kaza-text">
                {landlordComplete ? 'Profil propriétaire complet' : 'Profil propriétaire incomplet'}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-kaza-muted">
                {landlordComplete
                  ? 'Toutes les informations essentielles sont renseignées.'
                  : 'Renseignez les informations manquantes pour finaliser votre profil et configurer la réception de vos loyers.'}
              </p>
              {!landlordComplete && (
                <p className="mt-2 text-xs font-medium text-amber-700">
                  Manquant : {missing.join(' · ')}
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      <form onSubmit={(e) => void save(e)} className="mt-6 space-y-6">
        <section className="rounded-kaza-lg border border-kaza-border bg-kaza-surface p-5">
          <h2 className="text-sm font-semibold text-kaza-text">Informations personnelles</h2>
          <div className="mt-4 space-y-4">
            <Input
              label="Nom complet"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              autoComplete="name"
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Téléphone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                hint="Format : +229 01 00 00 00 00"
                autoComplete="tel"
              />
              <Input
                label="Email"
                value={user?.email ?? ''}
                disabled
                hint="Immutable — contactez le support en cas de changement."
              />
            </div>
          </div>
        </section>

        {user?.role === 'bailleur' && (
          <>
            <section className="rounded-kaza-lg border border-kaza-border bg-kaza-surface p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-kaza-text">
                <UserRound className="h-4 w-4 text-kaza-brand" aria-hidden />
                Identité du propriétaire
              </h2>
              <div className="mt-4 space-y-4">
                <Input
                  label="Nom ou raison sociale"
                  required
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  placeholder="Ex. Kossou Bertin ou SARL Immo Bénin"
                  autoComplete="organization"
                />
                <Input
                  label="IFU"
                  value={taxId}
                  onChange={(e) => setTaxId(e.target.value)}
                  placeholder="Facultatif"
                  hint="Identifiant Fiscal Unique, notamment pour les personnes morales."
                />
              </div>
            </section>

            <section className="rounded-kaza-lg border border-kaza-border bg-kaza-surface p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-kaza-text">
                <Smartphone className="h-4 w-4 text-kaza-brand" aria-hidden />
                Réception des loyers
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-kaza-muted">
                Ces coordonnées servent à configurer le compte de réception des loyers. Le paiement FedaPay actuellement intégré à KAZA encaisse le locataire ; le versement au propriétaire reste une étape distincte.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Select
                  label="Opérateur Mobile Money"
                  value={momoProvider}
                  onChange={(e) => setMomoProvider(e.target.value as MomoProvider | '')}
                  options={[{ value: '', label: 'Sélectionner' }, ...MOMO_OPTIONS]}
                />
                <Input
                  label="Numéro Mobile Money"
                  type="tel"
                  value={momoNumber}
                  onChange={(e) => setMomoNumber(e.target.value)}
                  placeholder="+229 01 00 00 00 00"
                  hint="MTN, Moov ou Celtiis — format béninois."
                  inputMode="tel"
                />
              </div>
            </section>

            <section className="rounded-kaza-lg border border-kaza-border bg-kaza-surface p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-kaza-text">
                <Landmark className="h-4 w-4 text-kaza-brand" aria-hidden />
                Coordonnées bancaires
                <span className="rounded-full bg-kaza-border/60 px-2 py-0.5 text-[10px] font-medium text-kaza-muted">facultatif</span>
              </h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Input
                  label="Banque"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  placeholder="Ex. Ecobank Bénin"
                />
                <Input
                  label="IBAN"
                  value={bankIban}
                  onChange={(e) => setBankIban(e.target.value)}
                  placeholder="BJ66 …"
                  hint="Optionnel."
                />
              </div>
            </section>
          </>
        )}

        {user?.role === 'bailleur' && (
          <section className="rounded-kaza-lg border border-kaza-border bg-kaza-surface p-5">
            <h2 className="text-sm font-semibold text-kaza-text">Derniers reversements</h2>
            <p className="mt-1 text-xs leading-relaxed text-kaza-muted">
              Suivez l&apos;acheminement des loyers vers votre Mobile Money.
            </p>
            <div className="mt-4 divide-y divide-kaza-border">
              {payouts.length === 0 ? (
                <p className="py-3 text-sm text-kaza-muted">Aucun reversement pour le moment.</p>
              ) : (
                payouts.map((payout) => {
                  const statusMap: Record<string, readonly [string, string]> = {
                    queued: ['En attente', 'bg-slate-100 text-slate-700'],
                    waiting_configuration: ['Configuration requise', 'bg-amber-100 text-amber-800'],
                    processing: ['En cours', 'bg-blue-100 text-blue-800'],
                    sent: ['Envoyé', 'bg-emerald-100 text-emerald-800'],
                    failed: ['Échoué', 'bg-red-100 text-red-800'],
                    manual_review: ['À traiter', 'bg-amber-100 text-amber-800'],
                  };
                  const status = statusMap[payout.status] ?? ['Statut inconnu', 'bg-slate-100 text-slate-700'];
                  return (
                    <div key={payout.id} className="flex items-center justify-between gap-4 py-3">
                      <div>
                        <p className="text-sm font-semibold text-kaza-text">
                          {new Intl.NumberFormat('fr-FR').format(payout.amount)} FCFA
                        </p>
                        <p className="text-xs text-kaza-muted">
                          {new Date(payout.created_at).toLocaleDateString('fr-FR')}
                          {payout.recipient_phone ? ` · ${payout.recipient_phone}` : ''}
                        </p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold ${status[1]}`}>
                        {status[0]}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        )}

        <Button type="submit" loading={saving}>
          Enregistrer les modifications
        </Button>
      </form>

      <section className="mt-12 rounded-kaza border border-kaza-danger/25 bg-kaza-danger/[0.06] p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-kaza-danger">
          <Trash2 className="h-4 w-4" aria-hidden />
          Supprimer mon compte
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-kaza-muted">
          Suppression définitive : profils, baux, messages et photos seront effacés (droit à
          l’effacement — Loi 2017-20 & règlement APDP). Cette action est irréversible.
        </p>
        <Button variant="danger" size="sm" className="mt-3" onClick={() => setConfirmDelete(true)}>
          Supprimer définitivement
        </Button>
      </section>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Confirmer la suppression">
        <p className="text-sm text-kaza-muted">
          Toutes vos données seront définitivement effacées. Confirmez-vous la suppression de votre compte ?
        </p>
        <div className="mt-5 flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={() => setConfirmDelete(false)}>
            Annuler
          </Button>
          <Button variant="danger" className="flex-1" loading={deleting} onClick={() => void deleteAccount()}>
            Oui, supprimer
          </Button>
        </div>
      </Modal>
    </div>
  );
}
