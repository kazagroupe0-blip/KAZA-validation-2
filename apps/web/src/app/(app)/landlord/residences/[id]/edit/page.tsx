'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Rocket, KeyRound, Link2, Clock, Copy, ShieldCheck, Ban } from 'lucide-react';
import {
  getResidence,
  updateResidence,
  submitResidenceForReview,
  withdrawResidencePublication,
  createLease,
  listTenants,
  createLeaseInvitation,
  listLeaseInvitations,
  revokeLeaseInvitation,
  ApiError,
} from '@/lib/supabase-api';
import type { Profile, Residence } from '@/lib/types';
import { formatXof } from '@/lib/format';
import { formatLocalDateInput } from '@/lib/date-input';
import { ResidenceForm } from '@/components/property/residence-form';
import { residenceCompleteness, CompletenessChecklist } from '@/components/property/residence-completeness';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';

const STATUS_OPTIONS = [
  { value: 'libre', label: 'Libre' },
  { value: 'occupee', label: 'Occupée' },
  { value: 'en_visite', label: 'En visite' },
  { value: 'maintenance', label: 'En maintenance' },
];

export default function EditResidencePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [residence, setResidence] = useState<Residence | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string>('libre');
  const [published, setPublished] = useState(false);
  const [moderationStatus, setModerationStatus] = useState<string>('draft');
  const [publishError, setPublishError] = useState<string | null>(null);
  const [leaseModal, setLeaseModal] = useState(false);
  const [inviteModal, setInviteModal] = useState(false);
  const [tenants, setTenants] = useState<Profile[]>([]);
  const [tenantLoadError, setTenantLoadError] = useState<string | null>(null);

  useEffect(() => {
    getResidence(id)
      .then((r) => {
        setResidence(r);
        setStatus(r.status);
        setPublished(r.is_published);
        setModerationStatus(r.moderation_status ?? (r.is_verified ? 'approved' : r.is_published ? 'pending' : 'draft'));
      })
      .catch(() => toast.error('Bien introuvable'))
      .finally(() => setLoading(false));
  }, [id, toast]);

  const loadTenants = useCallback(async () => {
    setTenantLoadError(null);
    try {
      const all = await listTenants();
      setTenants(all);
    } catch (err) {
      setTenants([]);
      setTenantLoadError(
        err instanceof ApiError
          ? err.message
          : 'Impossible de charger les locataires liés à ce bailleur.',
      );
    }
  }, []);

  async function updateStatus(next: string) {
    setStatus(next);
    try {
      await updateResidence(id, { status: next as Residence['status'] });
      toast.success('Statut mis à jour');
    } catch {
      toast.error('Mise à jour impossible');
      setStatus(residence?.status ?? 'libre');
    }
  }

  async function togglePublish() {
    setPublishError(null);
    try {
      if (moderationStatus === 'pending' || moderationStatus === 'approved') {
        await withdrawResidencePublication(id);
        setPublished(false);
        setModerationStatus(moderationStatus === 'approved' ? 'draft' : moderationStatus);
        toast.success('Annonce retirée', 'Elle n’est plus visible dans la recherche.');
      } else {
        const refreshed = await submitResidenceForReview(id);
        setResidence(refreshed);
        setStatus(refreshed.status);
        setPublished(refreshed.is_published);
        setModerationStatus(
          refreshed.moderation_status ??
          (refreshed.is_verified ? 'approved' : refreshed.is_published ? 'pending' : 'draft'),
        );
        toast.success('Annonce envoyée en modération', 'Elle sera visible publiquement uniquement après validation.');
      }
    } catch (err) {
      setPublishError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Action impossible');
      if (err instanceof ApiError && err.status === 409) {
        toast.error('Limite du plan gratuit', '1 bien en ligne — passez au Premium pour en publier plus.');
      } else {
        toast.error(err instanceof ApiError ? err.message : 'Action impossible');
      }
    }
  }

  const moderationLabel =
    moderationStatus === 'approved' ? 'Approuvée et visible' :
    moderationStatus === 'pending' ? 'En attente de modération' :
    moderationStatus === 'rejected' ? 'Refusée — correction requise' :
    'Brouillon';


  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (!residence) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4 text-center">
        <div>
          <p className="text-5xl font-bold text-kaza-brand">404</p>
          <h1 className="mt-4 font-display text-xl font-semibold text-kaza-text">Bien introuvable</h1>
          <p className="mt-2 text-sm text-kaza-muted">Ce bien a été supprimé ou n&apos;existe pas.</p>
        </div>
      </div>
    );
  }

  const completeness = residenceCompleteness(residence);

  return (
    <div>
      <button onClick={() => router.push('/landlord')} className="mb-5 flex items-center gap-2 text-sm text-kaza-muted hover:text-kaza-text">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Retour à mes biens
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-kaza-text">{residence.title}</h1>
          <p className="mt-1 text-sm text-kaza-muted">
            {residence.zone ?? ''} {residence.city} · {formatXof(residence.price_monthly)}/mois
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setInviteModal(true)} data-testid="invite-tenant">
            <Link2 className="h-4 w-4" aria-hidden />
            Inviter un locataire
          </Button>
          <Button variant="secondary" onClick={() => setLeaseModal(true)} data-testid="create-lease">
            <KeyRound className="h-4 w-4" aria-hidden />
            Créer un bail
          </Button>
          <Button variant={published ? 'secondary' : 'primary'} onClick={() => void togglePublish()} data-testid="publish-toggle">
            <Rocket className="h-4 w-4" aria-hidden />
            {moderationStatus === 'pending' || moderationStatus === 'approved' ? 'Retirer de la recherche' : moderationStatus === 'rejected' ? 'Resoumettre à la modération' : 'Soumettre à la modération'}
          </Button>
        </div>
      </div>

      {publishError ? (
        <p data-testid="publish-error" className="mt-3 rounded-kaza border border-kaza-danger/30 bg-kaza-danger/5 p-3 text-sm text-kaza-danger">
          {publishError}
        </p>
      ) : null}

      <div className="mt-5 rounded-kaza border border-kaza-border bg-kaza-bg p-4" data-testid="moderation-status">
        <p className="text-xs font-semibold uppercase tracking-wide text-kaza-faint">Modération</p>
        <p className="mt-1 text-sm font-medium text-kaza-text">{moderationLabel}</p>
        {moderationStatus === 'rejected' && residence.moderation_reason ? (
          <p className="mt-2 text-sm text-kaza-danger"><strong>Motif :</strong> {residence.moderation_reason}</p>
        ) : null}
        {moderationStatus === 'pending' ? (
          <p className="mt-2 text-xs text-kaza-muted">Votre annonce n’est pas encore visible dans la recherche. Elle le deviendra après approbation.</p>
        ) : null}
      </div>

      {/* Statut */}
      <div className="mt-5 max-w-xs">
        <Select
          label="Statut du bien"
          value={status}
          onChange={(e) => void updateStatus(e.target.value)}
          options={STATUS_OPTIONS}
        />
        <p className="mt-1.5 text-xs text-kaza-faint">
          Seuls les biens « Libre » apparaissent dans la recherche des locataires.
        </p>
      </div>

      {/* Checklist de publication */}
      <div className="mt-6 flex max-w-md flex-col gap-4 rounded-kaza border border-kaza-border bg-kaza-bg p-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 font-display text-sm font-semibold text-kaza-text">
            <Rocket className="h-4 w-4 text-kaza-brand" aria-hidden />
            Prêt à publier&nbsp;?
          </h2>
          <div className="mt-2.5">
            <CompletenessChecklist c={completeness} />
          </div>
        </div>
        <p className="max-w-[11rem] text-xs leading-relaxed text-kaza-faint">
          Les annonces complètes sont approuvées plus vite par notre équipe de modération.
        </p>
      </div>

      <div className="mt-8">
        <ResidenceForm existing={residence} />
      </div>

      <InviteTenantModal
        open={inviteModal}
        onClose={() => setInviteModal(false)}
        residenceId={residence.id}
      />

      <CreateLeaseModal
        open={leaseModal}
        onClose={() => setLeaseModal(false)}
        residence={residence}
        onLoadTenants={loadTenants}
        tenants={tenants}
        tenantLoadError={tenantLoadError}
        onCreated={() => {
          setLeaseModal(false);
          setStatus('occupee');
          toast.success('Bail créé', 'Le bien est maintenant « Occupée ».');
        }}
      />
    </div>
  );
}


function formatInvitationExpiry(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function InviteTenantModal({
  open,
  onClose,
  residenceId,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  residenceId: string;
}>) {
  const toast = useToast();
  const [active, setActive] = useState<{
    invitation_id: string;
    expires_at: string;
    status: 'pending' | 'accepted' | 'consumed' | 'revoked' | 'expired';
  } | null>(null);
  const [created, setCreated] = useState<{
    invitation_id: string;
    token: string;
    expires_at: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingActive, setLoadingActive] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCreated(null);
    setError(null);
    setLoadingActive(true);
    void listLeaseInvitations(residenceId)
      .then((items) => {
        const activeInvitation =
          items.find(
            (item) => item.status === 'pending' && new Date(item.expires_at).getTime() > Date.now(),
          ) ?? items.find((item) => item.status === 'accepted');

        setActive(
          activeInvitation
            ? {
                invitation_id: activeInvitation.invitation_id,
                expires_at: activeInvitation.expires_at,
                status: activeInvitation.status,
              }
            : null,
        );
      })
      .catch((err) => {
        setActive(null);
        setError(err instanceof ApiError ? err.message : 'Impossible de charger le lien actif.');
      })
      .finally(() => setLoadingActive(false));
  }, [open, residenceId]);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const invitationLink = created
    ? `${origin}/tenant/lease-invitation?token=${encodeURIComponent(created.token)}`
    : null;

  async function handleCreate() {
    setLoading(true);
    setError(null);
    try {
      const next = await createLeaseInvitation(residenceId);
      setCreated(next);
      setActive({
        invitation_id: next.invitation_id,
        expires_at: next.expires_at,
        status: 'pending',
      });
      toast.success('Lien privé créé', 'Transmettez-le directement au locataire concerné.');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Création du lien impossible';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRevoke() {
    if (!active) return;
    setRevoking(true);
    setError(null);
    try {
      await revokeLeaseInvitation(active.invitation_id);
      setActive(null);
      setCreated(null);
      toast.success('Invitation révoquée');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Révocation impossible';
      setError(message);
      toast.error(message);
    } finally {
      setRevoking(false);
    }
  }

  async function copyLink() {
    if (!invitationLink) return;
    try {
      await navigator.clipboard.writeText(invitationLink);
      toast.success('Lien copié');
    } catch {
      setError('Copie automatique indisponible. Sélectionnez le lien et copiez-le manuellement.');
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Inviter un locataire" wide>
      <div className="space-y-5">
        <div className="rounded-kaza border border-kaza-border bg-kaza-bg p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-kaza-brand" aria-hidden />
            <div>
              <p className="text-sm font-medium text-kaza-text">Un lien privé, sans annuaire</p>
              <p className="mt-1 text-xs leading-relaxed text-kaza-muted">
                KAZA ne vous ouvre pas une liste globale de locataires. Le lien cible ce bien précis,
                expire sous 48 heures et devient inutilisable dès qu’il est révoqué ou remplacé.
              </p>
            </div>
          </div>
        </div>

        {error ? (
          <p className="rounded-kaza border border-kaza-danger/30 bg-kaza-danger/5 p-3 text-sm text-kaza-danger">
            {error}
          </p>
        ) : null}

        {loadingActive ? (
          <p className="text-sm text-kaza-muted">Vérification du lien actif…</p>
        ) : active ? (
          <div className="rounded-kaza border border-kaza-border p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-kaza-text">
                  {active.status === 'accepted' ? 'Invitation acceptée' : 'Un lien est déjà actif'}
                </p>
                <p className="mt-1 flex items-center gap-2 text-xs text-kaza-muted">
                  <Clock className="h-3.5 w-3.5" aria-hidden />
                  Expire le {formatInvitationExpiry(active.expires_at)}
                </p>
              </div>
              <Ban className="h-5 w-5 text-kaza-faint" aria-hidden />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-kaza-faint">
              {active.status === 'accepted'
                ? 'Le locataire a accepté ce lien et son compte est maintenant rattaché à ce bien. Vous pouvez le sélectionner dans « Créer un bail ».'
                : 'KAZA ne peut pas récupérer le jeton secret après sa création. Révoquez ce lien si nécessaire avant d’en créer un autre.'}
            </p>
            {active.status === 'pending' ? (
              <Button type="button" variant="secondary" loading={revoking} onClick={() => void handleRevoke()} className="mt-4">
                Révoquer ce lien
              </Button>
            ) : null}
          </div>
        ) : null}

        {created && invitationLink ? (
          <div className="rounded-kaza border border-kaza-brand/30 bg-kaza-brand/5 p-4">
            <p className="text-sm font-medium text-kaza-text">Lien prêt à transmettre</p>
            <p className="mt-1 text-xs text-kaza-muted">
              Expire le {formatInvitationExpiry(created.expires_at)}. Une nouvelle génération invalidera ce lien.
            </p>
            <div className="mt-3 break-all rounded-kaza border border-kaza-border bg-kaza-bg p-3 text-xs text-kaza-text">
              {invitationLink}
            </div>
            <Button type="button" variant="primary" onClick={() => void copyLink()} className="mt-3">
              <Copy className="h-4 w-4" aria-hidden />
              Copier le lien
            </Button>
          </div>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            Fermer
          </Button>
          <Button type="button" loading={loading} disabled={Boolean(active)} onClick={() => void handleCreate()}>
            <Link2 className="h-4 w-4" aria-hidden />
            {active ? (active.status === 'accepted' ? 'Invitation déjà acceptée' : 'Un lien est déjà actif') : 'Générer le lien privé'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CreateLeaseModal({
  open,
  onClose,
  residence,
  tenants,
  onLoadTenants,
  tenantLoadError,
  onCreated,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  residence: Residence;
  tenants: Profile[];
  onLoadTenants: () => Promise<void>;
  tenantLoadError: string | null;
  onCreated: () => void;
}>) {
  const toast = useToast();
  const [form, setForm] = useState({ tenant_id: '', start_date: '', end_date: '', monthly_rent: '', deposit: '' });
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (open) void onLoadTenants();
    if (open) {
      setForm((f) => ({
        ...f,
        monthly_rent: String(residence.price_monthly),
        deposit: String(residence.deposit),
        start_date: formatLocalDateInput(),
      }));
    }
  }, [open, tenants.length, onLoadTenants, residence]);

  async function handleCreateLease(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErrors({});
    try {
      await createLease({
        residence_id: residence.id,
        tenant_id: form.tenant_id,
        start_date: form.start_date,
        end_date: form.end_date || undefined,
        monthly_rent: Number(form.monthly_rent),
        deposit: Number(form.deposit || 0),
      });
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields);
      else toast.error(err instanceof ApiError ? err.message : 'Bail impossible');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Créer un bail" wide>
      <form onSubmit={(e) => void handleCreateLease(e)} className="space-y-4">
        <Select
          label="Locataire"
          required
          value={form.tenant_id}
          onChange={(e) => setForm((f) => ({ ...f, tenant_id: e.target.value }))}
          options={[
            { value: '', label: 'Choisir un locataire…' },
            ...tenants.map((t) => ({ value: t.id, label: `${t.full_name} — ${t.email ?? t.phone ?? ''}` })),
          ]}
          error={errors.tenant_id?.[0]}
        />
        {tenantLoadError ? (
          <p data-testid="tenant-load-error" className="rounded-kaza border border-kaza-danger/30 bg-kaza-danger/5 p-3 text-sm text-kaza-danger">
            {tenantLoadError} Vous pouvez fermer puis rouvrir cette fenêtre pour réessayer.
          </p>
        ) : tenants.length === 0 ? (
          <p data-testid="no-linked-tenants" className="rounded-kaza border border-kaza-border bg-kaza-bg p-3 text-sm leading-relaxed text-kaza-muted">
            Aucun locataire lié à votre compte pour le moment. Pour protéger les coordonnées personnelles,
            KAZA affiche ici uniquement les locataires avec lesquels vous avez déjà un bail, une conversation
            ou une invitation privée acceptée. Utilisez « Inviter un locataire » pour créer un lien ciblé,
            puis revenez ici après son acceptation pour créer le bail.
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-3">
          <Input label="Début" type="date" required value={form.start_date} onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value }))} />
          <Input label="Fin (facultatif)" type="date" value={form.end_date} onChange={(e) => setForm((f) => ({ ...f, end_date: e.target.value }))} />
          <Input
            label="Loyer mensuel (FCFA)"
            type="number"
            required
            value={form.monthly_rent}
            onChange={(e) => setForm((f) => ({ ...f, monthly_rent: e.target.value }))}
            error={errors.monthly_rent?.[0]}
          />
        </div>
        <Input
          label="Caution (FCFA)"
          type="number"
          min={0}
          value={form.deposit}
          onChange={(e) => setForm((f) => ({ ...f, deposit: e.target.value }))}
          hint="Maximum 3 mois de loyer (Loi 2022-30 du Bénin)"
          error={errors.deposit?.[0]}
        />
        <p className="text-xs leading-relaxed text-kaza-faint">
          Le bien passera automatiquement en statut « Occupée ». Le locataire pourra payer son loyer et
          recevoir ses quittances signées depuis son espace.
        </p>
        <Button type="submit" loading={loading} className="w-full" size="lg">
          Créer le bail et mettre le bien en location
        </Button>
      </form>
    </Modal>
  );
}