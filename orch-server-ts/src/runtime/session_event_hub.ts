import { createHash } from "node:crypto";

import type { NodeRegistryEvent } from "../node/registry.js";
import {
  LIVE_TEXT_SNAPSHOT_MAX_UTF8_BYTES,
  type LiveTextEventMetadata,
  type LiveTextSnapshotStream,
} from "../session/session_feed_contract.js";

export type RuntimeSessionEvent = {
  readonly nodeId: string;
  readonly data: Record<string, unknown>;
};

export type RuntimeSessionEventListener = (event: RuntimeSessionEvent) => void;

export type RuntimeLiveTextSnapshot = {
  readonly throughLiveSeq: number;
  readonly streams: readonly LiveTextSnapshotStream[];
};

type MutableLiveTextStream = {
  readonly streamIdentity: string;
  text: string | null;
  updatedAt: string;
  truncated: boolean;
};

type SessionLiveTextState = {
  retainedTextBytes: number;
  lastTouchedOrder: number;
  readonly streams: Map<string, MutableLiveTextStream>;
};

type SessionLiveSequence = {
  lastSeq: number;
  throughSeq: number;
  readonly resetStreams: Map<string, string>;
};

export const LIVE_TEXT_SNAPSHOT_MAX_STREAMS = 256;
export const LIVE_TEXT_SNAPSHOT_MAX_SESSIONS = 256;
const LIVE_TEXT_SEQUENCE_LEDGER_MAX_SESSIONS = 1_024;
const LIVE_TEXT_RESET_TOMBSTONE_MAX_STREAMS = LIVE_TEXT_SNAPSHOT_MAX_STREAMS;
const LIVE_TEXT_SEEN_SESSION_BYTES = 8 * 1_024;

export class RuntimeSessionEventHub {
  private readonly listenersBySession = new Map<
    string,
    Set<RuntimeSessionEventListener>
  >();
  private readonly liveTextBySession = new Map<string, SessionLiveTextState>();
  private readonly liveSequenceBySession = new Map<string, SessionLiveSequence>();
  private readonly listenerCountBySessionKey = new Map<string, number>();
  private readonly seenSessionBits = new Uint8Array(LIVE_TEXT_SEEN_SESSION_BYTES);
  private globalLiveEventCount = 0;

  subscribe(
    agentSessionId: string,
    listener: RuntimeSessionEventListener,
  ): () => void {
    const sessionKey = liveTextSessionKey(agentSessionId);
    let listeners = this.listenersBySession.get(agentSessionId);
    if (listeners === undefined) {
      listeners = new Set();
      this.listenersBySession.set(agentSessionId, listeners);
    }
    listeners.add(listener);
    this.listenerCountBySessionKey.set(
      sessionKey,
      (this.listenerCountBySessionKey.get(sessionKey) ?? 0) + 1,
    );
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners?.delete(listener);
      const listenerCount = (this.listenerCountBySessionKey.get(sessionKey) ?? 1) - 1;
      if (listenerCount <= 0) {
        this.listenerCountBySessionKey.delete(sessionKey);
      } else {
        this.listenerCountBySessionKey.set(sessionKey, listenerCount);
      }
      if (listeners?.size === 0) {
        this.listenersBySession.delete(agentSessionId);
      }
    };
  }

  dispatchNodeRegistryEvents(events: readonly NodeRegistryEvent[]): void {
    for (const event of events) {
      if (event.type !== "node_session_event") continue;
      this.publish({
        nodeId: event.nodeId,
        data: event.data,
      });
    }
  }

  publish(event: RuntimeSessionEvent): void {
    const agentSessionId = sessionIdFromEnvelope(event.data);
    if (agentSessionId === undefined) return;
    const decorated = this.captureLiveText(agentSessionId, event);
    const listeners = this.listenersBySession.get(agentSessionId);
    if (listeners === undefined) return;
    for (const listener of listeners) {
      listener(decorated);
    }
  }

  snapshotLiveText(agentSessionId: string): RuntimeLiveTextSnapshot {
    const sessionKey = liveTextSessionKey(agentSessionId);
    const state = this.liveTextBySession.get(sessionKey);
    const sequence = this.liveSequenceBySession.get(sessionKey);
    const resetStreams: LiveTextSnapshotStream[] = [...(
      sequence?.resetStreams.entries() ?? []
    )].map(([streamIdentity, updatedAt]) => ({
      streamIdentity,
      text: null,
      updatedAt,
      truncated: true,
      resetRequired: true,
      recovery: "durable_final",
    }));
    return {
      throughLiveSeq: sequence?.throughSeq ?? 0,
      streams: [
        ...resetStreams,
        ...[...(state?.streams.values() ?? [])].map((stream) => ({
          streamIdentity: stream.streamIdentity,
          text: stream.text,
          updatedAt: stream.updatedAt,
          truncated: stream.truncated,
          resetRequired: stream.truncated,
          recovery: stream.truncated ? "durable_final" as const : "none" as const,
        })),
      ],
    };
  }

  private captureLiveText(
    sessionId: string,
    event: RuntimeSessionEvent,
  ): RuntimeSessionEvent {
    const payload = eventPayload(event.data);
    if (payload === null) return event;
    const eventType = typeof payload.type === "string" ? payload.type : "";
    if (!isLiveTextEvent(eventType, payload)) return event;
    const stream = liveTextIdentity(payload);
    if (stream === null) return event;

    const sessionKey = liveTextSessionKey(sessionId);
    const mode = stream.source === "codex_app_server" ? "append" : "replace";
    const updatedAt = eventTimestamp(payload);

    if (eventType === "text_start") {
      const state = this.stateForNewStream(sessionKey, stream.id);
      const liveSeq = this.nextLiveSequence(sessionKey);
      if (state === null) {
        this.markSnapshotReset(sessionKey, liveSeq, stream.id, updatedAt);
        return withLiveTextMetadata(event, {
          streamIdentity: stream.id,
          liveSeq,
          liveTextMode: mode,
        });
      }
      const previous = state.streams.get(stream.id);
      state.retainedTextBytes -= textBytes(previous);
      state.streams.set(stream.id, {
        streamIdentity: stream.id,
        text: "",
        updatedAt,
        truncated: false,
      });
      state.lastTouchedOrder = this.globalLiveEventCount;
      this.markSnapshotCaptured(sessionKey, liveSeq, stream.id);
      return withLiveTextMetadata(event, {
        streamIdentity: stream.id,
        liveSeq,
        liveTextMode: mode,
      });
    } else if (eventType === "text_delta") {
      const state = this.stateForNewStream(sessionKey, stream.id);
      const liveSeq = this.nextLiveSequence(sessionKey);
      if (state === null) {
        this.markSnapshotReset(sessionKey, liveSeq, stream.id, updatedAt);
        return withLiveTextMetadata(event, {
          streamIdentity: stream.id,
          liveSeq,
          liveTextMode: mode,
        });
      }
      const missingAppendPrefix =
        mode === "append" && !state.streams.has(stream.id);
      const current = state.streams.get(stream.id) ?? {
        streamIdentity: stream.id,
        text: missingAppendPrefix ? null : "",
        updatedAt,
        truncated: missingAppendPrefix,
      };
      const delta = typeof payload.text === "string" ? payload.text : "";
      if (!current.truncated) {
        const next = mode === "append" ? `${current.text ?? ""}${delta}` : delta;
        const previousBytes = textBytes(current);
        const nextBytes = Buffer.byteLength(next, "utf8");
        const nextSnapshotBytes = state.retainedTextBytes - previousBytes + nextBytes;
        if (nextSnapshotBytes > LIVE_TEXT_SNAPSHOT_MAX_UTF8_BYTES) {
          current.text = null;
          current.truncated = true;
          state.retainedTextBytes -= previousBytes;
        } else {
          current.text = next;
          state.retainedTextBytes = nextSnapshotBytes;
        }
      }
      current.updatedAt = updatedAt;
      state.streams.set(stream.id, current);
      state.lastTouchedOrder = this.globalLiveEventCount;
      this.markSnapshotCaptured(sessionKey, liveSeq, stream.id);
      return withLiveTextMetadata(event, {
        streamIdentity: stream.id,
        liveSeq,
        liveTextMode: mode,
      });
    }

    const liveSeq = this.nextLiveSequence(sessionKey);
    this.deleteStream(sessionKey, stream.id);
    this.markSnapshotCaptured(sessionKey, liveSeq, stream.id);
    return withLiveTextMetadata(event, {
      streamIdentity: stream.id,
      liveSeq,
      liveTextMode: mode,
    });
  }

  private stateForNewStream(
    sessionKey: string,
    streamIdentity: string,
  ): SessionLiveTextState | null {
    const existing = this.liveTextBySession.get(sessionKey);
    if (existing?.streams.has(streamIdentity)) return existing;
    if (existing !== undefined) {
      if (existing.streams.size >= LIVE_TEXT_SNAPSHOT_MAX_STREAMS) return null;
      return existing;
    }
    if (
      this.liveTextBySession.size >= LIVE_TEXT_SNAPSHOT_MAX_SESSIONS &&
      !this.evictLeastRecentlyTouchedIdleSession()
    ) {
      return null;
    }
    const state: SessionLiveTextState = {
      retainedTextBytes: 0,
      lastTouchedOrder: this.globalLiveEventCount,
      streams: new Map(),
    };
    this.liveTextBySession.set(sessionKey, state);
    return state;
  }

  private evictLeastRecentlyTouchedIdleSession(): boolean {
    let oldest: { sessionKey: string; seq: number } | undefined;
    for (const [sessionKey, state] of this.liveTextBySession) {
      if (this.listenerCountBySessionKey.has(sessionKey)) continue;
      if (oldest === undefined || state.lastTouchedOrder < oldest.seq) {
        oldest = { sessionKey, seq: state.lastTouchedOrder };
      }
    }
    if (oldest === undefined) return false;
    this.retireSessionState(oldest.sessionKey);
    return true;
  }

  private retireSessionState(sessionKey: string): void {
    const state = this.liveTextBySession.get(sessionKey);
    if (state === undefined) return;
    const sequence = this.sequenceFor(sessionKey);
    sequence.resetStreams.clear();
    for (const stream of state.streams.values()) {
      sequence.resetStreams.set(stream.streamIdentity, stream.updatedAt);
    }
    this.liveTextBySession.delete(sessionKey);
    this.touchSequence(sessionKey, sequence);
  }

  private nextLiveSequence(sessionKey: string): number {
    this.globalLiveEventCount += 1;
    const sequence = this.sequenceFor(sessionKey);
    if (sequence.lastSeq === 0 && this.hasSeenSession(sessionKey)) {
      sequence.lastSeq = this.globalLiveEventCount - 1;
    }
    sequence.lastSeq += 1;
    this.markSeenSession(sessionKey);
    this.touchSequence(sessionKey, sequence);
    return sequence.lastSeq;
  }

  private markSnapshotCaptured(
    sessionKey: string,
    liveSeq: number,
    streamIdentity: string,
  ): void {
    const sequence = this.sequenceFor(sessionKey);
    sequence.throughSeq = liveSeq;
    sequence.resetStreams.delete(streamIdentity);
    this.touchSequence(sessionKey, sequence);
  }

  private markSnapshotReset(
    sessionKey: string,
    liveSeq: number,
    streamIdentity: string,
    updatedAt: string,
  ): void {
    const sequence = this.sequenceFor(sessionKey);
    sequence.throughSeq = liveSeq;
    sequence.resetStreams.delete(streamIdentity);
    sequence.resetStreams.set(streamIdentity, updatedAt);
    while (sequence.resetStreams.size > LIVE_TEXT_RESET_TOMBSTONE_MAX_STREAMS) {
      const oldest = sequence.resetStreams.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      sequence.resetStreams.delete(oldest);
    }
    this.touchSequence(sessionKey, sequence);
  }

  private sequenceFor(sessionKey: string): SessionLiveSequence {
    return this.liveSequenceBySession.get(sessionKey) ?? {
      lastSeq: 0,
      throughSeq: 0,
      resetStreams: new Map(),
    };
  }

  private touchSequence(sessionKey: string, sequence: SessionLiveSequence): void {
    this.liveSequenceBySession.delete(sessionKey);
    this.liveSequenceBySession.set(sessionKey, sequence);
    while (this.liveSequenceBySession.size > LIVE_TEXT_SEQUENCE_LEDGER_MAX_SESSIONS) {
      let deleted = false;
      for (const key of this.liveSequenceBySession.keys()) {
        if (
          this.liveTextBySession.has(key) ||
          this.listenerCountBySessionKey.has(key)
        ) {
          continue;
        }
        this.liveSequenceBySession.delete(key);
        deleted = true;
        break;
      }
      if (!deleted) break;
    }
  }

  private hasSeenSession(sessionKey: string): boolean {
    return seenSessionBitIndexes(sessionKey).every((index) =>
      (this.seenSessionBits[index >> 3]! & (1 << (index & 7))) !== 0
    );
  }

  private markSeenSession(sessionKey: string): void {
    for (const index of seenSessionBitIndexes(sessionKey)) {
      this.seenSessionBits[index >> 3] =
        this.seenSessionBits[index >> 3]! | (1 << (index & 7));
    }
  }

  private deleteStream(sessionKey: string, streamIdentity: string): void {
    const state = this.liveTextBySession.get(sessionKey);
    const stream = state?.streams.get(streamIdentity);
    if (state === undefined || stream === undefined) return;
    state.retainedTextBytes -= textBytes(stream);
    state.streams.delete(streamIdentity);
    if (state.streams.size === 0) this.liveTextBySession.delete(sessionKey);
  }
}

function textBytes(stream: MutableLiveTextStream | undefined): number {
  return stream?.text === null || stream?.text === undefined
    ? 0
    : Buffer.byteLength(stream.text, "utf8");
}

export function createRuntimeSessionEventHubSink(
  hub: RuntimeSessionEventHub,
): (events: NodeRegistryEvent[]) => void {
  return (events) => {
    hub.dispatchNodeRegistryEvents(events);
  };
}

function sessionIdFromEnvelope(
  envelope: Record<string, unknown>,
): string | undefined {
  for (const key of ["agentSessionId", "agent_session_id", "sessionId", "session_id"]) {
    const value = envelope[key];
    if (typeof value === "string" && value.length > 0) return value;
  }

  const event = envelope.event;
  if (isRecord(event)) {
    for (const key of [
      "agentSessionId",
      "agent_session_id",
      "sessionId",
      "session_id",
    ]) {
      const value = event[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

function eventPayload(envelope: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(envelope.event)) return envelope.event;
  if (isRecord(envelope.payload)) return envelope.payload;
  return isRecord(envelope) ? envelope : null;
}

function isLiveTextEvent(
  eventType: string,
  payload: Record<string, unknown>,
): boolean {
  return eventType === "text_start" || eventType === "text_delta" ||
    eventType === "text_end" ||
    (eventType === "assistant_message" && payload._final_for_live_stream === true);
}

function liveTextIdentity(
  payload: Record<string, unknown>,
): { id: string; source: "codex_sdk" | "codex_app_server" } | null {
  const itemId = nonEmptyString(
    payload.item_id ?? payload.itemId ?? payload.tool_use_id ?? payload.toolUseId,
  );
  if (itemId === null) return null;
  const rawType = nonEmptyString(payload.raw_event_type ?? payload.rawEventType) ?? "";
  const threadId = nonEmptyString(payload.thread_id ?? payload.threadId);
  const turnId = nonEmptyString(payload.turn_id ?? payload.turnId);
  const source = rawType.includes("/") || threadId !== null || turnId !== null
    ? "codex_app_server" as const
    : "codex_sdk" as const;
  const parts = source === "codex_app_server"
    ? [threadId ?? "", turnId ?? "", itemId]
    : [itemId];
  return {
    source,
    id: `${source}:${parts.map(base64Url).join(":")}`,
  };
}

function withLiveTextMetadata(
  event: RuntimeSessionEvent,
  metadata: LiveTextEventMetadata,
): RuntimeSessionEvent {
  if (isRecord(event.data.event)) {
    return {
      ...event,
      data: {
        ...event.data,
        event: { ...event.data.event, ...metadata },
      },
    };
  }
  if (isRecord(event.data.payload)) {
    return {
      ...event,
      data: {
        ...event.data,
        payload: { ...event.data.payload, ...metadata },
      },
    };
  }
  return { ...event, data: { ...event.data, ...metadata } };
}

function eventTimestamp(payload: Record<string, unknown>): string {
  const value = payload.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value >= 10_000_000_000 ? value : value * 1_000;
    const parsed = new Date(millis);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function liveTextSessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

function seenSessionBitIndexes(sessionKey: string): readonly [number, number] {
  const bitCount = LIVE_TEXT_SEEN_SESSION_BYTES * 8;
  return [
    Number.parseInt(sessionKey.slice(0, 8), 16) % bitCount,
    Number.parseInt(sessionKey.slice(8, 16), 16) % bitCount,
  ];
}

function base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
