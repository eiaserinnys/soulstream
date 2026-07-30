import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  createOrchestratorRuntimeComposition,
  filterFinalizedAppServerReplayEvents,
  loadContractFixtures,
  parseOrchServerConfig,
  sessionHistoryRouteAuthRequirements,
  SessionResourceAccessError,
  shouldEmitSessionHistoryEvent,
  type SessionHistoryProvider,
  type SessionHistoryLiveEventSource,
  type SessionHistoryRawEvent,
  type SessionResourceAccessProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("session history/read-only route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps single-session read-only routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const url of [
      "/api/sessions/sess-1/events/viewport?y_min=1&y_max=10",
      "/api/sessions/sess-1/messages",
      "/api/sessions/sess-1/timeline",
      "/api/sessions/sess-1/timeline/tool%3A1/trace",
      "/api/sessions/sess-1/story",
      "/api/sessions/sess-1/turn-summaries?mode=count",
      "/api/sessions/sess-1/events",
    ]) {
      expect(await app.inject({ method: "GET", url })).toMatchObject({
        statusCode: 404,
      });
    }

    await app.close();
  });

  it("wires runtime composition history routes only when an explicit provider is supplied", async () => {
    const withoutProvider = createOrchestratorRuntimeComposition({
      config,
      boardYjsHostHttpClient: vi.fn(),
      sseReplayOnlyForTests: true,
    });
    const withProvider = createOrchestratorRuntimeComposition({
      config,
      boardYjsHostHttpClient: vi.fn(),
      sseReplayOnlyForTests: true,
      sessionHistoryProvider: createProvider({
        readMessages: vi.fn(async () => page([{ id: 1 }], null)),
      }),
      sessionHistoryCloseAfterHistorySync: true,
    });

    expect(
      await withoutProvider.app.inject({
        method: "GET",
        url: "/api/sessions/sess-1/messages",
      }),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await withProvider.app.inject({
        method: "GET",
        url: "/api/sessions/sess-1/messages",
      }),
    ).toMatchObject({
      statusCode: 200,
      body: '{"messages":[{"id":1}],"next_cursor":null}',
    });

    await withoutProvider.app.close();
    await withProvider.app.close();
  });

  it("registers the Python auth contract and preserves viewport before events order", async () => {
    const { app } = createHarness();

    expect(sessionHistoryRouteAuthRequirements).toEqual({
      "GET /api/sessions/:session_id/events/viewport": true,
      "GET /api/sessions/:session_id/messages": true,
      "GET /api/sessions/:session_id/timeline": true,
      "GET /api/sessions/:session_id/timeline/:timeline_id/trace": true,
      "GET /api/sessions/:session_id/story": true,
      "GET /api/sessions/:session_id/turn-summaries": true,
      "GET /api/sessions/:session_id/events": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) =>
        [
          "get_session_viewport",
          "get_session_messages",
          "get_session_timeline",
          "get_session_timeline_trace",
          "session_events",
        ].includes(route.name),
      )
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);
    expect(routeRows).toEqual([
      [8, "GET", "/api/sessions/{session_id}/events/viewport", true],
      [9, "GET", "/api/sessions/{session_id}/messages", true],
      [10, "GET", "/api/sessions/{session_id}/timeline", true],
      [11, "GET", "/api/sessions/{session_id}/timeline/{timeline_id}/trace", true],
      [12, "GET", "/api/sessions/{session_id}/events", true],
    ]);

    await app.close();
  });

  it("routes events viewport to readViewport instead of the generic events SSE route", async () => {
    const provider = createProvider({
      readViewport: vi.fn(async () => [
        {
          id: 1,
          parent_event_id: null,
          event_type: "user_message",
          depth: 0,
          y_start: 1,
          y_end: 5,
          payload: {},
        },
      ]),
    });
    const { app } = createHarness(provider);

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/events/viewport?y_min=1&y_max=50",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: 1,
        parent_event_id: null,
        event_type: "user_message",
        depth: 0,
        y_start: 1,
        y_end: 5,
        payload: {},
      },
    ]);
    expect(provider.readViewport).toHaveBeenCalledWith("sess-1", 1, 50);
    expect(provider.readLastEventId).not.toHaveBeenCalled();
    expect(provider.streamEventsRaw).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns the exact get_session_story response contract", async () => {
    const story = {
      highlight: "핵심 결정과 현재 상태입니다.",
      narrative: "[T1-T4] 첫 번째 줄거리입니다.",
      unfolded_turn_summaries: [{
        event_id: 45,
        turn_number: 5,
        content: "최근 턴 요약",
        turn_start_event_id: 40,
        final_response_event_id: 44,
        created_at: "2026-07-30T17:00:00.000Z",
      }],
      narrative_through_event_id: 39,
      fold_count: 2,
      updated_at: "2026-07-30T16:59:00.000Z",
    };
    const provider = createProvider({
      readStory: vi.fn(async () => story),
    });
    const { app } = createHarness(provider);

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess%2F1/story",
    });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json())).toEqual([
      "highlight",
      "narrative",
      "unfolded_turn_summaries",
      "narrative_through_event_id",
      "fold_count",
      "updated_at",
    ]);
    expect(response.json()).toEqual(story);
    expect(provider.readStory).toHaveBeenCalledWith("sess/1");

    await app.close();
  });

  it("mirrors the turn summary count, index, and range contract", async () => {
    const readTurnSummaries = vi.fn(async (
      sessionId: string,
      query: Parameters<SessionHistoryProvider["readTurnSummaries"]>[1],
    ) => {
      if (query.mode === "count") {
        return {
          session_id: sessionId,
          mode: "count" as const,
          total_count: 4,
          digested_count: 3,
          undigested_count: 1,
        };
      }
      if (query.mode === "index") {
        return {
          session_id: sessionId,
          mode: "index" as const,
          turn_number: query.turnNumber,
          summary: null,
        };
      }
      return {
        session_id: sessionId,
        mode: "range" as const,
        from_turn_number: query.fromTurnNumber,
        to_turn_number: query.toTurnNumber,
        limit: query.limit,
        summaries: [],
        has_more: false,
        next_from_turn_number: null,
      };
    });
    const { app } = createHarness(createProvider({ readTurnSummaries }));

    const count = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/turn-summaries?mode=count",
    });
    const index = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/turn-summaries?mode=index&turn_number=9",
    });
    const range = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/turn-summaries?mode=range&from_turn_number=2&limit=100",
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/turn-summaries?mode=range&from_turn_number=4&to_turn_number=3",
    });

    expect(count.json()).toEqual({
      session_id: "sess-1",
      mode: "count",
      total_count: 4,
      digested_count: 3,
      undigested_count: 1,
    });
    expect(index.json()).toEqual({
      session_id: "sess-1",
      mode: "index",
      turn_number: 9,
      summary: null,
    });
    expect(range.json()).toEqual({
      session_id: "sess-1",
      mode: "range",
      from_turn_number: 2,
      to_turn_number: null,
      limit: 100,
      summaries: [],
      has_more: false,
      next_from_turn_number: null,
    });
    expect(invalid.statusCode).toBe(400);
    expect(readTurnSummaries).toHaveBeenCalledTimes(3);

    await app.close();
  });

  it("validates required positive viewport bounds before calling the provider", async () => {
    const provider = createProvider();
    const { app } = createHarness(provider);

    const missing = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/events/viewport?y_min=1",
    });
    const zero = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/events/viewport?y_min=0&y_max=50",
    });

    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: "INVALID_QUERY" } });
    expect(zero.statusCode).toBe(400);
    expect(zero.json()).toMatchObject({ error: { code: "INVALID_QUERY" } });
    expect(provider.readViewport).not.toHaveBeenCalled();

    await app.close();
  });

  it("maps messages and timeline pages to Python-compatible next_cursor responses", async () => {
    const provider = createProvider({
      readMessages: vi.fn(async () => [
        [{ id: 10, event_type: "tool_start" }],
        "2026-05-02T11:00:00+00:00",
      ] as [unknown[], string | null]),
      readTimeline: vi.fn(async () => [
        [{ id: 11, event_type: "assistant_message" }],
        "2026-05-02T11:00:00+00:00,9",
      ] as [unknown[], string | null]),
    });
    const { app } = createHarness(provider);

    const messages = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/messages?before=cursor-1",
    });
    const timeline = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/timeline?limit=25&before=cursor-2",
    });

    expect(messages.statusCode).toBe(200);
    expect(messages.json()).toEqual({
      messages: [{ id: 10, event_type: "tool_start" }],
      next_cursor: "2026-05-02T11:00:00+00:00",
    });
    expect(provider.readMessages).toHaveBeenCalledWith("sess-1", "cursor-1", 50);

    expect(timeline.statusCode).toBe(200);
    expect(timeline.json()).toEqual({
      messages: [{ id: 11, event_type: "assistant_message" }],
      next_cursor: "2026-05-02T11:00:00+00:00,9",
    });
    expect(provider.readTimeline).toHaveBeenCalledWith("sess-1", "cursor-2", 25);

    await app.close();
  });

  it("rejects messages and timeline limits outside the 1..200 range", async () => {
    const provider = createProvider();
    const { app } = createHarness(provider);

    const tooSmall = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/messages?limit=0",
    });
    const tooLarge = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/timeline?limit=201",
    });

    expect(tooSmall.statusCode).toBe(400);
    expect(tooLarge.statusCode).toBe(400);
    expect(provider.readMessages).not.toHaveBeenCalled();
    expect(provider.readTimeline).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns the Python TRACE_NOT_FOUND envelope when timeline trace is missing", async () => {
    const provider = createProvider({
      readTimelineTrace: vi.fn(async () => null),
    });
    const { app } = createHarness(provider);

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/timeline/tool%3Amissing/trace",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "TRACE_NOT_FOUND",
        message: "trace를 찾을 수 없습니다: tool:missing",
        details: {},
      },
    });
    expect(provider.readTimelineTrace).toHaveBeenCalledWith("sess-1", "tool:missing");

    await app.close();
  });

  it("checks session access before every history read route", async () => {
    const provider = createProvider({
      readViewport: vi.fn(async () => []),
      readMessages: vi.fn(async () => page([], null)),
      readTimeline: vi.fn(async () => page([], null)),
      readTimelineTrace: vi.fn(async () => ({ trace: [] })),
      readStory: vi.fn(async () => emptyStory()),
      readLastEventId: vi.fn(async () => 9),
    });
    const accessProvider: SessionResourceAccessProvider = {
      requireSessionAccess: vi.fn(async () => undefined),
      requireFolderAccess: vi.fn(async () => undefined),
      resolveAccess: vi.fn(async () => ({ restricted: false, allowedFolderIds: [] })),
    };
    const { app } = createHarness(provider, accessProvider);

    await app.inject({ method: "GET", url: "/api/sessions/sess-1/events/viewport?y_min=1&y_max=5" });
    await app.inject({ method: "GET", url: "/api/sessions/sess-1/messages" });
    await app.inject({ method: "GET", url: "/api/sessions/sess-1/timeline" });
    await app.inject({ method: "GET", url: "/api/sessions/sess-1/timeline/tool%3A1/trace" });
    await app.inject({ method: "GET", url: "/api/sessions/sess-1/story" });
    await app.inject({ method: "GET", url: "/api/sessions/sess-1/turn-summaries?mode=count" });
    await app.inject({ method: "GET", url: "/api/sessions/sess-1/events" });

    expect(accessProvider.requireSessionAccess).toHaveBeenCalledTimes(7);
    expect(accessProvider.requireSessionAccess).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1" }),
    );
    expect(provider.readViewport).toHaveBeenCalled();
    expect(provider.readMessages).toHaveBeenCalled();
    expect(provider.readTimeline).toHaveBeenCalled();
    expect(provider.readTimelineTrace).toHaveBeenCalled();
    expect(provider.readStory).toHaveBeenCalled();
    expect(provider.readTurnSummaries).toHaveBeenCalled();
    expect(provider.readLastEventId).toHaveBeenCalled();

    await app.close();
  });

  it("stops history providers when session access denies the request", async () => {
    const provider = createProvider();
    const accessProvider: SessionResourceAccessProvider = {
      requireSessionAccess: vi.fn(async () => {
        throw new SessionResourceAccessError(
          "SESSION_ACCESS_DENIED",
          "Folder access denied",
          403,
        );
      }),
      requireFolderAccess: vi.fn(async () => undefined),
      resolveAccess: vi.fn(async () => ({ restricted: true, allowedFolderIds: [] })),
    };
    const { app } = createHarness(provider, accessProvider);

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-denied/messages",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "SESSION_ACCESS_DENIED" },
    });
    expect(provider.readMessages).not.toHaveBeenCalled();

    await app.close();
  });

  it("sends init then history_sync and skips history replay when after_id is zero", async () => {
    const provider = createProvider({
      readLastEventId: vi.fn(async () => 42),
    });
    const { app } = createHarness(provider);

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/events",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toBe(
      'event: init\n' +
        'data: {"agentSessionId":"sess-1"}\n\n' +
        'event: history_sync\n' +
        'data: {"type":"history_sync","last_event_id":42,"is_live":false}\n\n',
    );
    expect(provider.readLastEventId).toHaveBeenCalledWith("sess-1");
    expect(provider.streamEventsRaw).not.toHaveBeenCalled();

    await app.close();
  });

  it("subscribes before the baseline read and flushes pending live events before history_sync", async () => {
    let liveListener: ((event: Record<string, unknown>) => void) | undefined;
    const unsubscribe = vi.fn();
    const liveEvents: SessionHistoryLiveEventSource = {
      subscribe: vi.fn((_sessionId, listener) => {
        liveListener = listener;
        return unsubscribe;
      }),
    };
    const provider = createProvider({
      readLastEventId: vi.fn(async () => {
        liveListener?.({
          type: "event",
          agentSessionId: "sess-1",
          event: {
            _event_id: 43,
            type: "assistant_message",
            content: "arrived during baseline",
          },
        });
        return 42;
      }),
    });
    const app = createApp({
      config,
      sessionHistoryRoutes: {
        provider,
        liveEvents,
        closeAfterHistorySync: true,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/events",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      'event: init\n' +
        'data: {"agentSessionId":"sess-1"}\n\n' +
        'event: assistant_message\n' +
        'id: 43\n' +
        'data: {"_event_id":43,"type":"assistant_message","content":"arrived during baseline"}\n\n' +
        'event: history_sync\n' +
        'data: {"type":"history_sync","last_event_id":42,"is_live":true}\n\n',
    );
    expect(liveEvents.subscribe).toHaveBeenCalledWith("sess-1", expect.any(Function));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("prefers Last-Event-ID header over query and replays only raw events after that id", async () => {
    const provider = createProvider({
      streamEventsRaw: vi.fn(async function* () {
        yield { eventId: 5, eventType: "text_delta", payloadText: '{"type":"text_delta"}' };
        yield {
          eventId: 6,
          eventType: "text_delta",
          payloadText: '{"type":"text_delta","text":"hi"}',
        };
        yield { eventId: 7, eventType: "text_end", payloadText: '{"type":"text_end"}' };
      }),
    });
    const { app } = createHarness(provider);

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/events?lastEventId=0",
      headers: { "Last-Event-ID": "5" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      'event: init\n' +
        'data: {"agentSessionId":"sess-1"}\n\n' +
        'event: text_delta\n' +
        'id: 6\n' +
        'data: {"type":"text_delta","text":"hi"}\n\n' +
        'event: text_end\n' +
        'id: 7\n' +
        'data: {"type":"text_end"}\n\n' +
        'event: history_sync\n' +
        'data: {"type":"history_sync","last_event_id":7,"is_live":false}\n\n',
    );
    expect(provider.streamEventsRaw).toHaveBeenCalledWith("sess-1", 5);
    expect(provider.readLastEventId).not.toHaveBeenCalled();

    await app.close();
  });

  it("keeps history_sync unchanged when the reconnect cursor has no newer stored events", async () => {
    const provider = createProvider();
    const { app } = createHarness(provider);

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/events?lastEventId=5",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      'event: history_sync\n' +
        'data: {"type":"history_sync","last_event_id":0,"is_live":false}\n\n',
    );
    expect(provider.streamEventsRaw).toHaveBeenCalledWith("sess-1", 5);

    await app.close();
  });

  it("uses one monotonic cursor to suppress replay and reconnect duplicates while allowing id-less events", () => {
    const cursor = { lastSeenEventId: 7 };

    expect(shouldEmitSessionHistoryEvent(cursor, 7)).toBe(false);
    expect(shouldEmitSessionHistoryEvent(cursor, 5)).toBe(false);
    expect(shouldEmitSessionHistoryEvent(cursor, 8)).toBe(true);
    expect(shouldEmitSessionHistoryEvent(cursor, undefined)).toBe(true);
    expect(cursor).toEqual({ lastSeenEventId: 8 });

    for (let eventId = 9; eventId < 10_000; eventId += 1) {
      expect(shouldEmitSessionHistoryEvent(cursor, eventId)).toBe(true);
    }
    expect(Object.keys(cursor)).toEqual(["lastSeenEventId"]);
  });

  it("treats an invalid cursor as after_id zero even when the query has a valid cursor", async () => {
    const provider = createProvider({
      readLastEventId: vi.fn(async () => 9),
    });
    const { app } = createHarness(provider);

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/events?lastEventId=5",
      headers: { "Last-Event-ID": "not-an-int" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      'event: history_sync\n' +
        'data: {"type":"history_sync","last_event_id":9,"is_live":false}\n\n',
    );
    expect(provider.readLastEventId).toHaveBeenCalledWith("sess-1");
    expect(provider.streamEventsRaw).not.toHaveBeenCalled();

    await app.close();
  });

  it("filters app-server live-only text fragments when the same replay window has the final message", () => {
    const events: SessionHistoryRawEvent[] = [
      {
        eventId: 6,
        eventType: "text_start",
        payloadText: JSON.stringify({
          type: "text_start",
          tool_use_id: "item-1",
          _live_only: true,
        }),
      },
      {
        eventId: 7,
        eventType: "text_delta",
        payloadText: JSON.stringify({
          type: "text_delta",
          tool_use_id: "item-2",
          text: "kept",
          _live_only: true,
        }),
      },
      {
        eventId: 8,
        eventType: "assistant_message",
        payloadText: JSON.stringify({
          type: "assistant_message",
          tool_use_id: "item-1",
          content: "final",
          _final_for_live_stream: true,
        }),
      },
      {
        eventId: 9,
        eventType: "text_end",
        payloadText: JSON.stringify({
          type: "text_end",
          tool_use_id: "item-1",
          _live_only: true,
        }),
      },
    ];

    expect(filterFinalizedAppServerReplayEvents(events)).toEqual([events[1], events[2]]);
  });

  it("tracks a session history stream as a foreground observer and releases it", async () => {
    const release = vi.fn();
    const foregroundObservers = { observe: vi.fn(() => release) };
    const app = createApp({
      config,
      sessionHistoryRoutes: {
        provider: createProvider(),
        closeAfterHistorySync: true,
        foregroundObservers,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-observed/events",
    });

    expect(response.statusCode).toBe(200);
    expect(foregroundObservers.observe).toHaveBeenCalledWith("sess-observed");
    expect(release).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

function createHarness(
  provider: SessionHistoryProvider = createProvider(),
  accessProvider?: SessionResourceAccessProvider,
) {
  const app = createApp({
    config,
    sessionHistoryRoutes: {
      provider,
      accessProvider,
      closeAfterHistorySync: true,
    },
  });
  return { app, provider };
}

function createProvider(
  overrides: Partial<SessionHistoryProvider> = {},
): SessionHistoryProvider {
  return {
    readViewport: vi.fn(async () => []),
    readMessages: vi.fn(async () => page([], null)),
    readTimeline: vi.fn(async () => page([], null)),
    readTimelineTrace: vi.fn(async () => null),
    readStory: vi.fn(async () => emptyStory()),
    readTurnSummaries: vi.fn(async (sessionId, query) => ({
      session_id: sessionId,
      mode: query.mode,
      ...(query.mode === "count"
        ? { total_count: 0, digested_count: 0, undigested_count: 0 }
        : query.mode === "index"
          ? { turn_number: query.turnNumber, summary: null }
          : {
              from_turn_number: query.fromTurnNumber,
              to_turn_number: query.toTurnNumber,
              limit: query.limit,
              summaries: [],
              has_more: false,
              next_from_turn_number: null,
            }),
    })),
    readLastEventId: vi.fn(async () => 0),
    streamEventsRaw: vi.fn(async function* () {}),
    ...overrides,
  };
}

function page(messages: unknown[], nextCursor: string | null): [unknown[], string | null] {
  return [messages, nextCursor];
}

function emptyStory() {
  return {
    highlight: null,
    narrative: null,
    unfolded_turn_summaries: [],
    narrative_through_event_id: null,
    fold_count: 0,
    updated_at: null,
  };
}
