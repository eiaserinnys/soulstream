import {
  UI_EVENT_SCHEMA_VERSION,
  type UiEventEntry,
  type UiEventTargetKind,
  type UiEventType,
} from '../../../packages/wire-schema/src/ui_events';
import type { ApiRequestContext } from './clientCore';

export interface UiEventTarget {
  kind: UiEventTargetKind;
  id: string;
}

export interface UiEventWire {
  eventId: string;
  seq: number;
  occurredAt: string;
  type: UiEventType;
  target: UiEventTarget | null;
  from: UiEventTarget | null;
  entry: UiEventEntry | null;
  flowId: string | null;
  attrs: Record<string, unknown>;
}

export interface UiEventsBatch {
  schemaVersion: typeof UI_EVENT_SCHEMA_VERSION;
  installId: string;
  clientSessionKey: string;
  appVersion: string;
  events: UiEventWire[];
}

export interface UiEventsConfig {
  enabled: boolean;
  flushIntervalMs: number;
  maxBatchSize: number;
  maxQueueSize: number;
  schemaVersion: string;
}

export interface UiEventsPostResult {
  accepted: number;
  duplicates: number;
  disabled?: boolean;
  rejected: Array<{ eventId: string; reason: string }>;
}

const UI_EVENTS_PATH = '/api/ui-events';

export function createUiEventsEndpoints({
  base,
  authFetch,
  readJson,
}: ApiRequestContext) {
  return {
    getUiEventsConfig: (): Promise<UiEventsConfig> =>
      authFetch(`${base}${UI_EVENTS_PATH}/config`).then((response) =>
        readJson(response, 'getUiEventsConfig'),
      ),

    postUiEvents: (batch: UiEventsBatch): Promise<UiEventsPostResult> =>
      authFetch(`${base}${UI_EVENTS_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      }).then((response) => readJson(response, 'postUiEvents')),
  };
}
