import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_DATA_READ_OPERATIONS,
  SessionDataHostClient,
  SessionDataHostError,
} from "../../src/control_plane/session_data_host_client.js";

const logger = pino({ level: "silent" });

describe("SessionDataHostClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the complete read operation inventory explicit", () => {
    expect(SESSION_DATA_READ_OPERATIONS).toEqual([
      "get",
      "list_summary",
      "list_running",
      "upstream_dump",
      "event_count",
      "event_read_page",
      "event_read_one",
      "event_raw_page",
      "event_search",
      "event_session_id_search",
      "history_search",
      "story_search_metadata",
      "turn_summary_count",
      "turn_summary_range",
      "digest_search",
      "story",
      "turn_excerpt",
      "resume_context",
      "generation_checkpoint_material",
    ]);
  });

  it("maps every public read method to the matching whitelisted operation", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const operation = String(input).split("/").at(-1);
      const result: Record<string, unknown> = {
        get: null,
        list_summary: { sessions: [], total: 0 },
        list_running: { sessions: [], total: 0 },
        upstream_dump: { sessions: [], total: 0 },
        event_count: 0,
        event_read_page: [],
        event_read_one: null,
        event_raw_page: [],
        event_search: [],
        event_session_id_search: [],
        history_search: { events: [], sessionIdEvents: [], digests: [] },
        story_search_metadata: [],
        turn_summary_count: { totalCount: 0, digestedCount: 0, undigestedCount: 0 },
        turn_summary_range: [],
        digest_search: [],
        story: {
          highlight: null,
          narrative: null,
          unfoldedTurnSummaries: [],
          narrativeThroughEventId: null,
          foldCount: 0,
          updatedAt: null,
        },
        turn_excerpt: { totalEvents: 0, turns: [] },
        resume_context: {
          session: null,
          folderSessions: { sessions: [], total: 0 },
          runningSessions: { sessions: [], total: 0 },
          predecessor: null,
        },
        generation_checkpoint_material: {
          story: {
            highlight: null,
            narrative: null,
            unfoldedTurnSummaries: [],
            narrativeThroughEventId: null,
            foldCount: 0,
            updatedAt: null,
          },
          lastSummarizedFinalResponseEventId: null,
          recent: { records: [], omittedUnsummarized: 0 },
          childSessions: [],
          childSessionTotal: 0,
          totals: { events: 0, turnSummaries: 0 },
        },
      };
      return new Response(JSON.stringify(result[operation ?? ""]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SessionDataHostClient({
      orch: { baseUrl: "http://orchestrator.test", headers: {} },
      logger,
    });
    const calls = [
      () => client.getSession("s1"),
      () => client.listSessionsSummary({ limit: 1, offset: 0 }),
      () => client.listRunningSessionsSummary({ limit: 1 }),
      () => client.listSessionsForUpstreamDump({ limit: 1, offset: 0, nodeId: "n1" }),
      () => client.countEvents("s1"),
      () => client.readEvents("s1", 0, 1),
      () => client.readOneEvent("s1", 1),
      () => client.streamEventsRaw("s1"),
      () => client.searchEvents("q", null, 1),
      () => client.searchEventsBySessionId("s", null, 1),
      () => client.searchSessionHistory({
        query: "q",
        sessionIds: null,
        limit: 1,
        eventTypes: null,
        searchSessionId: true,
        includeHighlight: true,
        includeStory: true,
      }),
      () => client.getSessionSearchMetadata(["s1"]),
      () => client.countTurnSummaries("s1"),
      () => client.loadTurnSummaryRange("s1", 1, null, 1),
      () => client.searchSessionDigests("q", null, 1, true, true),
      () => client.getSessionStory("s1"),
      () => client.getTurnExcerpt("s1"),
      () => client.getResumeContext("s1", 15),
      () => client.getGenerationCheckpointMaterial("s1", { recentEventLimit: 20, unsummarizedEventLimit: 200 }),
    ];

    for (const call of calls) await call();

    expect(fetchMock.mock.calls.map(([url]) => String(url).split("/").at(-1)))
      .toEqual(SESSION_DATA_READ_OPERATIONS);
  });

  it("keeps period values inside the existing JSON host operations", async () => {
    const requests: Array<{ url: string; args: unknown[] }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as { args: unknown[] };
      requests.push({ url, args: body.args });
      const operation = url.split("/").at(-1);
      const value = operation === "list_summary"
        ? { sessions: [], total: 0 }
        : operation === "turn_summary_count"
          ? { totalCount: 0, digestedCount: 0, undigestedCount: 0 }
          : [];
      return new Response(JSON.stringify(value), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SessionDataHostClient({
      orch: { baseUrl: "http://orchestrator.test", headers: {} },
      logger,
    });
    const period = {
      since: "2026-10-06T00:00:00.000Z",
      until: "2026-10-07T00:00:00.000Z",
    };

    await client.listSessionsSummary({ limit: 10, offset: 0, period });
    await client.readEvents("s1", 0, 10, undefined, period);
    await client.countTurnSummaries("s1", period);
    await client.loadTurnSummaryRange("s1", 1, null, 10, period);
    await client.listSessionsSummary({ limit: 10, offset: 0 });
    await client.readEvents("s1", 0, 10);
    await client.countTurnSummaries("s1");
    await client.loadTurnSummaryRange("s1", 1, null, 10);

    expect(requests).toEqual([
      {
        url: "http://orchestrator.test/api/session-data/host/list_summary",
        args: [{ limit: 10, offset: 0, period }],
      },
      {
        url: "http://orchestrator.test/api/session-data/host/event_read_page",
        args: ["s1", 0, 10, null, period],
      },
      {
        url: "http://orchestrator.test/api/session-data/host/turn_summary_count",
        args: ["s1", { period }],
      },
      {
        url: "http://orchestrator.test/api/session-data/host/turn_summary_range",
        args: ["s1", 1, null, 10, { period }],
      },
      {
        url: "http://orchestrator.test/api/session-data/host/list_summary",
        args: [{ limit: 10, offset: 0 }],
      },
      {
        url: "http://orchestrator.test/api/session-data/host/event_read_page",
        args: ["s1", 0, 10, null],
      },
      {
        url: "http://orchestrator.test/api/session-data/host/turn_summary_count",
        args: ["s1"],
      },
      {
        url: "http://orchestrator.test/api/session-data/host/turn_summary_range",
        args: ["s1", 1, null, 10],
      },
    ]);
  });

  it("uses one host request for the complete resume context", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: null,
      folderSessions: { sessions: [], total: 0 },
      runningSessions: { sessions: [], total: 0 },
      predecessor: null,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SessionDataHostClient({
      orch: { baseUrl: "http://orchestrator.test", headers: {} },
      logger,
    });

    const result = await client.getResumeContext("session-a", 20);

    expect(result.session).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://orchestrator.test/api/session-data/host/resume_context");
    expect(JSON.parse(String(init.body))).toEqual({ args: ["session-a", 20] });
  });

  it("makes digest search an abortable single host request", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SessionDataHostClient({
      orch: { baseUrl: "http://orchestrator.test", headers: {} },
      logger,
    });
    const controller = new AbortController();
    const request = client.searchSessionDigests("needle", null, 10, true, true, controller.signal);
    controller.abort();

    await expect(request).rejects.toBeInstanceOf(SessionDataHostError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("makes event and digest history search one abortable host request", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SessionDataHostClient({
      orch: { baseUrl: "http://orchestrator.test", headers: {} },
      logger,
    });
    const controller = new AbortController();
    const request = client.searchSessionHistory({
      query: "needle",
      sessionIds: null,
      limit: 10,
      eventTypes: ["user_message"],
      searchSessionId: true,
      includeHighlight: true,
      includeStory: true,
    }, controller.signal);
    controller.abort();

    await expect(request).rejects.toBeInstanceOf(SessionDataHostError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://orchestrator.test/api/session-data/host/history_search");
  });

  it("marks exhausted turn-critical failures as explicit session-data errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("orch unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SessionDataHostClient({
      orch: { baseUrl: "http://orchestrator.test", headers: {} },
      logger,
    });

    await expect(client.getResumeContext("session-a", 20)).rejects.toBeInstanceOf(
      SessionDataHostError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  describe("persisted session metadata", () => {
    // `sessions.metadata` is persisted JSON. Task hydration and the metadata
    // extractors read its timestamps as the strings they were written as, so the
    // transport must revive row columns (`created_at`) but not what is inside it.
    const metadata = [
      {
        type: "persistent_generation",
        value: {
          number: 1,
          started_at: "2026-10-05T12:00:00.000Z",
          first_call: { generation: 1, measured_at: "2026-10-05T12:01:00.000Z" },
          pending: {
            number: 2,
            requested_at: "2026-10-05T13:51:56.916Z",
            applying_from: null,
          },
        },
      },
      { type: "persistent_session", value: { enabled: true, updated_at: "2026-10-05T12:19:50.569Z" } },
    ];
    const sessionRow = (sessionId: string) => ({
      session_id: sessionId,
      created_at: "2026-10-05T12:18:01.309+00:00",
      updated_at: "2026-10-05T14:22:24.2+00:00",
      metadata,
    });

    it("keeps metadata timestamps as strings while reviving the row's own dates", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(sessionRow("session-a")), { status: 200 })));
      const client = new SessionDataHostClient({
        orch: { baseUrl: "http://orchestrator.test", headers: {} },
        logger,
      });

      const row = await client.getSession("session-a");

      expect(row?.created_at).toBeInstanceOf(Date);
      expect(row?.updated_at).toBeInstanceOf(Date);
      expect(row?.metadata).toEqual(metadata);
    });

    it("keeps metadata timestamps as strings on every session row a resume context carries", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        session: sessionRow("session-a"),
        folderSessions: { sessions: [], total: 0 },
        runningSessions: { sessions: [], total: 0 },
        predecessor: { session: sessionRow("session-b"), story: null, excerpt: null },
      }), { status: 200 })));
      const client = new SessionDataHostClient({
        orch: { baseUrl: "http://orchestrator.test", headers: {} },
        logger,
      });

      const context = await client.getResumeContext("session-a", 20);

      expect(context.session?.metadata).toEqual(metadata);
      expect(context.predecessor?.session.metadata).toEqual(metadata);
      expect(context.session?.created_at).toBeInstanceOf(Date);
    });

    it("keeps metadata timestamps as strings on upstream dump rows", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        sessions: [sessionRow("session-a")],
        total: 1,
      }), { status: 200 })));
      const client = new SessionDataHostClient({
        orch: { baseUrl: "http://orchestrator.test", headers: {} },
        logger,
      });

      const dump = await client.listSessionsForUpstreamDump({ limit: 10, offset: 0, nodeId: "node-a" });

      expect(dump.sessions[0]?.metadata).toEqual(metadata);
    });
  });
});
