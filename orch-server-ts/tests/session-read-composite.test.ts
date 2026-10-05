import { describe, expect, it, vi } from "vitest";

import { SessionReadCompositeRepository } from
  "../src/control_plane/repositories/session_read_composite.js";

describe("SessionReadCompositeRepository", () => {
  it("combines event count and page into one turn-excerpt operation", async () => {
    const countEvents = vi.fn().mockResolvedValue(3);
    const readRecentEvents = vi.fn().mockResolvedValue([
      {
        id: 1,
        event_type: "user_message",
        payload: { text: "older request" },
        created_at: new Date("2026-08-05T00:00:00.000Z"),
      },
      {
        id: 2,
        event_type: "assistant_message",
        payload: { text: "response" },
        created_at: new Date("2026-08-06T00:00:00.000Z"),
      },
    ]);
    const repository = new SessionReadCompositeRepository(
      {} as never,
      { countEvents, readRecentEvents } as never,
      {} as never,
    );

    await expect(repository.getTurnExcerpt("s1", 4)).resolves.toEqual({
      totalEvents: 3,
      turns: [{
        event_id: 2,
        event_type: "assistant_message",
        text: "res…",
        created_at: "2026-08-06T00:00:00.000Z",
      }],
    });
    expect(readRecentEvents).toHaveBeenCalledWith("s1", 3, [
      "user_message",
      "assistant_message",
      "user_text",
      "assistant_text",
    ]);
  });

  it("loads the complete turn-start session bundle through one logical operation", async () => {
    const getSession = vi.fn(async (id: string) => id === "current"
      ? { session_id: id, folder_id: "folder-a", predecessor_session_id: "previous" }
      : { session_id: id, folder_id: null, predecessor_session_id: null });
    const listSessionsSummary = vi.fn().mockResolvedValue({ sessions: [], total: 0 });
    const listRunningSessionsSummary = vi.fn().mockResolvedValue({ sessions: [], total: 0 });
    const getSessionStory = vi.fn().mockResolvedValue({
      highlight: null,
      narrative: null,
      unfoldedTurnSummaries: [],
      narrativeThroughEventId: null,
      foldCount: 0,
      updatedAt: null,
    });
    const countEvents = vi.fn().mockResolvedValue(0);
    const readRecentEvents = vi.fn().mockResolvedValue([]);
    const repository = new SessionReadCompositeRepository(
      { getSession, listSessionsSummary, listRunningSessionsSummary } as never,
      { countEvents, readRecentEvents } as never,
      { getSessionStory } as never,
    );

    const result = await repository.getResumeContext("current", 15);

    expect(result).toMatchObject({
      session: { session_id: "current" },
      folderSessions: { total: 0 },
      runningSessions: { total: 0 },
      predecessor: {
        session: { session_id: "previous" },
        excerpt: { totalEvents: 0, turns: [] },
      },
    });
    expect(listSessionsSummary).toHaveBeenCalledWith({
      limit: 15,
      offset: 0,
      folderId: "folder-a",
    });
    expect(listRunningSessionsSummary).toHaveBeenCalledWith({
      limit: 15,
      excludeSessionId: "current",
    });
  });

  it("reads all unsummarized text and the active child sessions when no summary exists", async () => {
    const story = {
      highlight: null,
      narrative: null,
      unfoldedTurnSummaries: [],
      narrativeThroughEventId: null,
      foldCount: 0,
      updatedAt: null,
    };
    const events = [
      { id: 1, session_id: "owner", event_type: "user_message", payload: { text: "요청" }, searchable_text: "요청", created_at: new Date("2026-10-01T00:00:00Z") },
      { id: 2, session_id: "owner", event_type: "assistant_message", payload: { text: "응답" }, searchable_text: "응답", created_at: new Date("2026-10-01T00:00:01Z") },
    ];
    const sessions = {
      listActiveChildSessionsSummary: vi.fn().mockResolvedValue({
        sessions: [{ session_id: "child-1", display_name: "작업", agent_id: "worker", model_preset: "codex-6-luna", status: "running", card_id: "card-1", created_at: new Date("2026-10-01T00:00:00Z") }],
        total: 1,
      }),
    };
    const eventReads = {
      countEvents: vi.fn().mockResolvedValue(2),
      readEvents: vi.fn().mockResolvedValue(events),
      readRecentEvents: vi.fn().mockResolvedValue(events),
      readRecentEventsBefore: vi.fn().mockResolvedValue([]),
      readOneEvent: vi.fn().mockResolvedValue(null),
    };
    const stories = {
      getSessionStory: vi.fn().mockResolvedValue(story),
      countTurnSummaries: vi.fn().mockResolvedValue({ totalCount: 0, digestedCount: 0, undigestedCount: 0 }),
    };
    const repository = new SessionReadCompositeRepository(
      sessions as never,
      eventReads as never,
      stories as never,
    );

    const material = await repository.getGenerationCheckpointMaterial("owner", { recentEventLimit: 200 });

    expect(material.lastSummarizedFinalResponseEventId).toBeNull();
    expect(material.recent.records.map((record) => record.event_id)).toEqual([1, 2]);
    expect(material.recent.omittedUnsummarized).toBe(0);
    expect(material.childSessions).toHaveLength(1);
    expect(material.childSessionTotal).toBe(1);
    expect(material.totals).toEqual({ events: 2, turnSummaries: 0 });
    expect(sessions.listActiveChildSessionsSummary).toHaveBeenCalledWith("owner");
  });

  it("uses the final response of the latest folded summary when summaries are caught up", async () => {
    const events = [
      { id: 2, session_id: "owner", event_type: "assistant_message", payload: { text: "최근 요약 전 대화" }, searchable_text: "", created_at: new Date("2026-10-01T00:00:00Z") },
      { id: 4, session_id: "owner", event_type: "user_message", payload: { text: "다음 요청" }, searchable_text: "", created_at: new Date("2026-10-01T00:00:01Z") },
    ];
    const sessions = { listActiveChildSessionsSummary: vi.fn().mockResolvedValue({ sessions: [], total: 0 }) };
    const eventReads = {
      countEvents: vi.fn().mockResolvedValue(4),
      readEvents: vi.fn().mockResolvedValue([events[1]]),
      readRecentEvents: vi.fn().mockResolvedValue(events),
      readRecentEventsBefore: vi.fn().mockResolvedValue([events[0]]),
      readOneEvent: vi.fn().mockResolvedValue({
        id: 3, session_id: "owner", event_type: "turn_summary",
        payload: { final_response_event_id: 3 }, searchable_text: "",
        created_at: new Date("2026-10-01T00:00:00Z"), parent_event_id: null,
      }),
    };
    const stories = {
      getSessionStory: vi.fn().mockResolvedValue({
        highlight: null, narrative: "접힌 줄거리", unfoldedTurnSummaries: [],
        narrativeThroughEventId: 3, foldCount: 1, updatedAt: null,
      }),
      countTurnSummaries: vi.fn().mockResolvedValue({ totalCount: 1, digestedCount: 1, undigestedCount: 0 }),
    };
    const repository = new SessionReadCompositeRepository(sessions as never, eventReads as never, stories as never);

    const material = await repository.getGenerationCheckpointMaterial("owner", { recentEventLimit: 200 });

    expect(material.lastSummarizedFinalResponseEventId).toBe(3);
    expect(material.recent.records.map((record) => record.event_id)).toContain(4);
    expect(material.recent.records.map((record) => record.event_id)).toContain(2);
    expect(material.totals.turnSummaries).toBe(1);
    expect(eventReads.readRecentEventsBefore).toHaveBeenCalledWith("owner", 3, 200, [
      "user_message", "intervention_sent", "session_notification", "assistant_message",
    ]);
  });

  it("uses the latest unfolded summary anchor and preserves every later text event", async () => {
    const recentEvents = [
      { id: 7, session_id: "owner", event_type: "assistant_message", payload: { text: "뒤따른 응답" }, searchable_text: "", created_at: new Date("2026-10-01T00:00:01Z") },
      { id: 8, session_id: "owner", event_type: "user_message", payload: { text: "후속 요청" }, searchable_text: "", created_at: new Date("2026-10-01T00:00:02Z") },
    ];
    const eventReads = {
      countEvents: vi.fn().mockResolvedValue(8),
      readEvents: vi.fn().mockResolvedValue(recentEvents),
      readRecentEvents: vi.fn().mockResolvedValue(recentEvents),
      readRecentEventsBefore: vi.fn().mockResolvedValue([]),
      readOneEvent: vi.fn(),
    };
    const sessions = { listActiveChildSessionsSummary: vi.fn().mockResolvedValue({ sessions: [], total: 0 }) };
    const stories = {
      getSessionStory: vi.fn().mockResolvedValue({
        highlight: null,
        narrative: "접힌 줄거리",
        unfoldedTurnSummaries: [{ eventId: 6, turnNumber: 2, content: "최근 미접힘 요약", turnStartEventId: 5, finalResponseEventId: 6, createdAt: new Date("2026-10-01T00:00:00Z") }],
        narrativeThroughEventId: 3,
        foldCount: 1,
        updatedAt: null,
      }),
      countTurnSummaries: vi.fn().mockResolvedValue({ totalCount: 2, digestedCount: 1, undigestedCount: 1 }),
    };
    const repository = new SessionReadCompositeRepository(sessions as never, eventReads as never, stories as never);

    const material = await repository.getGenerationCheckpointMaterial("owner", { recentEventLimit: 200 });

    expect(material.lastSummarizedFinalResponseEventId).toBe(6);
    expect(material.story.unfoldedTurnSummaries).toHaveLength(1);
    expect(material.recent.records).toMatchObject([
      { event_id: 7, text: "뒤따른 응답" },
      { event_id: 8, text: "후속 요청" },
    ]);
    expect(eventReads.readEvents).toHaveBeenCalledWith("owner", 6, 8, [
      "user_message", "intervention_sent", "session_notification", "assistant_message",
    ]);
  });
});
