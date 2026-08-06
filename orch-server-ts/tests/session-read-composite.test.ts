import { describe, expect, it, vi } from "vitest";

import { SessionReadCompositeRepository } from
  "../src/control_plane/repositories/session_read_composite.js";

describe("SessionReadCompositeRepository", () => {
  it("combines event count and page into one turn-excerpt operation", async () => {
    const countEvents = vi.fn().mockResolvedValue(3);
    const readEvents = vi.fn().mockResolvedValue([{
      id: 2,
      event_type: "assistant_message",
      payload: { text: "response" },
      created_at: new Date("2026-08-06T00:00:00.000Z"),
    }]);
    const repository = new SessionReadCompositeRepository(
      {} as never,
      { countEvents, readEvents } as never,
      {} as never,
    );

    await expect(repository.getTurnExcerpt("s1", 4)).resolves.toEqual({
      totalEvents: 3,
      turns: [{
        event_id: 2,
        event_type: "assistant_message",
        text: "resp…",
        created_at: "2026-08-06T00:00:00.000Z",
      }],
    });
    expect(readEvents).toHaveBeenCalledWith("s1", 0, 3, [
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
    const readEvents = vi.fn().mockResolvedValue([]);
    const repository = new SessionReadCompositeRepository(
      { getSession, listSessionsSummary, listRunningSessionsSummary } as never,
      { countEvents, readEvents } as never,
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
});
