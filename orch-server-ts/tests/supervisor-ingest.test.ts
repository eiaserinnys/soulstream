import { describe, expect, it, vi } from "vitest";

import {
  SupervisorIngestService,
  type SupervisorAppendInput,
  type SupervisorAppendResult,
  type SupervisorIngestRepository,
  type SupervisorSourceCursor,
  type SupervisorSourceEvent,
} from "../src/index.js";

describe("supervisor ingest service", () => {
  it("appends raw event envelopes and adds lazy session summary lookup", async () => {
    const repository = new FakeSupervisorRepository();
    const service = new SupervisorIngestService({ repository });

    const result = await service.appendEventEnvelope("node-a", {
      type: "event",
      agentSessionId: "session-a",
      event: {
        _event_id: 7,
        type: "session_ended",
        usage: { input_tokens: 11, output_tokens: 13 },
        timestamp: 1,
      },
    });

    expect(result).toMatchObject({
      inserted: true,
      contiguousUpto: 0,
      highestSeenEventId: 7,
      gapStart: 1,
      gapEnd: 6,
    });
    expect(repository.appendCalls).toEqual([{
      sourceNode: "node-a",
      sourceSessionId: "session-a",
      sourceEventId: 7,
      eventType: "session_ended",
      payload: {
        _event_id: 7,
        type: "session_ended",
        usage: { input_tokens: 11, output_tokens: 13 },
        timestamp: 1,
        summary_lookup: {
          tool: "get_session_summary",
          session_id: "session-a",
        },
      },
      createdAt: new Date(1_000),
    }]);
  });

  it("uses direct session change last_event_id as the idempotency key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T13:00:00.000Z"));
    const repository = new FakeSupervisorRepository();
    const service = new SupervisorIngestService({ repository });
    try {
      await service.appendNodeChange({
        type: "node_session_session_updated",
        nodeId: "node-a",
        data: {
          agentSessionId: "session-a",
          last_event_id: 12,
          status: "running",
        },
      });

      expect(repository.appendCalls[0]).toMatchObject({
        sourceNode: "node-a",
        sourceSessionId: "session-a",
        sourceEventId: 12,
        eventType: "session_updated",
        payload: { type: "session_updated", status: "running" },
        createdAt: new Date("2026-07-14T13:00:00.000Z"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches Python int parsing for string event ids", async () => {
    const repository = new FakeSupervisorRepository();
    const service = new SupervisorIngestService({ repository });

    await service.appendEventEnvelope("node-a", {
      agentSessionId: "session-a",
      event: { _event_id: "1.0", type: "text_delta" },
    });
    await service.appendEventEnvelope("node-a", {
      agentSessionId: "session-a",
      event: { _event_id: " 2 ", type: "text_delta" },
    });

    expect(repository.appendCalls.map((call) => call.sourceEventId)).toEqual([2]);
  });

  it("preserves duplicate, gap, and contiguous cursor meaning from the DB canonical function", async () => {
    const repository = new FakeSupervisorRepository();
    const service = new SupervisorIngestService({ repository });

    const one = await append(service, 1);
    const three = await append(service, 3);
    const duplicateThree = await append(service, 3);
    const two = await append(service, 2);

    expect(one).toMatchObject({ inserted: true, contiguousUpto: 1, gapStart: null });
    expect(three).toMatchObject({
      inserted: true,
      contiguousUpto: 1,
      highestSeenEventId: 3,
      gapStart: 2,
      gapEnd: 2,
    });
    expect(duplicateThree).toMatchObject({
      offset: three?.offset,
      inserted: false,
      contiguousUpto: 1,
      highestSeenEventId: 3,
      gapStart: 2,
      gapEnd: 2,
    });
    expect(two).toMatchObject({
      inserted: true,
      contiguousUpto: 3,
      highestSeenEventId: 3,
      gapStart: null,
      gapEnd: null,
    });
  });

  it("replays reconnect dumps from contiguous_upto and skips already covered sessions", async () => {
    const repository = new FakeSupervisorRepository();
    await repository.appendSupervisorEvent(eventInput(1));
    repository.readEvents = vi.fn(async (_sessionId, afterId) => {
      if (afterId === 1) {
        return [
          eventRow(2, "assistant_message", { content: "a" }),
          eventRow(3, "session_ended", { type: "session_ended" }),
        ];
      }
      return [];
    });
    const service = new SupervisorIngestService({ repository, replayBatchSize: 2 });

    await service.syncSessionsFromDump("node-a", [
      { agentSessionId: "session-a", last_event_id: 3 },
      { agentSessionId: "session-a", last_event_id: 1 },
    ]);

    expect(repository.readEvents).toHaveBeenNthCalledWith(1, "session-a", 1, 2);
    expect(repository.readEvents).toHaveBeenNthCalledWith(2, "session-a", 3, 2);
    expect(repository.appendCalls.at(-1)?.payload).toMatchObject({
      type: "session_ended",
      summary_lookup: {
        tool: "get_session_summary",
        session_id: "session-a",
      },
    });
  });

  it("routes all three node paths through one ordered queue and drains before close", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository = new FakeSupervisorRepository();
    const originalAppend = repository.appendSupervisorEvent.bind(repository);
    repository.appendSupervisorEvent = vi.fn(async (input) => {
      if (input.sourceEventId === 1) await blocked;
      return originalAppend(input);
    });
    repository.readEvents = vi.fn(async () => []);
    const service = new SupervisorIngestService({ repository });

    service.accept([{
      type: "node_session_event",
      nodeId: "node-a",
      data: { agentSessionId: "session-a", event: { _event_id: 1, type: "text_delta" } },
    }]);
    service.accept([{
      type: "node_session_session_updated",
      nodeId: "node-a",
      data: { agentSessionId: "session-a", last_event_id: 2, status: "running" },
    }, {
      type: "node_session_sessions_update",
      nodeId: "node-a",
      data: { type: "sessions_update", sessions: [{ agentSessionId: "session-a", last_event_id: 2 }] },
    }]);

    let closed = false;
    const closePromise = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release?.();
    await closePromise;

    expect(repository.appendCalls.map((call) => call.sourceEventId)).toEqual([1, 2]);
    expect(repository.getCursorCalls).toEqual([["node-a", "session-a"]]);
  });
});

async function append(
  service: SupervisorIngestService,
  eventId: number,
): Promise<SupervisorAppendResult | undefined> {
  return service.appendEventEnvelope("node-a", {
    agentSessionId: "session-a",
    event: { _event_id: eventId, type: "text_delta", text: String(eventId) },
  });
}

function eventInput(sourceEventId: number): SupervisorAppendInput {
  return {
    sourceNode: "node-a",
    sourceSessionId: "session-a",
    sourceEventId,
    eventType: "text_delta",
    payload: { type: "text_delta", _event_id: sourceEventId },
    createdAt: null,
  };
}

function eventRow(
  id: number,
  eventType: string,
  payload: unknown,
): SupervisorSourceEvent {
  return {
    id,
    eventType,
    payload,
    createdAt: new Date(`2026-07-10T00:00:0${id}Z`),
  };
}

class FakeSupervisorRepository implements SupervisorIngestRepository {
  readonly appendCalls: SupervisorAppendInput[] = [];
  readonly getCursorCalls: Array<[string, string]> = [];
  readEvents: SupervisorIngestRepository["readEvents"] = vi.fn(async () => []);
  private readonly rows = new Map<string, { offset: number; input: SupervisorAppendInput }>();
  private nextOffset = 1;

  async appendSupervisorEvent(input: SupervisorAppendInput): Promise<SupervisorAppendResult> {
    this.appendCalls.push(input);
    const key = this.key(input.sourceNode, input.sourceSessionId, input.sourceEventId);
    const existing = this.rows.get(key);
    const inserted = existing === undefined;
    if (inserted) {
      this.rows.set(key, { offset: this.nextOffset++, input });
    }
    const cursor = this.cursor(input.sourceNode, input.sourceSessionId);
    return {
      offset: (existing ?? this.rows.get(key))?.offset ?? 0,
      inserted,
      ...cursor,
    };
  }

  async getSupervisorSourceCursor(
    sourceNode: string,
    sourceSessionId: string,
  ): Promise<SupervisorSourceCursor | null> {
    this.getCursorCalls.push([sourceNode, sourceSessionId]);
    const cursor = this.cursor(sourceNode, sourceSessionId);
    return cursor.highestSeenEventId === 0 ? null : {
      sourceNode,
      sourceSessionId,
      ...cursor,
    };
  }

  private cursor(sourceNode: string, sourceSessionId: string) {
    const ids = [...this.rows.values()]
      .map(({ input }) => input)
      .filter((input) =>
        input.sourceNode === sourceNode && input.sourceSessionId === sourceSessionId
      )
      .map((input) => input.sourceEventId);
    const seen = new Set(ids);
    const highestSeenEventId = ids.length === 0 ? 0 : Math.max(...ids);
    let contiguousUpto = 0;
    while (seen.has(contiguousUpto + 1)) contiguousUpto += 1;
    const gapStart = contiguousUpto < highestSeenEventId ? contiguousUpto + 1 : null;
    let gapEnd = gapStart;
    if (gapStart !== null) {
      while (gapEnd !== null && gapEnd < highestSeenEventId && !seen.has(gapEnd + 1)) {
        gapEnd += 1;
      }
    }
    return { contiguousUpto, highestSeenEventId, gapStart, gapEnd };
  }

  private key(sourceNode: string, sourceSessionId: string, sourceEventId: number): string {
    return `${sourceNode}\u0000${sourceSessionId}\u0000${sourceEventId}`;
  }
}
