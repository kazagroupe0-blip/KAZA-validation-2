'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Check, CheckCheck, Calendar, Paperclip, Send, X } from 'lucide-react';
import {
  listMessages,
  sendMessage,
  markConversationRead,
  confirmVisit,
  declineVisit,
  listVisits,
  getConversation,
  getSignedStorageUrl,
  proposeVisit,
} from '@/lib/supabase-api';
import { VisitProposalModal } from './VisitProposalModal';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase-client';
import type { RealtimePostgresInsertPayload, REALTIME_SUBSCRIBE_STATES } from '@supabase/supabase-js';
import type { ConversationWithRelations, Message, Visit } from '@/lib/types';
import { timeAgo, formatXof } from '@/lib/format';
import { apiToast } from '@/lib/api-toast';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import {
  INITIAL_REALTIME_HEALTH,
  applySubscribeStatus,
  applySystemEvent,
  isRealtimeLive,
  realtimeHealthError,
  type RealtimeHealth,
} from '@/lib/realtime-health';

const STORAGE_MAX = 8 * 1024 * 1024;

export function ChatWindow() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversation, setConversation] = useState<ConversationWithRelations | null>(null);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [proposeModal, setProposeModal] = useState(false);
  const [isLandlord, setIsLandlord] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [list, conv, visitList] = await Promise.all([
        listMessages(id),
        getConversation(id),
        listVisits(id),
      ]);
      setMessages(list);
      setConversation(conv);
      setVisits(visitList);
    } catch {
      toast.error('Chargement de la conversation impossible');
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Temps réel Supabase — le client dédié doit terminer setAuth() avant le join.
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let authSubscription: { unsubscribe: () => void } | null = null;
    let cancelled = false;
    let connecting = false;
    let health: RealtimeHealth = INITIAL_REALTIME_HEALTH;

    const publish = (next: RealtimeHealth) => {
      health = next;
      if (cancelled) return;
      setIsConnected(isRealtimeLive(next));
      setRealtimeError(realtimeHealthError(next));
    };

    const connect = async (accessToken: string | null) => {
      if (!accessToken || cancelled || channel || connecting) return;
      connecting = true;

      try {
        await supabaseRealtime.realtime.setAuth(accessToken);
        if (cancelled) return;

        channel = supabaseRealtime
          .channel(`messages:${id}`)
          .on(
            'postgres_changes',
            {
              event: 'UPDATE',
              schema: 'public',
              table: 'visits',
              filter: `conversation_id=eq.${id}`,
            },
            (payload) => {
              const visit = payload.new as { status?: string };
              if (visit.status === 'confirmed' || visit.status === 'cancelled') {
                void load();
              }
            },
          )
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'messages',
              filter: `conversation_id=eq.${id}`,
            },
            (payload: RealtimePostgresInsertPayload<Message>) => {
              const m = payload.new as Message;
              setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
              if (m.sender_id !== user?.id) {
                void markConversationRead(id).catch(() => undefined);
              }
            },
          )
          .on('system', {}, (payload: unknown) => {
            const next = applySystemEvent(health, payload);
            if (next.bindingError !== null && next.bindingError !== health.bindingError) {
              console.error('[kaza:realtime] postgres_changes binding failed', next.bindingError);
            }
            publish(next);
          })
          .subscribe((status: REALTIME_SUBSCRIBE_STATES, err) => {
            const detail = err instanceof Error ? err.message : String(err ?? status);
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              console.error('[kaza:realtime] subscription failed', status, detail);
            }
            publish(applySubscribeStatus(health, status, detail));
          });
      } finally {
        connecting = false;
      }
    };

    setIsConnected(false);
    setRealtimeError(null);

    void supabase.auth.getSession().then(({ data: { session } }) => {
      if (!cancelled) void connect(session?.access_token ?? null);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelled && session) void connect(session.access_token);
    });
    authSubscription = data.subscription;

    return () => {
      cancelled = true;
      authSubscription?.unsubscribe();
      if (channel) void supabaseRealtime.removeChannel(channel);
    };
  }, [id, user?.id]);

  // marquer lu + défilement en bas
  useEffect(() => {
    if (user && messages.length > 0) {
      void markConversationRead(id).catch(() => undefined);
    }
  }, [id, user, messages.length]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // URLs signées pour les pièces jointes (bucket privé) — mises en cache
  // Résolues en parallèle par lots de 6 (pas de round-trip séquentiel).
  const [signedAttachments, setSignedAttachments] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const todo: string[] = [];
      for (const m of messages) {
        for (const a of m.attachments ?? []) {
          if (a in signedAttachments) continue;
          todo.push(a);
        }
      }
      if (todo.length === 0) return;
      const pending: Record<string, string> = {};
      for (let i = 0; i < todo.length; i += 6) {
        const batch = todo.slice(i, i + 6);
        const settled = await Promise.all(
          batch.map((a) => getSignedStorageUrl('chat-files', a).catch(() => null)),
        );
        if (cancelled) return;
        settled.forEach((signed, j) => {
          if (signed) pending[batch[j]] = signed;
        });
      }
      setSignedAttachments((prev) => ({ ...prev, ...pending }));
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, signedAttachments]);

  useEffect(() => {
    void getConversation(id)
      .then((c) => setIsLandlord(c?.landlord_id === user?.id))
      .catch(() => undefined);
  }, [id, user?.id]);

  async function handleSend(e: React.FormEvent, files: File[] = []) {
    e.preventDefault();
    const text = body.trim();
    if (!text && files.length === 0) return;
    setSending(true);
    try {
      const attachments = await uploadFiles(files);
      await sendMessage(id, {
        body: text || null,
        kind: attachments.length > 0 && !text ? (attachments[0].includes('.pdf') ? 'document' : 'image') : 'text',
        attachments,
      });
      setBody('');
      setPendingFiles([]);
      void load();
    } catch (err) {
      apiToast(toast, err, 'Envoi impossible');
    } finally {
      setSending(false);
    }
  }

  async function uploadFiles(files: File[]): Promise<string[]> {
    const urls: string[] = [];
    for (const file of files) {
      if (file.size > STORAGE_MAX) {
        toast.error('Fichier trop volumineux (max 8 Mo)');
        continue;
      }
      const path = `${user?.id}/${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`;
      const { error } = await supabase.storage.from('chat-files').upload(path, file, {
        contentType: file.type,
      });
      if (error) throw error;
      urls.push(path);
    }
    return urls;
  }

  function formatVisitSlot(start: string, end: string): string {
    const startDate = new Date(start);
    const endDate = new Date(end);
    return startDate.toLocaleDateString('fr-FR') + ' à ' +
      startDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) +
      ' → ' +
      endDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  async function handleConfirmVisit(visitId: string) {
    try {
      await confirmVisit(visitId);
      toast.success('Visite confirmée');
      await load();
    } catch (err) {
      apiToast(toast, err, 'Confirmation impossible');
    }
  }

  async function handleDeclineVisit(visitId: string) {
    try {
      await declineVisit(visitId);
      toast.success('Proposition refusée');
      await load();
    } catch (err) {
      apiToast(toast, err, 'Refus impossible');
    }
  }

  async function handlePropose(slots: { start: string; end: string }[]) {
    setProposeModal(false);
    try {
      await proposeVisit(id, slots);
      toast.success('Visite proposée');
      await load();
    } catch {
      toast.error('Proposition impossible');
    }
  }

  const isOwn = (m: Message) => m.sender_id === user?.id;

  return (
    <div className="flex flex-col h-full min-h-0 max-h-[calc(100dvh-4rem)] rounded-kaza-lg border border-kaza-border bg-kaza-surface shadow-card md:max-h-[calc(100dvh-5rem)]">
      {/* En-tête */}
      <div className="flex flex-wrap items-center gap-3 border-b border-kaza-border px-4 py-3">
        <button
          onClick={() => router.push('/chat')}
          className="shrink-0 rounded-lg p-1.5 text-kaza-muted transition-colors hover:bg-kaza-bg hover:text-kaza-text md:hidden"
          aria-label="Retour à la liste"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </button>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-kaza-brand/25 bg-kaza-brand/10 text-xs font-bold text-kaza-brand">
          {conversation?.peer?.full_name
            ?.split(' ')
            .map((w) => w[0])
            .join('')
            .slice(0, 2)
            .toUpperCase() ?? 'KZ'}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-kaza-text">
            {conversation?.peer?.full_name ?? 'Conversation'}
          </p>
          <p className="truncate text-xs text-kaza-faint">
            {conversation?.residence?.title ?? 'Chat privé sécurisé'}{conversation?.residence ? ` · ${formatXof(conversation.residence.price_monthly)}/mois` : ' · pièces jointes acceptées'}
            <span
              data-testid="realtime-status"
              data-state={isConnected ? 'connected' : 'disconnected'}
              data-error={realtimeError ?? undefined}
              className={`ml-2 inline-block h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-kaza-success' : 'bg-kaza-danger'}`}
              title={isConnected ? 'Connecté' : 'Déconnecté'}
            />
          </p>
        </div>
        {!isLandlord && (
          <Button variant="primary" size="sm" className="ml-auto" onClick={() => setProposeModal(true)}>
            <Calendar className="h-3.5 w-3.5" aria-hidden />
            Proposer une visite
          </Button>
        )}
      </div>

      {/* Demandes de visite en attente : la confirmation porte sur une ligne visits réelle. */}
      {isLandlord && visits.some((visit) => visit.status === 'proposed') && (
        <div data-testid="visit-proposals" className="border-b border-kaza-border bg-kaza-brand/[0.04] px-4 py-3">
          <p className="text-sm font-semibold text-kaza-text">Demandes de visite en attente</p>
          <div className="mt-2 space-y-2">
            {visits
              .filter((visit) => visit.status === 'proposed')
              .map((visit) => (
                <div key={visit.id} className="flex flex-col gap-2 rounded-kaza border border-kaza-border bg-kaza-surface p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium text-kaza-text">{formatVisitSlot(visit.slot_start, visit.slot_end)}</p>
                    <p className="text-xs text-kaza-faint">Proposé par le locataire</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => void handleDeclineVisit(visit.id)}>
                      Refuser
                    </Button>
                    <Button size="sm" onClick={() => void handleConfirmVisit(visit.id)}>
                      Confirmer
                    </Button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} data-testid="chat-thread" className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {loading && <p className="text-center text-sm text-kaza-faint">Chargement…</p>}
        {!loading && messages.length === 0 && (
          <p className="py-10 text-center text-sm text-kaza-faint">
            Dites bonjour et négociez votre visite en toute confiance.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            data-testid={m.kind === 'visit_agreed' ? 'visit-confirmed-message' : undefined}
            className={cn('flex', isOwn(m) ? 'justify-end' : 'justify-start')}
          >
            <div
              className={cn(
                'max-w-[82%] rounded-kaza px-3.5 py-2.5 text-sm leading-relaxed',
                isOwn(m) ? 'bg-kaza-brand/15 text-kaza-text' : 'bg-kaza-bg text-kaza-text',
                m.kind === 'visit_agreed' && 'border border-kaza-brand/40 bg-kaza-brand/10',
                m.kind === 'visit_request' && 'border border-kaza-brand/30 bg-kaza-brand/5',
              )}
            >
              {m.kind === 'visit_request' && m.body && (
                <div className="space-y-2">
                  <p className="font-medium text-kaza-text">📅 Demande de visite</p>
                  {m.body.split('\n').map((line, idx) => (
                    <div key={idx} className="flex items-center gap-2 text-sm">
                      <Calendar className="h-4 w-4 text-kaza-brand" />
                      <span>{line}</span>
                    </div>
                  ))}
                  {!isLandlord && isOwn(m) && <p className="text-xs text-kaza-faint">En attente de confirmation du bailleur…</p>}
                  {isLandlord && <p className="text-xs text-kaza-faint">Cliquez sur un créneau pour le confirmer</p>}
                </div>
              )}
              {m.kind === 'visit_agreed' && m.body && (
                <div className="flex items-center gap-2 text-sm text-kaza-success">
                  <Check className="h-4 w-4" aria-hidden />
                  <span>{m.body}</span>
                </div>
              )}
              {m.kind !== 'visit_request' && m.kind !== 'visit_agreed' && (
                <>
                  {m.attachments.map((a, i) => {
                    const url = signedAttachments[a];
                    const isPdf = a.endsWith('.pdf') || a.includes('application/pdf');
                    if (!url) {
                      return (
                        <span key={i} className="mb-1.5 flex items-center gap-2 rounded-kaza border border-kaza-border bg-kaza-raised px-3 py-2 text-xs text-kaza-muted">
                          <Paperclip className="h-3.5 w-3.5" aria-hidden /> {isPdf ? 'Document' : 'Image'} joint
                        </span>
                      );
                    }
                    return isPdf ? (
                      <a
                        key={i}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="mb-1.5 flex items-center gap-2 rounded-kaza border border-kaza-border bg-kaza-raised px-3 py-2 text-xs text-kaza-brand hover:border-kaza-brand/50"
                      >
                        <Paperclip className="h-3.5 w-3.5" aria-hidden /> Document joint
                      </a>
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={i} src={url} alt="Pièce jointe" className="mb-1.5 max-h-56 rounded-kaza border border-kaza-border object-cover" />
                    );
                  })}
                  {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                </>
              )}
              <p className={cn('mt-1 flex items-center gap-1 text-[10px]', isOwn(m) ? 'justify-end text-kaza-faint' : 'text-kaza-faint')}>
                {timeAgo(m.created_at)}
                {isOwn(m) && (m.read_at ? <CheckCheck className="h-3 w-3 text-kaza-brand" aria-label="Lu" /> : <Check className="h-3 w-3" aria-label="Envoyé" />)}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Pièces jointes en attente */}
      {pendingFiles.length > 0 && (
        <div className="flex gap-2 overflow-x-auto border-t border-kaza-border px-4 pt-3">
          {pendingFiles.map((f, i) => (
            <span key={i} className="relative flex items-center gap-2 rounded-kaza border border-kaza-border bg-kaza-bg px-3 py-1.5 text-xs text-kaza-muted">
              {f.name.slice(0, 24)}
              <button onClick={() => setPendingFiles((p) => p.filter((_, j) => j !== i))} className="text-kaza-faint hover:text-kaza-danger" aria-label="Retirer le fichier">
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Saisie */}
      <form onSubmit={(e) => void handleSend(e, pendingFiles)} className="flex items-center gap-2 border-t border-kaza-border p-3">
        <label className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-kaza text-kaza-muted transition-colors hover:bg-kaza-bg hover:text-kaza-brand" title="Joindre une photo ou un document">
          <Paperclip className="h-4.5 w-4.5" aria-hidden />
          <input
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,.pdf"
            className="sr-only"
            aria-label="Joindre un fichier"
            onChange={(e) => setPendingFiles([...pendingFiles, ...Array.from(e.target.files ?? [])])}
          />
        </label>
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Écrivez votre message…"
          aria-label="Message"
          className="kaza-input flex-1"
          maxLength={4000}
        />
        <Button type="submit" size="icon" loading={sending} disabled={!body.trim() && pendingFiles.length === 0} aria-label="Envoyer">
          <Send className="h-4 w-4" aria-hidden />
        </Button>
      </form>

      {/* Modale proposition de visite (locataire) */}
      {proposeModal && (
        <VisitProposalModal
          conversationId={id}
          onClose={() => setProposeModal(false)}
          onPropose={handlePropose}
        />
      )}
    </div>
  );
}