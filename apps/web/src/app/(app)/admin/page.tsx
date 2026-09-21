'use client';

import { useCallback, useEffect, useState } from 'react';
import { Users, Building2, Wallet, FileText, CheckCircle2, Crown, Shield, RefreshCw, Search, History } from 'lucide-react';
import {
  adminStats,
  adminListResidences,
  adminListUsers,
  adminModerateResidence,
  adminSetPremium,
  adminToggleRole,
  adminListLandlordPayouts,
  adminRetryLandlordPayout,
} from '@/lib/supabase-api';
import { listAdminAuditLogs } from '@/lib/api/admin';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useAuth } from '@/lib/auth-context';
import type { LandlordPayout, Profile, ResidenceWithRelations } from '@/lib/types';
import { formatXof } from '@/lib/format';
import { apiToast } from '@/lib/api-toast';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';

interface Stats {
  users: { total: number; by_role: Record<string, number> };
  residences: { total: number; by_status: Record<string, number> };
  leases: { total: number };
  payments: { confirmed_count: number; total_collected_xof: number };
}

export default function AdminPage() {
  const { role, user } = useAuth();
  const toast = useToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [residences, setResidences] = useState<ResidenceWithRelations[]>([]);
  const [users, setUsers] = useState<Profile[]>([]);
  const [payouts, setPayouts] = useState<LandlordPayout[]>([]);
  const [auditLogs, setAuditLogs] = useState<Array<{
    id: string;
    admin_id: string;
    action: string;
    target_type: string;
    target_id: string | null;
    old_value: unknown;
    new_value: unknown;
    metadata: unknown;
    created_at: string;
  }>>([]);
  const [residenceQuery, setResidenceQuery] = useState('');
  const [residenceStatus, setResidenceStatus] = useState('all');
  const [userQuery, setUserQuery] = useState('');
  const [userRole, setUserRole] = useState('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [statsResult, residencesResult, usersResult, payoutsResult] = await Promise.allSettled([
      adminStats(),
      adminListResidences(100),
      adminListUsers(100),
      adminListLandlordPayouts(50),
    ]);

    if (statsResult.status === 'fulfilled') setStats(statsResult.value);
    if (residencesResult.status === 'fulfilled') setResidences(residencesResult.value);
    if (usersResult.status === 'fulfilled') setUsers(usersResult.value);
    if (payoutsResult.status === 'fulfilled') setPayouts(payoutsResult.value);

    const coreError = [statsResult, residencesResult, usersResult, payoutsResult]
      .find((result) => result.status === 'rejected');
    if (coreError?.status === 'rejected') {
      apiToast(toast, coreError.reason, 'Chargement partiel de l’administration');
    }

    try {
      const audit = await listAdminAuditLogs({ limit: 50 });
      setAuditLogs(audit);
    } catch (err) {
      setAuditLogs([]);
      apiToast(toast, err, 'Journal d’administration indisponible');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (role === 'admin') void loadAll();
  }, [role, loadAll]);

  async function act(action: () => Promise<unknown>, id: string) {
    setBusy(id);
    try {
      await action();
      await loadAll();
    } catch (err) {
      apiToast(toast, err, 'Action impossible');
    } finally {
      setBusy(null);
    }
  }

  if (role !== 'admin') {
    return <p className="py-16 text-center text-sm text-kaza-faint">Accès réservé à l’administration.</p>;
  }

  const displayStats: Stats = stats ?? {
    users: { total: 0, by_role: {} },
    residences: { total: 0, by_status: {} },
    leases: { total: 0 },
    payments: { confirmed_count: 0, total_collected_xof: 0 },
  };

  const cards = [
    { icon: Users, label: 'Utilisateurs', value: loading ? '…' : String(displayStats.users.total), sub: `locataires ${displayStats.users.by_role['locataire'] ?? 0} · bailleurs ${displayStats.users.by_role['bailleur'] ?? 0}` },
    { icon: Building2, label: 'Biens', value: loading ? '…' : String(displayStats.residences.total), sub: `libres ${displayStats.residences.by_status['libre'] ?? 0} · occupés ${displayStats.residences.by_status['occupee'] ?? 0}` },
    { icon: Wallet, label: 'Collecté', value: loading ? '…' : formatXof(displayStats.payments.total_collected_xof), sub: `${displayStats.payments.confirmed_count} paiements confirmés` },
    { icon: FileText, label: 'Baux actifs', value: loading ? '…' : String(displayStats.leases.total), sub: 'en cours de gestion' },
  ];

  const pendingModeration = residences.filter((r) => r.moderation_status === 'pending');
  const normalizedResidenceQuery = residenceQuery.trim().toLocaleLowerCase();
  const filteredResidences = residences.filter((r) => {
    const haystack = [r.title, r.city, r.zone, r.owner?.full_name].filter(Boolean).join(' ').toLocaleLowerCase();
    return (residenceStatus === 'all' || r.moderation_status === residenceStatus)
      && (!normalizedResidenceQuery || haystack.includes(normalizedResidenceQuery));
  });
  const normalizedUserQuery = userQuery.trim().toLocaleLowerCase();
  const filteredUsers = users.filter((u) => {
    const haystack = [u.full_name, u.email, u.phone].filter(Boolean).join(' ').toLocaleLowerCase();
    return (userRole === 'all' || u.role === userRole)
      && (!normalizedUserQuery || haystack.includes(normalizedUserQuery));
  });

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold tracking-tight text-kaza-text">Administration</h1>
      <p className="mt-1 text-sm text-kaza-muted">Modération des annonces et pilotage de la plateforme.</p>

      {/* KPIs */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="kaza-card p-5">
            <span className="grid h-9 w-9 place-items-center rounded-kaza border border-kaza-brand/25 bg-kaza-brand/10 text-kaza-brand">
              <c.icon className="h-4.5 w-4.5" aria-hidden />
            </span>
            <p className="price mt-3 font-display text-xl font-bold text-kaza-text">{c.value}</p>
            <p className="text-xs text-kaza-faint">{c.label} · {c.sub}</p>
          </div>
        ))}
      </div>

      <section className="mt-8" aria-labelledby="moderation">
          <h2 id="moderation" className="font-display text-lg font-semibold text-kaza-text">
            Annonces en attente <span className="text-kaza-warning">({pendingModeration.length})</span>
          </h2>
          <ul className="mt-3 space-y-2">
            {pendingModeration.length === 0 ? (
              <li className="kaza-card px-4 py-5 text-sm text-kaza-faint">Aucune annonce en attente.</li>
            ) : pendingModeration.map((r) => (
              <li key={r.id} className="kaza-card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-kaza-text">{r.title}</p>
                  <p className="text-xs text-kaza-faint">
                    {r.zone ?? ''} {r.city} · {formatXof(r.price_monthly)}/mois · par {r.owner?.full_name ?? '—'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="success" className="btn-responsive-sm" loading={busy === r.id} onClick={() => act(() => adminModerateResidence(r.id, 'approve'), r.id)}>
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                    Approuver
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    className="btn-responsive-sm"
                    loading={busy === r.id}
                    onClick={() => {
                      const reason = window.prompt('Motif du refus (obligatoire) :', '');
                      if (reason?.trim()) void act(() => adminModerateResidence(r.id, 'reject', reason.trim()), r.id);
                    }}
                  >
                    Refuser
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>

      {payouts.some((p) => p.status === 'manual_review') && (
        <section className="mt-8" aria-labelledby="payouts-review">
          <h2 id="payouts-review" className="font-display text-lg font-semibold text-kaza-text">
            Reversements à traiter
          </h2>
          <ul className="mt-3 space-y-2">
            {payouts.filter((p) => p.status === 'manual_review').map((payout) => (
              <li key={payout.id} className="kaza-card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-kaza-text">
                    {formatXof(payout.amount)} · {payout.recipient_provider ?? 'opérateur inconnu'}
                  </p>
                  <p className="text-xs text-kaza-faint">
                    Propriétaire : {users.find((u) => u.id === payout.landlord_id)?.full_name ?? payout.landlord_id}
                    {payout.recipient_phone ? ` · ${payout.recipient_phone}` : ''}
                  </p>
                  {payout.last_error && (
                    <p className="mt-1 break-words text-xs text-kaza-danger">{payout.last_error}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  className="btn-responsive-sm"
                  loading={busy === payout.id}
                  onClick={() => void act(() => adminRetryLandlordPayout(payout.id), payout.id)}
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  Relancer
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        {/* Utilisateurs */}
        <section aria-labelledby="users">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="users" className="font-display text-lg font-semibold text-kaza-text">Utilisateurs</h2>
              <p className="mt-1 text-xs text-kaza-faint">{filteredUsers.length} résultat(s) sur {users.length} chargés.</p>
            </div>
            <div className="grid w-full gap-2 sm:w-auto sm:grid-cols-[minmax(220px,1fr)_150px]">
              <Input aria-label="Rechercher un utilisateur" value={userQuery} onChange={(e) => setUserQuery(e.target.value)} placeholder="Nom, email ou téléphone" />
              <Select aria-label="Filtrer par rôle" value={userRole} onChange={(e) => setUserRole(e.target.value)} options={[
                { value: 'all', label: 'Tous les rôles' },
                { value: 'locataire', label: 'Locataires' },
                { value: 'bailleur', label: 'Bailleurs' },
                { value: 'admin', label: 'Administrateurs' },
              ]} />
            </div>
          </div>
          <ul className="mt-3 space-y-2">
            {filteredUsers.map((u) => (
              <li key={u.id} className="kaza-card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-kaza-text">{u.full_name}</p>
                  <p className="text-xs text-kaza-faint">{u.email ?? u.phone ?? '—'}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <span className={cn('rounded-full border px-2.5 py-0.5 text-[11px] font-medium', u.is_premium ? 'border-kaza-brand/40 bg-kaza-brand/10 text-kaza-brand' : 'border-kaza-border text-kaza-faint')}>
                    {u.is_premium ? <Crown className="mr-1 inline h-3 w-3" aria-hidden /> : null}
                    {u.role}
                  </span>
                  <Button size="sm" variant="ghost" className="btn-responsive-sm" loading={busy === u.id} onClick={() => act(() => adminSetPremium(u.id, !u.is_premium), u.id)}>
                    {u.is_premium ? 'Retirer Premium' : 'Passer Premium'}
                  </Button>
                  {u.role !== 'admin' && u.id !== user?.id && (
                    <Button size="sm" variant="ghost" className="btn-responsive-sm" loading={busy === u.id} onClick={() => act(() => adminToggleRole(u.id, u.role === 'bailleur' ? 'locataire' : 'bailleur'), u.id)}>
                      <Shield className="h-3.5 w-3.5" aria-hidden />
                      {u.role === 'bailleur' ? '→ locataire' : '→ bailleur'}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Biens */}
        <section aria-labelledby="residences">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="residences" className="font-display text-lg font-semibold text-kaza-text">Biens récents</h2>
              <p className="mt-1 text-xs text-kaza-faint">{filteredResidences.length} résultat(s) sur {residences.length} chargés.</p>
            </div>
            <div className="grid w-full gap-2 sm:w-auto sm:grid-cols-[minmax(220px,1fr)_170px]">
              <Input aria-label="Rechercher une résidence" value={residenceQuery} onChange={(e) => setResidenceQuery(e.target.value)} placeholder="Titre, ville, zone ou bailleur" />
              <Select aria-label="Filtrer le statut de modération" value={residenceStatus} onChange={(e) => setResidenceStatus(e.target.value)} options={[
                { value: 'all', label: 'Tous les statuts' },
                { value: 'pending', label: 'En attente' },
                { value: 'approved', label: 'Approuvées' },
                { value: 'rejected', label: 'Refusées' },
                { value: 'draft', label: 'Brouillons' },
              ]} />
            </div>
          </div>
          <ul className="mt-3 space-y-2">
            {filteredResidences.slice(0, 30).map((r) => (
              <li key={r.id} className="kaza-card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-kaza-text">{r.title}</p>
                  <p className="text-xs text-kaza-faint">{r.zone ?? ''} {r.city}</p>
                </div>
                <span className={cn('rounded-full border px-2.5 py-0.5 text-[11px] font-medium', r.is_verified ? 'border-kaza-success/30 bg-kaza-success/10 text-kaza-success' : 'border-kaza-warning/30 bg-kaza-warning/10 text-kaza-warning')}>
                  {r.is_verified ? 'vérifié' : 'en attente'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="mt-10" aria-labelledby="audit">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="audit" className="font-display text-lg font-semibold text-kaza-text">Journal d’administration</h2>
            <p className="mt-1 text-xs text-kaza-faint">Les 50 dernières actions enregistrées.</p>
          </div>
          <History className="h-5 w-5 text-kaza-muted" aria-hidden />
        </div>
        <ul className="mt-3 space-y-2">
          {auditLogs.length === 0 ? (
            <li className="kaza-card px-4 py-5 text-sm text-kaza-faint">Aucune action enregistrée.</li>
          ) : (
            auditLogs.map((log) => (
              <li key={log.id} className="kaza-card flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-kaza-text">{log.action}</p>
                  <p className="text-xs text-kaza-faint">
                    {log.target_type}{log.target_id ? " · " + log.target_id : ""} · {new Date(log.created_at).toLocaleString('fr-FR')}
                  </p>
                </div>
                <Search className="mt-0.5 h-4 w-4 shrink-0 text-kaza-faint" aria-hidden />
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}