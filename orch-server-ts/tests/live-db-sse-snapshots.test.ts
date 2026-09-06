import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  createLiveDbCatalogRepository,
  type LivePostgresSql,
} from "../src/index.js";

describe("live DB SSE replay snapshots", () => {
  it("loads the durable session owner node used by command routing", async () => {
    const harness = createSqlHarness((text, values) => {
      if (text.includes("FROM sessions") && values[0] === "sess-owned") {
        return [{ node_id: "node-a" }];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.findSessionOwnerNodeId("sess-owned"),
    ).resolves.toBe("node-a");
    await expect(
      repository.findSessionOwnerNodeId("sess-missing"),
    ).resolves.toBeNull();
    expect(harness.normalizedCalls()).toEqual([
      "SELECT node_id FROM sessions WHERE session_id = ? LIMIT 1",
      "SELECT node_id FROM sessions WHERE session_id = ? LIMIT 1",
    ]);
  });

  it("reuses the durable review transition and returns the serialized DB row", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("session_acknowledge_review")) {
        return [{ outcome: "acknowledged" }];
      }
      if (text.includes("FROM session_get")) {
        return [{
          session_id: "sess-review",
          status: "completed",
          review_required: true,
          review_state: "acknowledged",
          created_at: new Date("2026-07-16T00:00:00.000Z"),
          updated_at: new Date("2026-07-16T00:01:00.000Z"),
        }];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.sessionReviewRepository.acknowledgeSessionReview("sess-review"),
    ).resolves.toMatchObject({
      outcome: "acknowledged",
      session: {
        agentSessionId: "sess-review",
        status: "completed",
        reviewRequired: true,
        reviewState: "acknowledged",
      },
    });
    expect(harness.normalizedCalls()).toEqual([
      "SELECT session_acknowledge_review(?, ?) AS outcome",
      "SELECT * FROM session_get(?) LIMIT 1",
    ]);
  });

  it("rejects an unknown durable review outcome before loading a session row", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("session_acknowledge_review")) {
        return [{ outcome: "corrupt" }];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.sessionReviewRepository.acknowledgeSessionReview("sess-review"),
    ).rejects.toThrow("Unexpected session_acknowledge_review outcome: corrupt");
    expect(harness.normalizedCalls()).toEqual([
      "SELECT session_acknowledge_review(?, ?) AS outcome",
    ]);
  });

  it("loads session snapshots from DB with Python session response wire keys", async () => {
    const registry = new InMemoryNodeRegistry();
    registry.registerNode({
      type: "node_register",
      node_id: "node-a",
      agents: [
        {
          id: "agent-a",
          name: "Agent A",
          backend: "codex",
          portrait_url: "/agent-a.png",
        },
      ],
    });
    const harness = createSqlHarness((text) => {
      if (text.includes("session_count")) return [{ count: 1 }];
      if (text.includes("session_get_all")) {
        return [
          {
            session_id: "sess-1",
            status: "running",
            prompt: "hello",
            created_at: new Date("2026-07-09T00:00:00.000Z"),
            updated_at: new Date("2026-07-09T00:01:00.000Z"),
            session_type: "codex",
            last_message: { text: "last" },
            client_id: "client-1",
            metadata: {
              caller_info: {
                source: "slack",
                display_name: "서소영",
                avatar_url: "/avatar.png",
              },
            },
            display_name: "Display",
            node_id: "node-a",
            folder_id: "folder-1",
            last_event_id: 7,
            last_read_event_id: 5,
            caller_session_id: "caller-1",
            agent_id: "agent-a",
          },
        ];
      }
      if (text.includes("FROM session_page_bindings")) {
        return [{
          session_id: "sess-1",
          page_state: "manual_repair",
          legacy_state: "pending",
        }];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({
      sql: harness.sql,
      registry,
    });

    await expect(repository.loadSessionSnapshot()).resolves.toEqual({
      sessions: [
        {
          agentSessionId: "sess-1",
          status: "running",
          reviewRequired: false,
          reviewState: "not_required",
          bindingWarnings: [
            {
              code: "PAGE_BINDING_MANUAL_REPAIR",
              message: "The session was created, but its page block could not be converted automatically. Manual repair is required.",
            },
            {
              code: "LEGACY_PROJECTION_PENDING",
              message: "The session was created. Its legacy folder projection is pending and will retry automatically.",
            },
          ],
          prompt: "hello",
          createdAt: "2026-07-09T00:00:00.000Z",
          updatedAt: "2026-07-09T00:01:00.000Z",
          sessionType: "codex",
          lastMessage: null,
          clientId: "client-1",
          displayName: "Display",
          nodeId: "node-a",
          folderId: "folder-1",
          lastEventId: 7,
          lastReadEventId: 5,
          callerSessionId: "caller-1",
          predecessorSessionId: null,
          agentId: "agent-a",
          modelPreset: null,
          reasoningEffort: null,
          modelLabel: null,
          model: null,
          agentName: "Agent A",
          agentPortraitUrl: "/api/nodes/node-a/agents/agent-a/portrait",
          backend: "codex",
          userName: "서소영",
          userPortraitUrl: "/avatar.png",
          terminationReason: null,
          terminationDetail: null,
          pendingAttentions: [],
          attentionRevision: 0,
          recentNotices: [],
          notificationWatermark: 0,
          noticesTruncated: false,
        },
      ],
      total: 1,
    });
    expect(harness.normalizedCalls()).toEqual([
      "SELECT session_count(?::jsonb) AS count",
      "SELECT * FROM session_get_all(?::jsonb, ?, ?)",
      "SELECT session_id, page_state, legacy_state FROM session_page_bindings WHERE session_id = ANY(?::text[])",
      "SELECT session_id, attention_revision, notification_watermark, notification_count FROM session_feed_state WHERE session_id = ANY(?::text[])",
      "SELECT session_id, projection FROM session_pending_attentions WHERE session_id = ANY(?::text[]) ORDER BY session_id, source_event_id ASC, attention_id ASC",
      "WITH ranked AS ( SELECT session_id, projection, ROW_NUMBER() OVER ( PARTITION BY session_id ORDER BY source_event_id DESC ) AS row_number FROM session_feed_notices WHERE session_id = ANY(?::text[]) ) SELECT session_id, projection FROM ranked WHERE row_number <= ? ORDER BY session_id, row_number ASC",
      "SELECT id, parent_folder_id, settings FROM folders",
    ]);
  });

  it("loads restricted feed-only session snapshots from the first allowed folder", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("FROM folders")) {
        return [
          { id: "root", parent_folder_id: null },
          { id: "child", parent_folder_id: "root" },
        ];
      }
      if (text.includes("session_count")) return [{ count: 0 }];
      if (text.includes("session_get_all")) return [];
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.loadSessionSnapshot({
        access: { restricted: true, allowedFolderIds: ["root"] },
        feedOnly: true,
      }),
    ).resolves.toEqual({ sessions: [], total: 0 });

    const filterValues = harness.calls
      .filter((call) => call.text.includes("session_"))
      .map((call) => (call.values[0] as { jsonValue: unknown }).jsonValue);
    expect(filterValues).toEqual([
      { folder_id: "root", feed_only: true },
      { folder_id: "root", feed_only: true },
    ]);
  });

  it("hydrates a quiet folder watermark without exposing historical notices", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("session_count")) return [{ count: 1 }];
      if (text.includes("session_get_all")) {
        return [{
          session_id: "quiet-session",
          folder_id: "quiet-folder",
          status: "idle",
          created_at: new Date("2026-09-06T12:00:00.000Z"),
          updated_at: new Date("2026-09-06T12:00:00.000Z"),
        }];
      }
      if (text.includes("FROM session_feed_state")) {
        return [{
          session_id: "quiet-session",
          attention_revision: 0,
          notification_watermark: 9,
          notification_count: 1,
        }];
      }
      if (text.includes("FROM session_feed_notices")) {
        return [{
          session_id: "quiet-session",
          projection: {
            id: "quiet-session:9",
            sourceEventId: 9,
            sessionId: "quiet-session",
            kind: "error",
            title: "세션 오류",
            body: "hidden",
            createdAt: "2026-09-06T12:00:00.000Z",
          },
        }];
      }
      if (text.includes("FROM folders")) {
        return [{
          id: "quiet-folder",
          parent_folder_id: null,
          settings: { excludeFromNotification: true },
        }];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    const snapshot = await repository.loadSessionSnapshot();

    expect(snapshot.sessions[0]).toMatchObject({
      agentSessionId: "quiet-session",
      recentNotices: [],
      notificationWatermark: 9,
      noticesTruncated: true,
    });
  });

  it("returns an empty restricted session snapshot when no allowed folder exists", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("FROM folders")) return [{ id: "root", parent_folder_id: null }];
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.loadSessionSnapshot({
        access: { restricted: true, allowedFolderIds: ["missing"] },
      }),
    ).resolves.toEqual({ sessions: [], total: 0 });
    expect(harness.normalizedCalls()).toEqual([
      "SELECT id, parent_folder_id, settings FROM folders",
    ]);
  });

  it("passes metadata search, node, and status filters to both durable queries", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("session_count")) return [{ count: 0 }];
      if (text.includes("session_get_all")) return [];
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(repository.listSessionSnapshots({
      search: "Alpha",
      nodeId: "node-a",
      statuses: ["running", "waiting"],
      offset: 0,
      limit: 20,
    })).resolves.toMatchObject({
      sessions: [],
      total: 0,
    });

    const filterValues = harness.calls
      .filter((call) => call.text.includes("session_"))
      .map((call) => (call.values[0] as { jsonValue: unknown }).jsonValue);
    expect(filterValues).toEqual([
      {
        node_id: "node-a",
        search: "Alpha",
        status: ["running", "waiting"],
      },
      {
        node_id: "node-a",
        search: "Alpha",
        status: ["running", "waiting"],
      },
    ]);
  });

  it("omits inaccessible rows from a targeted session summary batch without failing visible refs", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("FROM sessions s") && text.includes("s.session_id = ANY")) {
        return [
          {
            session_id: "visible-session",
            status: "running",
            folder_id: "child",
            session_type: "claude",
            created_at: new Date("2026-07-13T00:00:00.000Z"),
            updated_at: new Date("2026-07-13T00:01:00.000Z"),
          },
          {
            session_id: "hidden-session",
            status: "running",
            folder_id: "hidden",
            session_type: "claude",
            created_at: new Date("2026-07-13T00:00:00.000Z"),
            updated_at: new Date("2026-07-13T00:01:00.000Z"),
          },
        ];
      }
      if (text.includes("FROM folders")) {
        return [
          { id: "root", parent_folder_id: null },
          { id: "child", parent_folder_id: "root" },
          { id: "hidden", parent_folder_id: null },
        ];
      }
      if (text.includes("FROM session_page_bindings")) return [];
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(repository.listSessionSnapshots({
      access: { restricted: true, allowedFolderIds: ["root"] },
      sessionIds: ["visible-session", "hidden-session", "missing-session"],
      offset: 0,
      limit: 0,
    })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ agentSessionId: "visible-session" })],
      total: 1,
      hasMore: false,
    });
  });

});

function createSqlHarness(
  rowsFor: (text: string, values: unknown[]) => readonly Record<string, unknown>[] = () => [],
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return rowsFor(text, values);
  });
  const sql = Object.assign(query, {
    json: vi.fn((value: unknown) => ({ jsonValue: value })),
  }) as unknown as LivePostgresSql;

  return {
    sql,
    calls,
    normalizedCalls: () =>
      calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
  };
}
