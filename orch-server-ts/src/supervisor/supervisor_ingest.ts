import type { NodeRegistryEvent } from "../node/registry.js";

export type SupervisorAppendInput = {
  readonly sourceNode: string;
  readonly sourceSessionId: string;
  readonly sourceEventId: number;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: Date | string | null;
};

export type SupervisorAppendResult = {
  readonly offset: number;
  readonly inserted: boolean;
  readonly contiguousUpto: number;
  readonly highestSeenEventId: number;
  readonly gapStart: number | null;
  readonly gapEnd: number | null;
};

export type SupervisorSourceCursor = {
  readonly sourceNode: string;
  readonly sourceSessionId: string;
  readonly contiguousUpto: number;
  readonly highestSeenEventId: number;
  readonly gapStart: number | null;
  readonly gapEnd: number | null;
  readonly updatedAt?: Date | string;
};

export type SupervisorSourceEvent = {
  readonly id: number;
  readonly eventType: string;
  readonly payload: unknown;
  readonly createdAt: Date | string | null;
};

export type SupervisorIngestRepository = {
  appendSupervisorEvent: (input: SupervisorAppendInput) => Promise<SupervisorAppendResult>;
  getSupervisorSourceCursor: (
    sourceNode: string,
    sourceSessionId: string,
  ) => Promise<SupervisorSourceCursor | null>;
  readEvents: (
    sessionId: string,
    afterId: number,
    limit: number,
  ) => Promise<readonly SupervisorSourceEvent[]>;
};

export type SupervisorIngestServiceOptions = {
  readonly repository: SupervisorIngestRepository;
  readonly replayBatchSize?: number;
  readonly onWarning?: (message: string, error?: unknown) => void;
};

const DEFAULT_REPLAY_BATCH_SIZE = 500;

export class SupervisorIngestService {
  private readonly replayBatchSize: number;
  private readonly warn: (message: string, error?: unknown) => void;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: SupervisorIngestServiceOptions) {
    this.replayBatchSize = positiveInteger(
      options.replayBatchSize ?? DEFAULT_REPLAY_BATCH_SIZE,
      "replayBatchSize",
    );
    this.warn = options.onWarning ?? ((message, error) => console.warn(message, error));
  }

  accept(events: readonly NodeRegistryEvent[]): void {
    if (this.closed || events.length === 0) return;
    const batch = [...events];
    this.queue = this.queue
      .then(() => this.handleEvents(batch))
      .catch((error: unknown) => {
        this.warn("Supervisor ingest batch failed", error);
      });
  }

  async flush(): Promise<void> {
    while (true) {
      const pending = this.queue;
      await pending;
      if (pending === this.queue) return;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  async appendEventEnvelope(
    sourceNode: string,
    envelope: Record<string, unknown>,
  ): Promise<SupervisorAppendResult | undefined> {
    const sourceSessionId = sessionIdFrom(envelope);
    if (sourceSessionId === undefined) return undefined;
    const event = eventPayload(envelope);
    const sourceEventId = eventIdFromEvent(event, envelope);
    if (sourceEventId === undefined) return undefined;

    const payload = { ...event };
    payload._event_id ??= sourceEventId;
    const eventType = eventTypeFrom(payload);
    addSummaryLookup(payload, eventType, sourceSessionId);
    return this.append({
      sourceNode,
      sourceSessionId,
      sourceEventId,
      eventType,
      payload,
      createdAt: createdAtFrom(payload),
    });
  }

  async appendNodeChange(
    event: NodeRegistryEvent,
  ): Promise<SupervisorAppendResult | undefined> {
    if (!event.type.startsWith("node_session_") || !("data" in event)) {
      return undefined;
    }
    const sourceSessionId = sessionIdFrom(event.data);
    const sourceEventId = eventIdFromSessionLike(event.data);
    if (sourceSessionId === undefined || sourceEventId === undefined) return undefined;
    const eventType = event.type.slice("node_session_".length);
    const payload = { ...event.data };
    payload.type ??= eventType;
    return this.append({
      sourceNode: event.nodeId,
      sourceSessionId,
      sourceEventId,
      eventType,
      payload,
      createdAt: null,
    });
  }

  async syncSessionsFromDump(
    sourceNode: string,
    sessions: readonly unknown[],
  ): Promise<void> {
    for (const value of sessions) {
      const session = recordValue(value);
      if (session === undefined) continue;
      const sourceSessionId = sessionIdFrom(session);
      const lastEventId = eventIdFromSessionLike(session);
      if (sourceSessionId === undefined || lastEventId === undefined) continue;
      try {
        const cursor = await this.options.repository.getSupervisorSourceCursor(
          sourceNode,
          sourceSessionId,
        );
        const afterId = cursor?.contiguousUpto ?? 0;
        if (lastEventId <= afterId) continue;
        await this.replaySessionEvents({ sourceNode, sourceSessionId, afterId });
      } catch (error) {
        this.warn(
          `Supervisor session replay failed for ${sourceNode}/${sourceSessionId}/${lastEventId}`,
          error,
        );
      }
    }
  }

  async replaySessionEvents(input: {
    readonly sourceNode: string;
    readonly sourceSessionId: string;
    readonly afterId: number;
  }): Promise<void> {
    let cursor = input.afterId;
    while (true) {
      const events = await this.options.repository.readEvents(
        input.sourceSessionId,
        cursor,
        this.replayBatchSize,
      );
      if (events.length === 0) return;
      const previousCursor = cursor;
      for (const event of events) {
        const sourceEventId = positiveInt(event.id);
        if (sourceEventId === undefined) continue;
        const payload = payloadFromSourceEvent(event);
        const eventType = eventTypeFrom(payload);
        addSummaryLookup(payload, eventType, input.sourceSessionId);
        await this.append({
          sourceNode: input.sourceNode,
          sourceSessionId: input.sourceSessionId,
          sourceEventId,
          eventType,
          payload,
          createdAt: event.createdAt,
        });
        cursor = sourceEventId;
      }
      if (events.length < this.replayBatchSize || cursor === previousCursor) return;
    }
  }

  private async handleEvents(events: readonly NodeRegistryEvent[]): Promise<void> {
    for (const event of events) {
      if (event.type === "node_session_event") {
        await this.appendEventEnvelope(event.nodeId, event.data);
      } else if (event.type === "node_session_sessions_update") {
        const sessions = Array.isArray(event.data.sessions) ? event.data.sessions : [];
        await this.syncSessionsFromDump(event.nodeId, sessions);
      } else {
        await this.appendNodeChange(event);
      }
    }
  }

  private async append(
    input: SupervisorAppendInput,
  ): Promise<SupervisorAppendResult | undefined> {
    try {
      return await this.options.repository.appendSupervisorEvent(input);
    } catch (error) {
      this.warn(
        `Supervisor event append failed for ${input.sourceNode}/${input.sourceSessionId}/${input.sourceEventId}`,
        error,
      );
      return undefined;
    }
  }
}

function sessionIdFrom(data: Record<string, unknown>): string | undefined {
  const nested = recordValue(data.session) ?? {};
  return optionalString(
    data.agentSessionId,
    data.agent_session_id,
    data.sessionId,
    data.session_id,
    nested.agentSessionId,
    nested.agent_session_id,
    nested.sessionId,
    nested.session_id,
  );
}

function eventPayload(envelope: Record<string, unknown>): Record<string, unknown> {
  return recordValue(envelope.event) ?? recordValue(envelope.payload) ?? {};
}

function eventIdFromEvent(
  event: Record<string, unknown>,
  envelope: Record<string, unknown>,
): number | undefined {
  return firstPositiveInt(event._event_id, event.event_id, event.eventId, event.id) ??
    eventIdFromSessionLike(envelope);
}

function eventIdFromSessionLike(data: Record<string, unknown>): number | undefined {
  const nested = recordValue(data.session) ?? {};
  return firstPositiveInt(
    data.last_event_id,
    data.lastEventId,
    data._event_id,
    data.event_id,
    nested.last_event_id,
    nested.lastEventId,
  );
}

function eventTypeFrom(event: Record<string, unknown>): string {
  return optionalString(event.type, event.event_type, event.eventType) ?? "event";
}

function createdAtFrom(event: Record<string, unknown>): Date | string | null {
  const createdAt = optionalString(event.created_at, event.createdAt);
  if (createdAt !== undefined) return createdAt;
  const timestamp = event.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp)
    ? new Date(timestamp * 1_000)
    : null;
}

function payloadFromSourceEvent(event: SupervisorSourceEvent): Record<string, unknown> {
  let payload: unknown = event.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return { payload, type: event.eventType, _event_id: event.id };
    }
  }
  const record = recordValue(payload);
  const result: Record<string, unknown> = record === undefined
    ? { payload }
    : { ...record };
  result.type ??= event.eventType || "event";
  result._event_id ??= event.id;
  return result;
}

function addSummaryLookup(
  payload: Record<string, unknown>,
  eventType: string,
  sessionId: string,
): void {
  if (eventType !== "session_ended" || payload.summary_lookup !== undefined) return;
  payload.summary_lookup = { tool: "get_session_summary", session_id: sessionId };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer: ${value}`);
  }
  return value;
}

function firstPositiveInt(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = positiveInt(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const normalized = value.trim();
  if (!/^[+-]?\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
