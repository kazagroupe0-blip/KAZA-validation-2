import { describe, it, expect } from 'vitest';
import {
  buildC1Report,
  classifyC1,
  joinBindings,
  parsePhoenixFrame,
  parsePostgresChange,
  parseSystemEvent,
  type C1Observation,
  type ProbeResult,
  type RealtimeProbe,
  type RealtimeWire,
} from '../apps/web/e2e/helpers/realtime-wire';

const ID = '11111111-2222-3333-4444-555555555555';
const AT = '2026-09-23T10:00:00.000Z';

const allReceived: C1Observation = {
  probesReady: true,
  filteredDedicated: true,
  unfilteredDedicated: true,
  filteredSession: true,
  browserWire: true,
  browserDom: true,
};

describe('realtime-wire : parsing des frames', () => {
  it('lit join_ref et ref du protocole vsn 2.0.0', () => {
    const frame = parsePhoenixFrame(JSON.stringify(['3', '3', `realtime:messages:${ID}`, 'phx_join', {}]));
    expect(frame).toMatchObject({ joinRef: '3', ref: '3', topic: `realtime:messages:${ID}`, event: 'phx_join' });
  });

  it('extrait les bindings complets du phx_join', () => {
    const payload = {
      config: {
        postgres_changes: [
          { event: 'UPDATE', schema: 'public', table: 'visits', filter: `conversation_id=eq.${ID}` },
          { event: 'INSERT', schema: 'public', table: 'messages' },
        ],
      },
    };
    expect(joinBindings(payload)).toEqual([
      { event: 'UPDATE', schema: 'public', table: 'visits', filter: `conversation_id=eq.${ID}` },
      { event: 'INSERT', schema: 'public', table: 'messages', filter: null },
    ]);
  });

  it('lit un postgres_changes brut du serveur', () => {
    const change = parsePostgresChange(
      'realtime:t',
      { ids: [1], data: { table: 'messages', type: 'INSERT', record: { body: 'x' }, commit_timestamp: AT } },
      AT,
    );
    expect(change).toEqual({
      at: AT,
      topic: 'realtime:t',
      table: 'messages',
      type: 'INSERT',
      record: { body: 'x' },
      commitTimestamp: AT,
    });
  });

  it('lit un payload supabase-js (eventType / new)', () => {
    const change = parsePostgresChange('realtime:t', { table: 'visits', eventType: 'UPDATE', new: { status: 'confirmed' } }, AT);
    expect(change).toMatchObject({ table: 'visits', type: 'UPDATE', record: { status: 'confirmed' } });
  });

  it('conserve extension et message d’un événement system', () => {
    expect(parseSystemEvent('realtime:t', { extension: 'postgres_changes', status: 'error', message: 'boom' }, AT)).toEqual({
      at: AT,
      topic: 'realtime:t',
      status: 'error',
      extension: 'postgres_changes',
      message: 'boom',
    });
  });
});

describe('realtime-wire : classifyC1', () => {
  it('tout reçu et affiché : non reproduit', () => {
    expect(classifyC1(allReceived)).toBe('no-reproduction');
  });

  it('frame reçue par la page mais pas affichée : intégration ChatWindow', () => {
    expect(classifyC1({ ...allReceived, browserDom: false })).toBe('chatwindow-integration');
  });

  it('sonde identique reçoit, la page non : intégration ChatWindow', () => {
    expect(classifyC1({ ...allReceived, browserWire: false, browserDom: false })).toBe('chatwindow-integration');
  });

  it('seule la sonde session reçoit : client dédié', () => {
    expect(
      classifyC1({ ...allReceived, browserWire: false, browserDom: false, filteredDedicated: false }),
    ).toBe('dedicated-client');
  });

  it('seule la sonde sans filtre reçoit : filtre', () => {
    expect(
      classifyC1({
        ...allReceived,
        browserWire: false,
        browserDom: false,
        filteredDedicated: false,
        filteredSession: false,
      }),
    ).toBe('filter');
  });

  it('aucun chemin ne reçoit : serveur / publication', () => {
    expect(
      classifyC1({
        probesReady: true,
        filteredDedicated: false,
        unfilteredDedicated: false,
        filteredSession: false,
        browserWire: false,
        browserDom: false,
      }),
    ).toBe('server-publication');
  });

  it('sondes non souscrites : inconclusive', () => {
    expect(
      classifyC1({ ...allReceived, probesReady: false, filteredDedicated: false, browserWire: false, browserDom: false }),
    ).toBe('inconclusive');
  });
});

describe('realtime-wire : buildC1Report', () => {
  const probe = (label: string, received: boolean): RealtimeProbe => {
    const result: ProbeResult = {
      spec: { label, mode: 'dedicated', table: 'messages', event: 'INSERT', filter: null },
      topic: `c1-${label}`,
      statuses: [{ at: AT, status: 'SUBSCRIBED', detail: null }],
      systemEvents: [{ at: AT, topic: `realtime:c1-${label}`, status: 'ok', extension: 'postgres_changes', message: null }],
      changes: received
        ? [{ at: AT, topic: `realtime:c1-${label}`, table: 'messages', type: 'INSERT', record: { body: 'hi' }, commitTimestamp: AT }]
        : [],
    };
    return { result, close: async () => undefined };
  };
  const wire: RealtimeWire = {
    joins: [],
    systemErrors: [],
    sockets: [],
    joinLog: [],
    joinReplies: [],
    systemEvents: [],
    // note : reçu uniquement sur la liste latérale, pas sur le topic du chat.
    changes: [
      { at: AT, topic: 'realtime:conversations-live', table: 'messages', type: 'INSERT', record: { body: 'hi' }, commitTimestamp: AT },
    ],
  };

  it('ne compte que le topic du ChatWindow comme réception navigateur', () => {
    const report = buildC1Report({
      scenario: 'test',
      conversationId: ID,
      table: 'messages',
      type: 'INSERT',
      predicate: (record) => record.body === 'hi',
      wire,
      probes: [probe('filtered-dedicated', true), probe('unfiltered-dedicated', true), probe('filtered-session', true)],
      browserDom: false,
    });
    expect(report.observation.browserWire).toBe(false);
    expect(report.browser.matchingChangesByTopic).toEqual(['realtime:conversations-live']);
    expect(report.verdict).toBe('chatwindow-integration');
  });
});
