import type { Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// note : capture des frames Realtime réellement échangées par la page. Sert à
// prouver sur le fil que le chat souscrit avec l'UUID réel de la conversation
// (régression du `\${id}` littéral, rejeté par le serveur en 22P02) et qu'aucune
// souscription n'est refusée par un événement `system` pendant le parcours.
// Le callback SUBSCRIBED ne suffit pas : le rejet arrive après lui.
//
// Diagnostic C1 : la même capture enregistre aussi, horodatés, les joins
// (bindings complets), leurs réponses `phx_reply`, tous les événements `system`
// et chaque `postgres_changes` effectivement reçu (table, type, record). Des
// sondes Node, authentifiées par une vraie session utilisateur, rejouent la
// souscription hors de la page pour isoler la couche fautive (classifyC1).

export interface RealtimeJoin {
  topic: string;
  filters: string[];
}

export interface PostgresBinding {
  event: string;
  schema: string | null;
  table: string | null;
  filter: string | null;
}

export interface WireJoin {
  at: string;
  topic: string;
  ref: string | null;
  bindings: PostgresBinding[];
}

export interface WireJoinReply {
  at: string;
  topic: string;
  ref: string | null;
  status: string | null;
  response: unknown;
}

export interface WireSystemEvent {
  at: string;
  topic: string;
  status: string | null;
  extension: string | null;
  message: string | null;
}

export interface WireChange {
  at: string;
  topic: string;
  table: string | null;
  type: string | null;
  record: Record<string, unknown> | null;
  commitTimestamp: string | null;
}

export interface RealtimeWire {
  joins: RealtimeJoin[];
  systemErrors: string[];
  sockets: string[];
  joinLog: WireJoin[];
  joinReplies: WireJoinReply[];
  systemEvents: WireSystemEvent[];
  changes: WireChange[];
}

interface PhoenixFrame {
  joinRef: string | null;
  ref: string | null;
  topic: string;
  event: string;
  payload: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function describeMessage(message: unknown): string | null {
  if (message === undefined || message === null) return null;
  return typeof message === 'string' ? message : JSON.stringify(message);
}

export function parsePhoenixFrame(raw: string | Buffer): PhoenixFrame | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Protocole vsn 2.0.0 : [join_ref, ref, topic, event, payload].
    if (Array.isArray(parsed) && parsed.length === 5 && typeof parsed[2] === 'string' && typeof parsed[3] === 'string') {
      return {
        joinRef: stringOrNull(parsed[0]),
        ref: stringOrNull(parsed[1]),
        topic: parsed[2],
        event: parsed[3],
        payload: parsed[4],
      };
    }
    // Protocole vsn 1.0.0 : { topic, event, payload, ref }.
    if (isRecord(parsed) && typeof parsed.topic === 'string' && typeof parsed.event === 'string') {
      return {
        joinRef: stringOrNull(parsed.join_ref),
        ref: stringOrNull(parsed.ref),
        topic: parsed.topic,
        event: parsed.event,
        payload: parsed.payload,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function joinFilters(payload: unknown): string[] {
  if (!isRecord(payload) || !isRecord(payload.config) || !Array.isArray(payload.config.postgres_changes)) {
    return [];
  }
  return payload.config.postgres_changes.filter(isRecord).map((binding) => String(binding.filter));
}

export function joinBindings(payload: unknown): PostgresBinding[] {
  if (!isRecord(payload) || !isRecord(payload.config) || !Array.isArray(payload.config.postgres_changes)) {
    return [];
  }
  return payload.config.postgres_changes.filter(isRecord).map((binding) => ({
    event: stringOrNull(binding.event) ?? '*',
    schema: stringOrNull(binding.schema),
    table: stringOrNull(binding.table),
    filter: stringOrNull(binding.filter),
  }));
}

export function parseJoinReply(topic: string, ref: string | null, payload: unknown, at: string): WireJoinReply {
  return {
    at,
    topic,
    ref,
    status: isRecord(payload) ? stringOrNull(payload.status) : null,
    response: isRecord(payload) ? payload.response : payload,
  };
}

export function parseSystemEvent(topic: string, payload: unknown, at: string): WireSystemEvent {
  if (!isRecord(payload)) return { at, topic, status: null, extension: null, message: describeMessage(payload) };
  return {
    at,
    topic,
    status: stringOrNull(payload.status),
    extension: stringOrNull(payload.extension),
    message: describeMessage(payload.message),
  };
}

// note : couvre la frame brute du serveur ({ ids, data: { type, record } }) et
// le payload déjà remis par supabase-js au callback ({ eventType, new }).
export function parsePostgresChange(topic: string, payload: unknown, at: string): WireChange | null {
  if (!isRecord(payload)) return null;
  const data = isRecord(payload.data) ? payload.data : payload;
  const record = isRecord(data.record) ? data.record : isRecord(data.new) ? data.new : null;
  return {
    at,
    topic,
    table: stringOrNull(data.table),
    type: stringOrNull(data.type) ?? stringOrNull(data.eventType),
    record,
    commitTimestamp: stringOrNull(data.commit_timestamp),
  };
}

export function captureRealtimeWire(page: Page): RealtimeWire {
  const wire: RealtimeWire = {
    joins: [],
    systemErrors: [],
    sockets: [],
    joinLog: [],
    joinReplies: [],
    systemEvents: [],
    changes: [],
  };
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/realtime/')) return;
    // note : l'URL porte la clé anon (publique) — on ne garde que l'origine et le chemin.
    const url = new URL(ws.url());
    wire.sockets.push(`${new Date().toISOString()} ${url.origin}${url.pathname}`);
    ws.on('framesent', ({ payload }) => {
      const frame = parsePhoenixFrame(payload);
      if (frame?.event === 'phx_join') {
        wire.joins.push({ topic: frame.topic, filters: joinFilters(frame.payload) });
        wire.joinLog.push({
          at: new Date().toISOString(),
          topic: frame.topic,
          ref: frame.ref,
          bindings: joinBindings(frame.payload),
        });
      }
    });
    ws.on('framereceived', ({ payload }) => {
      const frame = parsePhoenixFrame(payload);
      if (!frame) return;
      const at = new Date().toISOString();
      if (frame.event === 'phx_reply') {
        const isJoinReply = wire.joinLog.some((join) => join.topic === frame.topic && join.ref === frame.ref);
        if (isJoinReply) wire.joinReplies.push(parseJoinReply(frame.topic, frame.ref, frame.payload, at));
        return;
      }
      if (frame.event === 'system') {
        const event = parseSystemEvent(frame.topic, frame.payload, at);
        wire.systemEvents.push(event);
        if (event.status === 'error') {
          wire.systemErrors.push(`${frame.topic}: ${event.message ?? 'null'}`);
        }
        return;
      }
      if (frame.event === 'postgres_changes') {
        const change = parsePostgresChange(frame.topic, frame.payload, at);
        if (change) wire.changes.push(change);
      }
    });
  });
  return wire;
}

// ---------------------------------------------------------------------------
// Sondes Node : mêmes bindings que ChatWindow, hors navigateur, avec le JWT
// d'une vraie session utilisateur (signInWithPassword, clé anon — jamais
// service_role). Elles isolent filtre / client dédié / serveur.
// ---------------------------------------------------------------------------

export interface RealtimeEnv {
  url: string;
  anonKey: string;
}

export function realtimeEnv(): RealtimeEnv | null {
  const url = process.env.E2E_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.E2E_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anonKey ? { url: url.replace(/\/+$/g, ''), anonKey } : null;
}

export interface UserSession {
  client: SupabaseClient;
  accessToken: string;
  userId: string;
}

export async function signInRealUser(env: RealtimeEnv, email: string, password: string): Promise<UserSession> {
  const client = createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(`[KAZA:C1] connexion réelle impossible pour ${email} : ${error?.message ?? 'session absente'}`);
  }
  return { client, accessToken: data.session.access_token, userId: data.session.user.id };
}

/**
 * dedicated : réplique `supabaseRealtime` (client sans session, `setAuth` non
 * attendu, comme ChatWindow). session : client authentifié par la session
 * elle-même (chemin standard supabase-js).
 */
export type ProbeMode = 'dedicated' | 'session';

export interface ProbeSpec {
  label: string;
  mode: ProbeMode;
  table: string;
  event: 'INSERT' | 'UPDATE';
  filter: string | null;
}

export interface ProbeStatus {
  at: string;
  status: string;
  detail: string | null;
}

export interface ProbeResult {
  spec: ProbeSpec;
  topic: string;
  statuses: ProbeStatus[];
  systemEvents: WireSystemEvent[];
  changes: WireChange[];
}

export interface RealtimeProbe {
  result: ProbeResult;
  close: () => Promise<void>;
}

export function openRealtimeProbe(env: RealtimeEnv, session: UserSession, spec: ProbeSpec): RealtimeProbe {
  const client =
    spec.mode === 'dedicated'
      ? createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
      : session.client;
  if (spec.mode === 'dedicated') {
    // note : volontairement non attendu, exactement comme ChatWindow ; si cela
    // suffit à envoyer le join avec la clé anon, la sonde le révélera.
    void client.realtime.setAuth(session.accessToken);
  }
  const topic = `c1-${spec.label}-${Date.now()}`;
  const result: ProbeResult = { spec, topic, statuses: [], systemEvents: [], changes: [] };
  const binding = {
    event: spec.event,
    schema: 'public',
    table: spec.table,
    ...(spec.filter === null ? {} : { filter: spec.filter }),
  };
  const channel = client
    .channel(topic)
    .on('postgres_changes', binding, (payload: unknown) => {
      const change = parsePostgresChange(`realtime:${topic}`, payload, new Date().toISOString());
      if (change) result.changes.push(change);
    })
    .on('system', {}, (payload: unknown) => {
      result.systemEvents.push(parseSystemEvent(`realtime:${topic}`, payload, new Date().toISOString()));
    })
    .subscribe((status, err) => {
      result.statuses.push({
        at: new Date().toISOString(),
        status,
        detail: err instanceof Error ? err.message : err ? String(err) : null,
      });
    });
  return {
    result,
    close: async () => {
      await client.removeChannel(channel);
      if (spec.mode === 'dedicated') client.realtime.disconnect();
    },
  };
}

export function probeSubscribed(result: ProbeResult): boolean {
  return result.statuses.some((entry) => entry.status === 'SUBSCRIBED');
}

/** Verdict `system` de l'extension postgres_changes : 'ok', 'error' ou null (aucun reçu). */
export function probeBindingVerdict(result: ProbeResult): string | null {
  const verdicts = result.systemEvents.filter(
    (event) => event.status === 'error' || event.extension === 'postgres_changes',
  );
  return verdicts.length === 0 ? null : verdicts[verdicts.length - 1].status;
}

export function changeMatches(
  change: WireChange,
  table: string,
  type: string,
  predicate: (record: Record<string, unknown>) => boolean,
): boolean {
  return change.table === table && change.type === type && change.record !== null && predicate(change.record);
}

// ---------------------------------------------------------------------------
// Classification C1 : chaque chemin reçoit-il l'événement attendu ?
// ---------------------------------------------------------------------------

export type C1Verdict =
  | 'no-reproduction'
  | 'filter'
  | 'dedicated-client'
  | 'server-publication'
  | 'chatwindow-integration'
  | 'inconclusive';

export interface C1Observation {
  /** Toutes les sondes ont atteint SUBSCRIBED sans erreur `system`. */
  probesReady: boolean;
  /** Sonde client dédié + filtre `conversation_id=eq.<uuid>` (réplique ChatWindow). */
  filteredDedicated: boolean;
  /** Sonde client dédié, même table/événement, sans filtre. */
  unfilteredDedicated: boolean;
  /** Sonde client authentifié par session + même filtre. */
  filteredSession: boolean;
  /** Frame postgres_changes reçue par la page sur le topic du ChatWindow. */
  browserWire: boolean;
  /** Effet visible dans le fil du ChatWindow. */
  browserDom: boolean;
}

export const C1_VERDICT_MEANING: Record<C1Verdict, string> = {
  'no-reproduction': 'La page reçoit la frame et l’affiche : C1 non reproduit.',
  filter: 'Seule la sonde sans filtre reçoit : le filtre conversation_id est en cause.',
  'dedicated-client': 'La sonde session reçoit, pas la sonde client dédié : le client Realtime dédié est en cause.',
  'server-publication': 'Aucun chemin ne reçoit : serveur Realtime / publication / RLS de diffusion en cause.',
  'chatwindow-integration':
    'Le serveur livre à une souscription identique hors page (ou la frame arrive), mais le fil ne l’affiche pas : intégration ChatWindow en cause.',
  inconclusive: 'Préconditions non réunies (sonde non souscrite) ou rendu sans frame : relancer / lire le rapport.',
};

export function classifyC1(observation: C1Observation): C1Verdict {
  if (observation.browserWire && observation.browserDom) return 'no-reproduction';
  // note : affiché sans frame sur le topic du chat → autre chemin (refetch) ; rien à conclure.
  if (observation.browserDom) return 'inconclusive';
  if (observation.browserWire) return 'chatwindow-integration';
  if (!observation.probesReady) return 'inconclusive';
  if (observation.filteredDedicated) return 'chatwindow-integration';
  if (observation.filteredSession) return 'dedicated-client';
  if (observation.unfilteredDedicated) return 'filter';
  return 'server-publication';
}

/** Les trois sondes de comparaison, sur la table/l'événement que ChatWindow écoute. */
export function openC1Probes(
  env: RealtimeEnv,
  session: UserSession,
  table: string,
  event: 'INSERT' | 'UPDATE',
  conversationId: string,
): RealtimeProbe[] {
  const filter = `conversation_id=eq.${conversationId}`;
  return [
    openRealtimeProbe(env, session, { label: 'filtered-dedicated', mode: 'dedicated', table, event, filter }),
    openRealtimeProbe(env, session, { label: 'unfiltered-dedicated', mode: 'dedicated', table, event, filter: null }),
    openRealtimeProbe(env, session, { label: 'filtered-session', mode: 'session', table, event, filter }),
  ];
}

export function probesReady(probes: RealtimeProbe[]): boolean {
  return probes.every(
    ({ result }) => probeSubscribed(result) && probeBindingVerdict(result) !== 'error',
  );
}

export interface C1ReportInput {
  scenario: string;
  conversationId: string;
  table: string;
  type: 'INSERT' | 'UPDATE';
  predicate: (record: Record<string, unknown>) => boolean;
  wire: RealtimeWire;
  probes: RealtimeProbe[];
  browserDom: boolean;
}

export function buildC1Report(input: C1ReportInput) {
  const chatTopic = `realtime:messages:${input.conversationId}`;
  const matches = (change: WireChange) => changeMatches(change, input.table, input.type, input.predicate);
  const probeReceived = (label: string) =>
    input.probes.some(({ result }) => result.spec.label === label && result.changes.some(matches));
  const observation: C1Observation = {
    probesReady: probesReady(input.probes),
    filteredDedicated: probeReceived('filtered-dedicated'),
    unfilteredDedicated: probeReceived('unfiltered-dedicated'),
    filteredSession: probeReceived('filtered-session'),
    browserWire: input.wire.changes.some((change) => change.topic === chatTopic && matches(change)),
    browserDom: input.browserDom,
  };
  const verdict = classifyC1(observation);
  return {
    scenario: input.scenario,
    conversationId: input.conversationId,
    expected: { table: input.table, type: input.type, chatTopic },
    verdict,
    meaning: C1_VERDICT_MEANING[verdict],
    observation,
    browser: {
      sockets: input.wire.sockets,
      joins: input.wire.joinLog,
      joinReplies: input.wire.joinReplies,
      systemEvents: input.wire.systemEvents,
      changes: input.wire.changes,
      // note : tout postgres_changes correspondant, quel que soit le topic
      // (ex. `conversations-live` de la liste latérale, client SSR non filtré).
      matchingChangesByTopic: input.wire.changes.filter(matches).map((change) => change.topic),
    },
    probes: input.probes.map(({ result }) => ({
      ...result,
      subscribed: probeSubscribed(result),
      bindingVerdict: probeBindingVerdict(result),
      received: result.changes.some(matches),
    })),
  };
}

export type C1Report = ReturnType<typeof buildC1Report>;
