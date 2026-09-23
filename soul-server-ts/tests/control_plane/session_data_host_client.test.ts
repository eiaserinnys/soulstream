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
    ];

    for (const call of calls) await call();

    expect(fetchMock.mock.calls.map(([url]) => String(url).split("/").at(-1)))
      .toEqual(SESSION_DATA_READ_OPERATIONS);
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
});
