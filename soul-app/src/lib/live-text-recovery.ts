import type {
  LiveTextEventMetadata,
  LiveTextSnapshotStream,
  LiveTextSnapshotWire,
  SessionEvent,
} from '../api/types';
import { isValidIsoDateTime } from './session-feed-activity';

export const LIVE_TEXT_SNAPSHOT_MAX_UTF8_BYTES = 256 * 1024;

export function normalizeLiveTextSnapshot(
  value: unknown,
): LiveTextSnapshotWire | null {
  if (!isRecord(value) || value.type !== 'text_snapshot') return null;
  if (
    !isNonNegativeSafeInteger(value.basedOnEventId)
    || !isNonNegativeSafeInteger(value.throughLiveSeq)
    || !Array.isArray(value.streams)
  ) {
    return null;
  }

  const streams: LiveTextSnapshotStream[] = [];
  const identities = new Set<string>();
  for (const raw of value.streams) {
    const stream = normalizeSnapshotStream(raw);
    if (!stream || identities.has(stream.streamIdentity)) return null;
    identities.add(stream.streamIdentity);
    streams.push(stream);
  }
  return {
    type: 'text_snapshot',
    basedOnEventId: value.basedOnEventId,
    throughLiveSeq: value.throughLiveSeq,
    streams,
  };
}

export function liveTextEventMetadata(
  data: unknown,
): LiveTextEventMetadata | null {
  if (!isRecord(data)) return null;
  if (
    typeof data.streamIdentity !== 'string'
    || data.streamIdentity.length === 0
    || !isPositiveSafeInteger(data.liveSeq)
    || (data.liveTextMode !== 'replace' && data.liveTextMode !== 'append')
  ) {
    return null;
  }
  return {
    streamIdentity: data.streamIdentity,
    liveSeq: data.liveSeq,
    liveTextMode: data.liveTextMode,
  };
}

export function snapshotStreamingEvents(
  snapshot: LiveTextSnapshotWire | null,
): SessionEvent[] {
  if (!snapshot) return [];
  return snapshot.streams.flatMap((stream) => {
    if (stream.resetRequired || stream.text === null || stream.text.length === 0) {
      return [];
    }
    return [{
      id: `live:text_snapshot:${stream.streamIdentity}`,
      type: 'text_delta' as const,
      data: {
        type: 'text_delta',
        text: stream.text,
        timestamp: stream.updatedAt,
        _live_only: true,
        _recovered_snapshot: true,
        streamIdentity: stream.streamIdentity,
        liveSeq: snapshot.throughLiveSeq,
        liveTextMode: 'replace',
      },
    }];
  });
}

export function resetRequiredStreamIdentities(
  snapshot: LiveTextSnapshotWire | null,
): Set<string> {
  return new Set(
    snapshot?.streams
      .filter((stream) => stream.resetRequired)
      .map((stream) => stream.streamIdentity) ?? [],
  );
}

export function snapshotStreamIdentities(
  snapshot: LiveTextSnapshotWire | null,
): string[] {
  return snapshot?.streams.map((stream) => stream.streamIdentity) ?? [];
}

export function isExplicitLiveTextFinal(type: string, data: unknown): boolean {
  return type === 'assistant_message' && isRecord(data)
    && data._final_for_live_stream === true;
}

function normalizeSnapshotStream(value: unknown): LiveTextSnapshotStream | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.streamIdentity !== 'string'
    || value.streamIdentity.length === 0
    || (typeof value.text !== 'string' && value.text !== null)
    || !isValidIsoDateTime(value.updatedAt)
    || (typeof value.text === 'string'
      && utf8Bytes(value.text) > LIVE_TEXT_SNAPSHOT_MAX_UTF8_BYTES)
    || typeof value.truncated !== 'boolean'
    || typeof value.resetRequired !== 'boolean'
    || (value.recovery !== 'none' && value.recovery !== 'durable_final')
  ) {
    return null;
  }
  if (
    value.resetRequired
      ? value.text !== null || !value.truncated || value.recovery !== 'durable_final'
      : value.text === null || value.truncated || value.recovery !== 'none'
  ) {
    return null;
  }
  return {
    streamIdentity: value.streamIdentity,
    text: value.text,
    updatedAt: value.updatedAt,
    truncated: value.truncated,
    resetRequired: value.resetRequired,
    recovery: value.recovery,
  };
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const point = char.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > LIVE_TEXT_SNAPSHOT_MAX_UTF8_BYTES) return bytes;
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
