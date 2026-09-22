import { describe, it, expect } from 'vitest';
import {
  INITIAL_REALTIME_HEALTH,
  applySubscribeStatus,
  applySystemEvent,
  isRealtimeLive,
  realtimeHealthError,
} from '../apps/web/src/lib/realtime-health';

// Fragment d'erreur serveur rapporté par le run CI 35791598908 (filtre `${id}`
// littéral). L'enveloppe exacte du payload `system` n'est pas reproduite ici.
const UUID_ERROR = 'invalid input syntax for type uuid: "${id}"';

const joined = applySubscribeStatus(INITIAL_REALTIME_HEALTH, 'SUBSCRIBED', null);

describe('realtime-health', () => {
  it('n’est pas connecté avant SUBSCRIBED', () => {
    expect(isRealtimeLive(INITIAL_REALTIME_HEALTH)).toBe(false);
    expect(realtimeHealthError(INITIAL_REALTIME_HEALTH)).toBeNull();
  });

  it('SUBSCRIBED sans verdict system : connecté, sans erreur', () => {
    expect(isRealtimeLive(joined)).toBe(true);
    expect(realtimeHealthError(joined)).toBeNull();
  });

  it('SUBSCRIBED puis system error : déconnecté avec le message serveur', () => {
    const failed = applySystemEvent(joined, {
      extension: 'postgres_changes',
      status: 'error',
      message: UUID_ERROR,
    });
    expect(isRealtimeLive(failed)).toBe(false);
    expect(realtimeHealthError(failed)).toBe(UUID_ERROR);
  });

  it('une erreur system reste visible quelle que soit l’extension', () => {
    const failed = applySystemEvent(joined, { extension: 'system', status: 'error', message: 'boom' });
    expect(isRealtimeLive(failed)).toBe(false);
    expect(realtimeHealthError(failed)).toBe('boom');
  });

  it('message absent ou vide : libellé explicite, jamais une chaîne vide', () => {
    const noMessage = applySystemEvent(joined, { status: 'error' });
    const blank = applySystemEvent(joined, { status: 'error', message: '  ' });
    expect(realtimeHealthError(noMessage)).toBe('Souscription temps réel refusée par le serveur');
    expect(realtimeHealthError(blank)).toBe('Souscription temps réel refusée par le serveur');
  });

  it('message non textuel : conservé sérialisé, pas masqué', () => {
    const failed = applySystemEvent(joined, { status: 'error', message: { code: '22P02' } });
    expect(realtimeHealthError(failed)).toBe('{"code":"22P02"}');
  });

  it('un ok postgres_changes après une erreur rétablit la connexion', () => {
    const failed = applySystemEvent(joined, { extension: 'postgres_changes', status: 'error', message: UUID_ERROR });
    const recovered = applySystemEvent(failed, {
      extension: 'postgres_changes',
      status: 'ok',
      message: 'Subscribed to PostgreSQL',
    });
    expect(isRealtimeLive(recovered)).toBe(true);
    expect(realtimeHealthError(recovered)).toBeNull();
  });

  it('un ok d’une autre extension ne masque pas une erreur de binding', () => {
    const failed = applySystemEvent(joined, { extension: 'postgres_changes', status: 'error', message: UUID_ERROR });
    const other = applySystemEvent(failed, { extension: 'system', status: 'ok', message: 'ready' });
    expect(isRealtimeLive(other)).toBe(false);
    expect(realtimeHealthError(other)).toBe(UUID_ERROR);
  });

  it('un nouveau join repart d’un verdict vierge (le serveur re-souscrit)', () => {
    const failed = applySystemEvent(joined, { status: 'error', message: UUID_ERROR });
    const closed = applySubscribeStatus(failed, 'CLOSED', 'CLOSED');
    const rejoined = applySubscribeStatus(closed, 'SUBSCRIBED', null);
    expect(isRealtimeLive(closed)).toBe(false);
    expect(realtimeHealthError(closed)).toBe(UUID_ERROR);
    expect(isRealtimeLive(rejoined)).toBe(true);
    expect(realtimeHealthError(rejoined)).toBeNull();
  });

  it('CHANNEL_ERROR et TIMED_OUT : déconnecté avec le détail', () => {
    const channelError = applySubscribeStatus(joined, 'CHANNEL_ERROR', 'join refusé');
    const timedOut = applySubscribeStatus(joined, 'TIMED_OUT', 'TIMED_OUT');
    expect(isRealtimeLive(channelError)).toBe(false);
    expect(realtimeHealthError(channelError)).toBe('join refusé');
    expect(isRealtimeLive(timedOut)).toBe(false);
    expect(realtimeHealthError(timedOut)).toBe('TIMED_OUT');
  });

  it('ignore les payloads system non objets', () => {
    expect(applySystemEvent(joined, null)).toBe(joined);
    expect(applySystemEvent(joined, 'error')).toBe(joined);
    expect(applySystemEvent(joined, ['error'])).toBe(joined);
  });

  it('n’altère pas l’état reçu (fonctions pures)', () => {
    const snapshot = { ...joined };
    applySystemEvent(joined, { status: 'error', message: UUID_ERROR });
    applySubscribeStatus(joined, 'CLOSED', 'CLOSED');
    expect(joined).toEqual(snapshot);
  });
});
