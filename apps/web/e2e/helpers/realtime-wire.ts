import type { Page } from '@playwright/test';

// note : capture des frames Realtime réellement échangées par la page. Sert à
// prouver sur le fil que le chat souscrit avec l'UUID réel de la conversation
// (régression du `\${id}` littéral, rejeté par le serveur en 22P02) et qu'aucune
// souscription n'est refusée par un événement `system` pendant le parcours.
// Le callback SUBSCRIBED ne suffit pas : le rejet arrive après lui.

export interface RealtimeJoin {
  topic: string;
  filters: string[];
}

export interface RealtimeWire {
  joins: RealtimeJoin[];
  systemErrors: string[];
}

interface PhoenixFrame {
  topic: string;
  event: string;
  payload: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePhoenixFrame(raw: string | Buffer): PhoenixFrame | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Protocole vsn 2.0.0 : [join_ref, ref, topic, event, payload].
    if (Array.isArray(parsed) && parsed.length === 5 && typeof parsed[2] === 'string' && typeof parsed[3] === 'string') {
      return { topic: parsed[2], event: parsed[3], payload: parsed[4] };
    }
    // Protocole vsn 1.0.0 : { topic, event, payload, ref }.
    if (isRecord(parsed) && typeof parsed.topic === 'string' && typeof parsed.event === 'string') {
      return { topic: parsed.topic, event: parsed.event, payload: parsed.payload };
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

export function captureRealtimeWire(page: Page): RealtimeWire {
  const wire: RealtimeWire = { joins: [], systemErrors: [] };
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/realtime/')) return;
    ws.on('framesent', ({ payload }) => {
      const frame = parsePhoenixFrame(payload);
      if (frame?.event === 'phx_join') {
        wire.joins.push({ topic: frame.topic, filters: joinFilters(frame.payload) });
      }
    });
    ws.on('framereceived', ({ payload }) => {
      const frame = parsePhoenixFrame(payload);
      if (frame?.event === 'system' && isRecord(frame.payload) && frame.payload.status === 'error') {
        const { message } = frame.payload;
        wire.systemErrors.push(`${frame.topic}: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
      }
    });
  });
  return wire;
}
