// note : santé d'un channel Realtime portant des bindings postgres_changes.
// Le callback de `subscribe()` passe à SUBSCRIBED dès que le serveur accepte le
// join du channel. La souscription PostgreSQL elle-même est validée ensuite, de
// façon asynchrone : son échec (filtre invalide, table non publiée…) n'arrive
// QUE par un événement `system` { status: 'error' }. Sans ce second signal,
// l'interface affichait « connecté » alors qu'aucun événement ne pouvait arriver.

export interface RealtimeHealth {
  /** Le join du channel a été accepté par le serveur (SUBSCRIBED). */
  joined: boolean;
  /** Échec du join lui-même (CHANNEL_ERROR / TIMED_OUT). */
  channelError: string | null;
  /** Échec de la souscription PostgreSQL signalé par un événement `system`. */
  bindingError: string | null;
}

export const INITIAL_REALTIME_HEALTH: RealtimeHealth = {
  joined: false,
  channelError: null,
  bindingError: null,
};

const DEFAULT_BINDING_ERROR = 'Souscription temps réel refusée par le serveur';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeSystemMessage(message: unknown): string {
  if (typeof message === 'string') {
    return message.trim() === '' ? DEFAULT_BINDING_ERROR : message;
  }
  // note : un message non textuel est conservé tel quel (sérialisé) plutôt que
  // remplacé par un libellé générique, pour ne jamais masquer la cause serveur.
  return message === undefined || message === null ? DEFAULT_BINDING_ERROR : JSON.stringify(message);
}

export function applySubscribeStatus(
  health: RealtimeHealth,
  status: string,
  detail: string | null,
): RealtimeHealth {
  if (status === 'SUBSCRIBED') {
    // note : chaque (re)join relance la souscription PostgreSQL côté serveur ;
    // son verdict arrive APRÈS SUBSCRIBED, via un nouvel événement `system`.
    return { joined: true, channelError: null, bindingError: null };
  }
  if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
    return { ...health, joined: false, channelError: detail ?? status };
  }
  return { ...health, joined: false };
}

export function applySystemEvent(health: RealtimeHealth, payload: unknown): RealtimeHealth {
  if (!isRecord(payload)) return health;
  if (payload.status === 'error') {
    return { ...health, bindingError: describeSystemMessage(payload.message) };
  }
  // note : seule une confirmation explicite de l'extension postgres_changes lève
  // une erreur de binding ; un `ok` d'une autre extension ne doit pas la masquer.
  if (payload.status === 'ok' && payload.extension === 'postgres_changes') {
    return { ...health, bindingError: null };
  }
  return health;
}

export function isRealtimeLive(health: RealtimeHealth): boolean {
  return health.joined && health.bindingError === null;
}

export function realtimeHealthError(health: RealtimeHealth): string | null {
  return health.bindingError ?? health.channelError;
}
